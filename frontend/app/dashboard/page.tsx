"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useReadContract } from "wagmi";
import { Nav } from "../../components/Nav";
import { useMerchant } from "../../components/useMerchant";
import { Icon } from "../../components/Icons";
import { AppTour } from "../../components/AppTour";
import { ConnectionBanner } from "../../components/ConnectionBanner";
import { WalletSheet } from "../../components/WalletSheet";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, fmtUsdc } from "../../lib/contract";
import { fetchUsdcRate } from "../../lib/rates";
import { fetchHistory } from "../../lib/history";
import { loadCountry, fmtFiat } from "../../lib/countries";
import { useT } from "../../lib/i18n";

function timeAgo(iso) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
function isToday(iso) {
  const d = new Date(iso), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

export default function Dashboard() {
  const router = useRouter();
  const { t } = useT();
  const { ready, address } = useMerchant();
  const [country, setCountry] = useState(null);
  const [rate, setRate] = useState(null);
  const [rows, setRows] = useState([]);
  const [tourForce, setTourForce] = useState(false);
  const [toast, setToast] = useState("");       // settlement-ready banner
  const [walletOpen, setWalletOpen] = useState(false);

  useEffect(() => { setCountry(loadCountry()); }, []);

  // Registration is checked lazily: the dashboard opens for everyone, and we
  // route to /onboarding only when the merchant tries to accept a payment.
  const { data: isRegistered } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: INTEGRATOR_ABI,
    functionName: "registered",
    args: [address],
    query: { enabled: !!address },
  });

  function acceptPayment() {
    router.push(isRegistered ? "/qr" : "/onboarding");
  }

  const { data: balance } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: INTEGRATOR_ABI,
    functionName: "getMerchantBalance",
    args: [address],
    query: { enabled: !!address, refetchInterval: 20000 },
  });

  const { data: daily } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: INTEGRATOR_ABI,
    functionName: "getDailyTxInfo",
    args: [address],
    query: { enabled: !!address, refetchInterval: 20000 },
  });

  // Settlement buckets — each received sale is locked ~10 min before it's
  // withdrawable. We surface a LIVE countdown to the next unlock so the
  // merchant knows exactly when their money frees up (not just "settling").
  const { data: buckets } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: INTEGRATOR_ABI,
    functionName: "getMerchantBuckets",
    args: [address],
    query: { enabled: !!address, refetchInterval: 15000 },
  });
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!country) return;
    let on = true;
    fetchUsdcRate(country).then((r) => on && setRate(r)).catch(() => {});
    return () => { on = false; };
  }, [country]);

  useEffect(() => {
    if (!address) return;
    let on = true;
    const load = () => fetchHistory(address).then((h) => on && setRows(h)).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => { on = false; clearInterval(t); };
  }, [address]);

  const [pending, available, , isFrozen] = balance ?? [0n, 0n, 0n, false];
  const [used, limit] = daily ?? [0n, 4n];
  const availUsdc = Number(available) / 1e6;
  const fiatEquiv = rate && country ? availUsdc * rate.rate : null;

  // Settlement-ready notification: when the available balance JUMPS UP between
  // refetches, a locked bucket just cleared — tell the merchant their money is
  // ready to withdraw. (Skips the first read so we don't toast on page load.)
  const prevAvail = useRef(null);
  useEffect(() => {
    if (balance === undefined) return;
    const cur = available;
    if (prevAvail.current != null && cur > prevAvail.current) {
      const cleared = Number(cur - prevAvail.current) / 1e6;
      const fiat = rate && country ? fmtFiat(country, cleared * rate.rate) : `${cleared.toFixed(2)} USDC`;
      setToast(`${fiat} just cleared — ready to withdraw`);
      setTimeout(() => setToast(""), 6000);
    }
    prevAvail.current = cur;
  }, [available, balance, rate, country]);

  // Soonest still-locked bucket → seconds until it unlocks (for the countdown).
  const lockedBuckets = (buckets || []).filter(
    (b) => b.amount > 0n && Number(b.unlockTimestamp) > now
  );
  const nextUnlock = lockedBuckets.length
    ? Math.min(...lockedBuckets.map((b) => Number(b.unlockTimestamp)))
    : null;
  const secsLeft = nextUnlock != null ? nextUnlock - now : 0;
  const mmss = `${Math.floor(secsLeft / 60)}:${String(secsLeft % 60).padStart(2, "0")}`;

  // Today's earnings = only COMPLETED sales (status "settled"). A sale that's
  // still waiting for a payment partner (status "matching") hasn't been received
  // yet, so it must NOT count as earnings.
  const todayUsdc = rows
    .filter((t) => isToday(t.createdAt) && t.status === "settled")
    .reduce((a, t) => a + Number(t.amount) / 1e6, 0);
  const todayFiat = rate && country ? todayUsdc * rate.rate : null;
  const todayCount = rows.filter((t) => isToday(t.createdAt) && t.status === "settled").length;
  const recent = rows.slice(0, 3);

  // Stuck order: a sale still "Waiting" (no payment partner accepted) more than
  // 3 minutes after it was placed. We surface a Retry so the merchant can take
  // the payment again instead of staring at a dead QR.
  const stuck = rows.find(
    (t) => t.status === "matching" && (Date.now() - new Date(t.createdAt).getTime()) > 180_000
  );

  // Daily close ("Z-report") — what a shop owner screenshots at end of day for
  // their own books. Shares the day's totals via the native share sheet.
  function shareDailyClose() {
    const today = new Date().toLocaleDateString(country?.locale || undefined, {
      weekday: "short", day: "numeric", month: "short", year: "numeric",
    });
    const fiatLine = todayFiat != null ? `${fmtFiat(country, todayFiat)} ${country.code}` : "—";
    const text =
      `PayQR — Daily close\n${country?.name || ""} · ${today}\n\n` +
      `Sales: ${todayCount}\n` +
      `Received: ${fiatLine}\n` +
      `In USDC: ${todayUsdc.toFixed(2)} USDC`;
    if (navigator.share) navigator.share({ title: "PayQR daily close", text }).catch(() => {});
    else navigator.clipboard?.writeText(text);
  }

  if (!country) return <><Nav /><div className="screen"><p className="muted" style={{ textAlign: "center" }}>{t("common.loading")}</p></div></>;

  return (
    <>
      <Nav
        center={
          <button className="tour-pill" onClick={() => setTourForce(true)}>
            <Icon.Compass />
            <span>How it works</span>
          </button>
        }
      />
      <AppTour force={tourForce} onClose={() => setTourForce(false)} />
      <ConnectionBanner />
      {toast && (
        <div className="settle-toast" onClick={() => router.push("/withdraw")}>
          <span className="st-ico"><Icon.Check width="16" height="16" /></span>
          <span>{toast}</span>
          <span className="st-cta">Withdraw ›</span>
        </div>
      )}
      <div className="screen">
        {isFrozen && (
          <div className="frozen-banner">
            {t("dash.frozen")}
          </div>
        )}

        {/* Balance hero — p2p.me: white, big black amount, fiat below */}
        <div className="balance">
          <div className="balance-label">{t("dash.available")}</div>
          <div className="balance-amount">${(availUsdc || 0).toFixed(2)}</div>
          <div className="balance-sub">
            {fiatEquiv != null
              ? `≈ ${fmtFiat(country, fiatEquiv)}`
              : `≈ ${country.symbol}0.00`}
          </div>
        </div>

        {/* action tiles — Wallet · Accept · Withdraw · Activity (p2p.me layout) */}
        <div className="quick">
          <button className="quick-item" onClick={() => setWalletOpen(true)} style={{ background: "none", border: "none", cursor: "pointer" }}>
            <span className="quick-ico"><Icon.Wallet /></span>
            <span>{t("nav.wallet")}</span>
          </button>
          <button className="quick-item" onClick={acceptPayment} style={{ background: "none", border: "none", cursor: "pointer" }}>
            <span className="quick-ico"><Icon.Down /></span>
            <span>{t("nav.accept")}</span>
          </button>
          <Link className="quick-item" href="/withdraw">
            <span className="quick-ico"><Icon.Up /></span>
            <span>{t("nav.withdraw")}</span>
          </Link>
          <Link className="quick-item" href="/transactions">
            <span className="quick-ico"><Icon.Chart /></span>
            <span>{t("nav.activity")}</span>
          </Link>
        </div>

        {/* promo banner (p2p.me dark-gradient style) */}
        <div className="promo">
          <div className="promo-tag">BUILT FOR LOCAL SHOPS</div>
          <div className="promo-h">Get paid in USDC, instantly.</div>
          <div className="promo-sub">
            Take any local payment — it settles to USDC on-chain. Cash out to your bank anytime.
          </div>
          <span className="promo-qr"><Icon.Qr /></span>
        </div>


        {/* live settlement countdown — when locked funds free up */}
        {Number(pending) > 0 && (
          <div className="settle-card">
            <span className="settle-ico"><Icon.Clock /></span>
            <div className="settle-mid">
              <div className="settle-amt">{fmtUsdc(pending)} USDC {t("dash.onTheWay")}</div>
              <div className="settle-sub">
                {nextUnlock != null
                  ? <>{t("dash.nextUnlock")} <b>{mmss}</b> {t("dash.thenYours")}</>
                  : "Almost ready — refreshing…"}
              </div>
            </div>
          </div>
        )}


        {/* recent payments */}
        <div className="recent-head">
          <b>{t("dash.recent")}</b>
          <Link href="/transactions" className="see-all">{t("dash.seeAll")} ›</Link>
        </div>
        {recent.length === 0 ? (
          <div className="recent-empty">
            {t("dash.noPayments")}
          </div>
        ) : (
          <div className="recent-list">
            {recent.map((tx) => {
              const settled = tx.status === "settled";
              const cancelled = tx.status === "cancelled";
              const label = settled ? t("dash.received") : cancelled ? t("dash.cancelled") : t("dash.waiting");
              return (
                <div key={tx.orderId} className="recent-row">
                  <span className={`rr-ico ${settled ? "in" : "pend"}`}><Icon.Down /></span>
                  <div className="rr-mid">
                    <div className="rr-amt">{settled ? "+ " : ""}{fmtUsdc(tx.amount)} USDC</div>
                    <div className="rr-sub">Sale · #{tx.orderId} · {timeAgo(tx.createdAt)}</div>
                  </div>
                  <span className={`rr-status ${settled ? "ok" : cancelled ? "bad" : "wait"}`}>
                    {label}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {!ready && <p className="muted" style={{ textAlign: "center" }}>{t("common.loading")}</p>}
      </div>

      {/* bottom action bar — both primary actions */}
      <div className="bottombar">
        <Link href="/withdraw" className="btn ghost barbtn">
          <Icon.Up /> {t("nav.withdraw")}
        </Link>
        <button className="btn barbtn" onClick={acceptPayment}>
          <Icon.Plus /> {t("common.acceptPayment")}
        </button>
      </div>

      <WalletSheet open={walletOpen} onClose={() => setWalletOpen(false)}
        address={address} country={country} rate={rate} />
    </>
  );
}
