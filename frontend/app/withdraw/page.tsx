"use client";

import { useState, useEffect } from "react";
import { useReadContract, usePublicClient } from "wagmi";
import { Nav } from "../../components/Nav";
import { useMerchant } from "../../components/useMerchant";
import { Icon } from "../../components/Icons";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, fmtUsdc } from "../../lib/contract";
import { fetchUsdcRate } from "../../lib/rates";
import { loadCountry, fmtFiat, COUNTRIES } from "../../lib/countries";
import { buildFiatWithdraw, buildFiatWithdrawIn, buildUsdcWithdraw } from "../../lib/withdraw";
import { useT } from "../../lib/i18n";

function fmtRemaining(secs) {
  if (secs <= 0) return "ready";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.ceil(secs / 60)} min`;
  if (secs < 86400) return `${Math.ceil(secs / 3600)} hr`;
  return `${Math.ceil(secs / 86400)} days`;
}

export default function Withdraw() {
  const { ready, address, sendTransaction } = useMerchant();
  const publicClient = usePublicClient();
  const { t } = useT();

  const [country, setCountry] = useState(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [newPayout, setNewPayout] = useState("");   // home-currency payout (override of saved)
  const [wdCode, setWdCode] = useState("");          // the currency to withdraw IN
  const [otherPayout, setOtherPayout] = useState(""); // payout for a non-home currency
  const [otherOpts, setOtherOpts] = useState([]);    // all countries (+ live flag)
  const [otherOpen, setOtherOpen] = useState(false);
  const [rate, setRate] = useState(null);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));

  useEffect(() => { const c = loadCountry(); setCountry(c); setWdCode(c.code); }, []);

  // Every configured country is selectable as the withdraw currency (default =
  // the merchant's registered one). The circle is resolved at withdrawal time.
  useEffect(() => { setOtherOpts(COUNTRIES); }, []);
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

  const { data: buckets } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantBuckets",
    args: [address], query: { enabled: !!address, refetchInterval: 15000 },
  });
  const lockedBuckets = (buckets || []).filter((b) => b.amount > 0n && Number(b.unlockTimestamp) > now);

  const { data: balance, refetch } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantBalance",
    args: [address], query: { enabled: !!address, refetchInterval: 20000 },
  });
  const { data: info } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantInfo",
    args: [address], query: { enabled: !!address },
  });
  const savedPayout = info?.[0] || "";
  const [pending, available] = balance ?? [0n, 0n];
  const availNum = Number(available) / 1e6;
  const amtNum = Number(amount) || availNum;
  const overBalance = amtNum > availNum;
  const fiatOut = rate ? amtNum * rate.rate : null;

  // withdraw-currency helpers
  const CC = { india: "in", brazil: "br", argentina: "ar" };
  const flagOf = (code) => {
    const c = COUNTRIES.find((x) => x.code === code);
    return `https://flagcdn.com/w40/${CC[c?.id] || "un"}.png`;
  };
  const wdCountry = COUNTRIES.find((c) => c.code === wdCode) || country;
  const isHome = !!country && wdCode === country.code;   // withdrawing in registered currency

  async function withdraw(kind) {
    setError(""); setDone("");
    const sendAmt = Number(amount) || availNum;
    if (sendAmt <= 0) return setError("Nothing available to withdraw yet.");
    if (sendAmt > availNum) return setError("Amount exceeds your available balance.");

    const crossCurrency = kind === "fiat" && !isHome;
    // home: use the typed override if any, else the saved payout.
    const homePayout = (newPayout.trim() || savedPayout);

    if (kind === "fiat") {
      const target = crossCurrency ? otherPayout.trim() : homePayout;
      if (!target) return setError(`Enter your ${wdCountry.payoutLabel}.`);
      if (!wdCountry.validatePayout(target)) {
        return setError(`Enter a valid ${wdCountry.payoutLabel} (like ${wdCountry.payoutPlaceholder}).`);
      }
    }

    // Use the exact on-chain `available` bigint when withdrawing the full
    // balance (empty input or the displayed MAX), so float rounding can't push
    // the raw amount 1 unit over `available` and revert. Otherwise convert the
    // typed amount.
    const isMax = !amount.trim() || Number(amount) >= availNum;
    const raw = isMax ? (available as bigint) : BigInt(Math.round(sendAmt * 1e6));
    setBusy(kind);
    try {
      const { data } =
        kind === "usdc"
          ? buildUsdcWithdraw({ amountRaw: raw })
          : crossCurrency
            ? await buildFiatWithdrawIn({ amountRaw: raw, code: wdCode, payout: otherPayout.trim() })
            : await buildFiatWithdraw({ amountRaw: raw, country, payoutOverride: newPayout.trim() });
      const hash = await sendTransaction({ to: CONTRACT_ADDRESS, data });
      await publicClient.waitForTransactionReceipt({ hash });
      setDone(
        kind === "usdc"
          ? `${sendAmt.toFixed(2)} USDC sent to your wallet.`
          : `Withdrawal in ${wdCountry.fiat} started — paid once the LP settles.`
      );
      setAmount(""); refetch();
    } catch (err) {
      console.error(err);
      setError(err.shortMessage || err.message || "Withdrawal failed");
    } finally {
      setBusy("");
    }
  }

  if (!country) return <><Nav back /><div className="screen"><p className="muted" style={{ textAlign: "center" }}>{t("common.loading")}</p></div></>;

  return (
    <>
      <Nav back />
      <div className="screen">
        <div className="balance">
          <div className="balance-label">{t("wd.ready")}</div>
          <div className="balance-amount" style={{ fontSize: 42 }}>${availNum.toFixed(2)}</div>
          <div className="balance-sub">
            {fiatOut != null ? `≈ ${fmtFiat(country, fiatOut)} ${country.code}` : "≈ —"}
            {Number(pending) > 0 ? ` · ${fmtUsdc(pending)} still settling` : ""}
          </div>
        </div>

        {lockedBuckets.length > 0 && (
          <div className="wd-locked">
            <div className="wd-locked-h">{t("wd.unlockingSoon")}</div>
            {lockedBuckets.map((b, i) => {
              const secs = Number(b.unlockTimestamp) - now;
              return (
                <div key={i} className="wd-locked-row">
                  <span>{fmtUsdc(b.amount)} USDC</span>
                  <span className="badge locked">in {fmtRemaining(secs)}</span>
                </div>
              );
            })}
          </div>
        )}

        <div className="wd-card">
          <label className="wd-label">{t("wd.amount")}</label>
          <div className="wd-amt-row">
            <input className="input" type="number" min="0" step="0.01"
              placeholder={availNum.toFixed(2)} value={amount}
              onChange={(e) => setAmount(e.target.value)} />
            <button className="btn secondary small" type="button"
              onClick={() => setAmount(availNum.toFixed(2))}>{t("wd.max")}</button>
          </div>
          {overBalance && <p className="error">{t("wd.exceeds")}</p>}
        </div>

        {/* WITHDRAW CURRENCY — Accept-style dropdown. Default = registered
            country; pick another to cash out in that currency. */}
        <div className="wd-label" style={{ marginTop: 18 }}>{t("wd.withdrawIn")}</div>
        <div className="picker wd-cur">
          <button className={`picker-btn ${otherOpen ? "on" : ""}`} onClick={() => setOtherOpen((o) => !o)}>
            <img className="pk-flag-img" src={flagOf(wdCode)} alt="" />
            <span className="pk-text">{wdCountry?.name} · {wdCountry?.symbol} {wdCode}</span>
            <span className="pk-car">▾</span>
          </button>
          {otherOpen && (
            <div className="picker-pop">
              {otherOpts.map((c) => (
                <button key={c.id} className={`picker-item ${wdCode === c.code ? "sel" : ""}`}
                  onClick={() => { setWdCode(c.code); setOtherPayout(""); setOtherOpen(false); }}>
                  <img className="pk-flag-img" src={flagOf(c.code)} alt="" />
                  <span className="pk-item-txt">{c.name}<small>{c.fiat} · {c.symbol} {c.code}</small></span>
                  {wdCode === c.code && <span className="pk-chk">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* PAYOUT — pre-fills the saved handle when withdrawing in the home
            currency; otherwise the merchant enters the handle for the picked one. */}
        <label className="wd-label" style={{ marginTop: 12, display: "block" }}>{wdCountry?.payoutLabel}</label>
        <input className="input"
          placeholder={isHome ? (savedPayout || wdCountry?.payoutPlaceholder) : wdCountry?.payoutPlaceholder}
          value={isHome ? (newPayout || savedPayout) : otherPayout}
          onChange={(e) => isHome ? setNewPayout(e.target.value) : setOtherPayout(e.target.value)} />
        {isHome && savedPayout && !newPayout && (
          <p className="wd-saved-note">{t("wd.savedNote")}</p>
        )}

        {error && <p className="error" style={{ textAlign: "center" }}>{error}</p>}
        {done && <p className="success" style={{ textAlign: "center" }}>✓ {done}</p>}
      </div>

      <div className="bottombar" style={{ flexDirection: "column", gap: 10 }}>
        <button className="btn" style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
          disabled={!!busy || !ready || availNum <= 0 || overBalance}
          onClick={() => withdraw("fiat")}>
          <Icon.Bank /> {busy === "fiat" ? t("wd.working") : `${t("wd.sendToBank")} ${wdCountry?.fiat}`}
        </button>
        <button className="btn dark" style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
          disabled={!!busy || !ready || availNum <= 0 || overBalance}
          onClick={() => withdraw("usdc")}>
          <Icon.Wallet /> {busy === "usdc" ? t("wd.working") : t("wd.keepUsdc")}
        </button>
      </div>
    </>
  );
}
