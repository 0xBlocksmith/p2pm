"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useReadContract } from "wagmi";
import { Nav } from "../../components/Nav";
import { useMerchant } from "../../components/useMerchant";
import { Icon } from "../../components/Icons";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, PER_TX_CAP_USDC } from "../../lib/contract";
import { fetchUsdcRate } from "../../lib/rates";
import { loadCountry, fmtFiat, COUNTRIES } from "../../lib/countries";
import { useT } from "../../lib/i18n";
import dynamic from "next/dynamic";

const INTEGRATOR = CONTRACT_ADDRESS;
const SCAN = "https://sepolia.basescan.org";

const CheckoutWidget = dynamic(
  () => import("../../components/CheckoutWidget").then((m) => m.CheckoutWidget),
  { ssr: false }
);

// Quick-amount presets per country (local fiat).
const QUICK = { INR: [10, 20, 50], BRL: [5, 10, 20], ARS: [500, 1000, 2000] };

// A short success chime + vibration — like every POS app.
function paymentFeedback() {
  try {
    if (navigator.vibrate) navigator.vibrate([40, 30, 60]);
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const notes = [880, 1175]; // a pleasant two-note "ding"
    notes.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.14;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.start(t); o.stop(t + 0.2);
    });
  } catch {}
}

export default function PosQr() {
  const router = useRouter();
  const { ready, address } = useMerchant();
  const { t } = useT();

  const [country, setCountry] = useState(null);   // the currency THIS sale charges in
  const [payOpts, setPayOpts] = useState([]);     // countries the protocol can settle
  const [pickOpen, setPickOpen] = useState(false);
  const [amt, setAmt] = useState("");        // local fiat the merchant types
  const [lastAmt, setLastAmt] = useState(""); // for "repeat"
  const [rate, setRate] = useState(null);
  const [error, setError] = useState("");
  const [liveWidget, setLiveWidget] = useState(null);
  const [done, setDone] = useState(null);
  const [payError, setPayError] = useState("");

  // Default the sale currency to the merchant's registered country.
  useEffect(() => { setCountry(loadCountry()); }, []);

  // Every configured country is selectable as the accept currency. The widget
  // resolves the circle for the picked currency at order time; if the protocol
  // adds a circle, nothing here changes.
  useEffect(() => { setPayOpts(COUNTRIES); }, []);

  // Accepting a payment requires registration. If the merchant reached here
  // without registering, send them to set up their shop first.
  const { data: isRegistered } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "registered",
    args: [address], query: { enabled: !!address },
  });
  useEffect(() => {
    if (isRegistered === false) router.replace("/onboarding");
  }, [isRegistered, router]);

  const { data: info } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantInfo",
    args: [address], query: { enabled: !!address },
  });
  const shopLabel = info?.[1] || "";

  const { data: daily, refetch: refetchDaily } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getDailyTxInfo",
    args: [address], query: { enabled: !!address, refetchInterval: 20000 },
  });
  const [used, limit] = daily ?? [0n, 4n];
  const limitReached = daily ? used >= limit : false;

  useEffect(() => {
    if (!country) return;
    let alive = true;
    const load = () => fetchUsdcRate(country).then((r) => alive && setRate(r));
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [country]);

  const amtNum = Number(amt) || 0;
  const usdcEquiv = rate && amtNum > 0 ? amtNum / rate.rate : 0;
  const overCap = usdcEquiv > PER_TX_CAP_USDC;

  function press(k) {
    setError("");
    setAmt((cur) => {
      if (k === "del") return cur.slice(0, -1);
      if (k === ".") return cur.includes(".") ? cur : (cur || "0") + ".";
      const next = (cur + k).replace(/^0+(?=\d)/, "");
      return next.length > 9 ? cur : next;
    });
  }

  function generate() {
    setError("");
    if (!rate) return;
    if (amtNum <= 0) return setError(`Enter the amount in ${country.code}.`);
    if (overCap) {
      return setError(
        `Max ${PER_TX_CAP_USDC} USDC per sale (≈ ${fmtFiat(country, PER_TX_CAP_USDC * rate.rate)} now).`
      );
    }
    const quantity = BigInt(Math.round(usdcEquiv * 100));
    if (quantity === 0n) return setError("Amount too small.");
    setLastAmt(amt);
    setLiveWidget({
      usdcAmount: BigInt(Math.round(usdcEquiv * 1e6)),
      quantity, fiat: amtNum, usdc: usdcEquiv,
    });
  }

  // Public, no-auth receipt link the CUSTOMER opens to verify their payment.
  function receiptUrl() {
    if (typeof window === "undefined" || !done) return "";
    const q = new URLSearchParams({
      shop: shopLabel || "My Shop",
      fiat: fmtFiat(country, done.fiat),
    });
    return `${window.location.origin}/receipt/${done.orderId}?${q.toString()}`;
  }

  function shareReceipt() {
    const url = receiptUrl();
    const text =
      `PayQR receipt — ${shopLabel || "My Shop"}\n` +
      `${fmtFiat(country, done.fiat)} received. Verify your payment:`;
    if (navigator.share) navigator.share({ title: "PayQR receipt", text, url }).catch(() => {});
    else navigator.clipboard?.writeText(`${text}\n${url}`);
  }

  if (!country) return <><Nav back /><div className="screen"><p className="muted" style={{ textAlign: "center" }}>Loading…</p></div></>;

  const quick = QUICK[country.code] || QUICK.INR;

  return (
    <>
      <Nav back />
      <div className="screen">

        {liveWidget && (
          <>
            <CheckoutWidget
              usdcAmount={liveWidget.usdcAmount}
              quantity={liveWidget.quantity}
              productName={shopLabel || "PayQR sale"}
              currencies={[{
                symbol: country.code, flag: country.flag,
                paymentMethod: country.fiat, symbolNative: country.symbol,
              }]}
              onComplete={(orderId) => {
                paymentFeedback();
                setDone({ orderId: String(orderId), usdc: liveWidget.usdc, fiat: liveWidget.fiat });
                setLiveWidget(null); setAmt(""); refetchDaily();
              }}
              onCancel={() => { setLiveWidget(null); refetchDaily(); }}
              onClose={() => setLiveWidget(null)}
              onError={(m) => { setPayError(m); setLiveWidget(null); }}
            />
          </>
        )}

        {/* Friendly message when the QR can't be created (no LP available) */}
        {payError && !liveWidget && !done && (
          <div className="panel" style={{ textAlign: "center" }}>
            <h2>Couldn’t start this payment</h2>
            <p className="muted" style={{ margin: "8px 0 4px" }}>
              No payment partner is available right now to process this sale. This
              is usually temporary — please try again in a moment.
            </p>
            <p className="tiny" style={{ color: "var(--muted)", marginBottom: 14 }}>{payError}</p>
            <button className="btn" style={{ width: "100%" }}
              onClick={() => { setPayError(""); }}>
              Try again
            </button>
          </div>
        )}

        {/* You received USDC — confirmation */}
        {done && (
          <div className="received">
            <div className="tick-wrap"><Icon.Check /></div>
            <div className="recv-h">{t("qr.received")}<br />${done.usdc.toFixed(2)} USDC</div>
            <p className="muted recv-sub">
              Settled on-chain · paid by customer ({fmtFiat(country, done.fiat)}).
              Withdraw to your bank or keep as USDC.
            </p>
            <div className="proofcard">
              <div className="prow"><span className="k">Order</span><span className="v">#{done.orderId}</span></div>
              <div className="prow"><span className="k">Received</span><span className="v">{done.usdc.toFixed(2)} USDC</span></div>
              <div className="prow">
                <span className="k">Proof</span>
                <a className="v link" target="_blank" rel="noopener noreferrer"
                   href={`${SCAN}/address/${INTEGRATOR}`}>Basescan ↗</a>
              </div>
            </div>
            <a className="recv-receipt-link" href={receiptUrl()} target="_blank" rel="noopener noreferrer">
              <Icon.Receipt width="15" height="15" /> {t("qr.showReceipt")}
            </a>
            <div className="recv-actions">
              <button className="btn ghost" onClick={shareReceipt}><Icon.Share /> {t("qr.sendReceipt")}</button>
              <button className="btn" onClick={() => setDone(null)}><Icon.Plus /> {t("qr.next")}</button>
            </div>
          </div>
        )}

        {limitReached && !liveWidget && !done && !payError && (
          <div className="panel">
            <h2>Daily limit reached ({String(used)}/{String(limit)})</h2>
            <p className="muted">All transactions used for today. Resets at midnight UTC.</p>
          </div>
        )}

        {/* Number-pad terminal */}
        {!limitReached && !liveWidget && !done && !payError && (
          <div className="terminal">
            {/* charge-currency picker — only shows currencies the protocol can
                settle (live circles). Lets a merchant accept in any supported
                currency, e.g. when travelling. Default = registered country. */}
            {payOpts.length > 1 && (
              <div className="cur-pick">
                <button className={`cur-pick-btn ${pickOpen ? "on" : ""}`}
                  onClick={() => setPickOpen((o) => !o)}>
                  <span className="cur-pick-label">{t("qr.chargeIn")}</span>
                  <img className="cur-flag" src={`https://flagcdn.com/w40/${({india:"in",brazil:"br",argentina:"ar"})[country.id] || "un"}.png`} alt="" />
                  <b>{country.code}</b><span className="cur-car">▾</span>
                </button>
                {pickOpen && (
                  <div className="cur-pick-pop">
                    {payOpts.map((c) => (
                      <button key={c.id} className={`cur-pick-item ${c.id === country.id ? "sel" : ""}`}
                        onClick={() => { setCountry(c); setAmt(""); setError(""); setPickOpen(false); }}>
                        <img className="cur-flag" src={`https://flagcdn.com/w40/${({india:"in",brazil:"br",argentina:"ar"})[c.id] || "un"}.png`} alt="" />
                        <span className="cur-pick-txt">{c.name}<small>{c.fiat} · {c.symbol} {c.code}</small></span>
                        {c.id === country.id && <span className="cur-chk">✓</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="t-amount">
              <div className="t-shop">{shopLabel || t("qr.newSale")}</div>
              <div className="t-value">{fmtFiat(country, amt || 0)}</div>
              <div className="t-sub">
                {rate
                  ? amtNum > 0 ? `≈ ${usdcEquiv.toFixed(2)} USDC ${t("qr.youKeep")}` : t("qr.enterAmount")
                  : t("qr.fetchingRate")}
              </div>
              {overCap && rate && (
                <div className="t-warn">Max {fmtFiat(country, PER_TX_CAP_USDC * rate.rate)} per sale</div>
              )}
            </div>

            {/* quick amounts + repeat */}
            <div className="quick-amts">
              {quick.map((q) => (
                <button key={q} className="qa-chip" onClick={() => { setAmt(String(q)); setError(""); }}>
                  {country.symbol}{q}
                </button>
              ))}
              <button className="qa-chip repeat" disabled={!lastAmt}
                onClick={() => { setAmt(lastAmt); setError(""); }} title="Repeat last amount">
                <Icon.Repeat width="16" height="16" />
              </button>
            </div>

            <div className="keypad">
              {["1","2","3","4","5","6","7","8","9",".","0","del"].map((k) => (
                <button key={k} className="keypad-key" onClick={() => press(k)}>
                  {k === "del" ? "⌫" : k}
                </button>
              ))}
            </div>

            <button className="btn t-charge"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
              disabled={!ready || !rate || amtNum <= 0 || overCap} onClick={generate}>
              <Icon.Qr /> {amtNum > 0 ? `${t("common.acceptPayment")} · ${fmtFiat(country, amt)}` : t("common.acceptPayment")}
            </button>
            {error && <p className="error" style={{ textAlign: "center" }}>{error}</p>}
            <div className="t-foot">{String(used)} / {String(limit)} sales today</div>
          </div>
        )}
      </div>
    </>
  );
}
