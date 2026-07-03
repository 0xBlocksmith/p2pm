"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { encodeFunctionData } from "viem";
import { useReadContract, usePublicClient } from "wagmi";
import { Nav } from "../../components/Nav";
import { useMerchant } from "../../components/useMerchant";
import { Icon } from "../../components/Icons";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, fmtUsdc, currencyFromBytes32, friendlyError } from "../../lib/contract";
import { fetchUsdcRate } from "../../lib/rates";
import { loadCountry, fmtFiat, COUNTRIES } from "../../lib/countries";
import { buildUsdcWithdraw } from "../../lib/withdraw";
import { fetchWithdrawals } from "../../lib/history";
import { useT } from "../../lib/i18n";

// The p2p Cashout widget is a large dependency and only appears when the merchant
// actually starts a fiat cash-out. Lazy-load it so it is NOT in the withdraw
// page's first-load bundle (it was ~250 kB of it) — the page paints fast, the
// widget's code is fetched on demand when `cashout` becomes non-null.
const CashoutWidget = dynamic(
  () => import("../../components/CashoutWidget").then((m) => m.CashoutWidget),
  { ssr: false, loading: () => <p className="muted" style={{ textAlign: "center" }}>Loading cash-out…</p> }
);

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
  const [wdCode, setWdCode] = useState("");          // the currency to withdraw IN
  const [otherOpts, setOtherOpts] = useState([]);    // all countries (+ live flag)
  const [otherOpen, setOtherOpen] = useState(false);
  const [rate, setRate] = useState(null);
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [cashout, setCashout] = useState(null); // active fiat cash-out (Cashout widget)
  const [payoutChoice, setPayoutChoice] = useState("saved"); // "saved" | "new"
  const [newPayout, setNewPayout] = useState("");

  useEffect(() => { const c = loadCountry(); setCountry(c); setWdCode(c.code); }, []);

  // Every configured country is selectable as the withdraw currency (default =
  // the merchant's registered one). The circle is resolved at withdrawal time.
  useEffect(() => { setOtherOpts(COUNTRIES); }, []);
  // 1s countdown ticker for the settlement timers. PAUSED while the Cashout
  // modal is open: it re-renders the mounted CashoutWidget every second, and the
  // widget's status-poll effect resets on each re-render — a live tick would
  // starve the poll so the offramp never advances. The timers aren't visible
  // behind the modal anyway.
  useEffect(() => {
    if (cashout) return;
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, [cashout]);
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
  // Read the merchant struct to detect an IN-FLIGHT fiat withdrawal (index 8).
  // A new fiat withdraw reverts WithdrawalInFlight while this is > 0, so we warn
  // the merchant and offer a self-service recover.
  const { data: mstruct, refetch: refetchMerchant } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "merchants",
    args: [address], query: { enabled: !!address, refetchInterval: 20000 },
  });
  const inFlight = mstruct ? Number((mstruct as any)[8]) : 0;
  const { data: proxyAddr } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "proxyAddress",
    args: [address], query: { enabled: !!address && inFlight > 0 },
  });
  // Is the connected wallet the contract OWNER? Only the owner can run the admin
  // recovery (freeze → adminAbort → unfreeze) that frees an order the LP left
  // stuck at "matching" (which reconcileWithdrawal alone can't).
  const { data: ownerAddr } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "owner",
    query: { enabled: inFlight > 0 },
  });
  const isOwner = !!address && !!ownerAddr && (address as string).toLowerCase() === (ownerAddr as string).toLowerCase();
  const savedPayout = info?.[0] || "";

  async function sendAndWait(functionName: string, args: any[]) {
    const data = encodeFunctionData({ abi: INTEGRATOR_ABI, functionName, args } as any);
    const hash = await sendTransaction({ to: CONTRACT_ADDRESS, data });
    const rc = await publicClient.waitForTransactionReceipt({ hash });
    if (rc.status === "reverted") throw new Error(functionName + " reverted");
    return hash;
  }

  // Recover a stuck in-flight fiat withdrawal.
  //  1) Try reconcileWithdrawal (permissionless) — works once the Diamond has
  //     CANCELLED the order (sweeps the refund back, frees the slot).
  //  2) If that reverts AND the connected wallet is the OWNER, run the admin path
  //     freeze → adminAbortWithdrawal → unfreeze, which recovers an order stuck at
  //     "matching" that the LP never released. This returns the escrowed USDC and
  //     frees the in-flight slot so withdrawals work again.
  //  3) Otherwise (not owner, still active), show a clear "needs support" message.
  async function recoverInFlight() {
    setError(""); setDone("");
    if (!proxyAddr) return setError("Still loading — try again in a moment.");
    setBusy("recover");
    try {
      const rows = await fetchWithdrawals(proxyAddr as string);
      const latest = rows?.[0]; // newest-first
      if (!latest?.orderId) throw new Error("Couldn't find the withdrawal to recover.");
      const orderId = BigInt(latest.orderId);

      // 1) permissionless reconcile
      try {
        await sendAndWait("reconcileWithdrawal", [orderId]);
        setDone(`Recovered withdrawal #${latest.orderId}. You can withdraw again.`);
        refetch(); refetchMerchant();
        return;
      } catch (reconErr) {
        // 2) owner-only admin recovery for an order the LP left active
        if (isOwner) {
          await sendAndWait("freezeMerchant", [address]);
          try {
            await sendAndWait("adminAbortWithdrawal", [orderId]);
          } finally {
            // ALWAYS unfreeze, even if abort failed, so we never leave frozen.
            await sendAndWait("unfreezeMerchant", [address]);
          }
          setDone(`Admin-recovered withdrawal #${latest.orderId}. Funds returned (settling ~10 min); you can withdraw again.`);
          refetch(); refetchMerchant();
          return;
        }
        throw reconErr; // not owner → fall through to the message below
      }
    } catch (err: any) {
      setError(
        friendlyError(err,
          "This withdrawal is still active on-chain and couldn't be recovered automatically. It can only be released by the payment partner or by support — please contact support with the order number.")
      );
    } finally { setBusy(""); }
  }
  // Default the payout choice to the saved handle if one exists, else "new".
  useEffect(() => { setPayoutChoice(savedPayout ? "saved" : "new"); }, [savedPayout]);
  // The merchant's REGISTERED offramp currency (getMerchantInfo[2], bytes32).
  // The contract pins withdrawals to this — so "home currency" must be derived
  // from it, not from the freely-editable UI country preference.
  const registeredCode = currencyFromBytes32(info?.[2] as string);
  const [pending, available] = balance ?? [0n, 0n];
  const availNum = Number(available) / 1e6;               // available in USDC
  const availFiat = rate ? availNum * rate.rate : null;   // available in local fiat

  // The AMOUNT FIELD is now entered in LOCAL FIAT (₹ / R$ / …) — what a shopkeeper
  // thinks in — and we convert to USDC under the hood. Empty = withdraw MAX.
  const typedFiat = amount.trim();
  // fiat the user wants → USDC (÷ rate). Empty means "everything".
  const fiatNum = typedFiat === "" ? availFiat ?? 0 : (Number(typedFiat) || 0);
  const usdcNum = typedFiat === "" ? availNum : (rate ? fiatNum / rate.rate : 0);
  const overBalance = usdcNum > availNum + 1e-9;

  // withdraw-currency helpers
  const CC = { india: "in", brazil: "br", argentina: "ar" };
  const flagOf = (code) => {
    const c = COUNTRIES.find((x) => x.code === code);
    return `https://flagcdn.com/w40/${CC[c?.id] || "un"}.png`;
  };
  const wdCountry = COUNTRIES.find((c) => c.code === wdCode) || country;
  // "Home" = withdrawing in the merchant's REGISTERED currency (the one the
  // contract pins the SELL to). Derived from the on-chain currency, not the UI
  // country pref — else an INR merchant who set their UI to Brazil would place an
  // INR order on the BRL circle. Falls back to the UI country only until info loads.
  const isHome = registeredCode
    ? wdCode === registeredCode
    : (!!country && wdCode === country.code);

  async function withdraw(kind) {
    setError(""); setDone("");
    // Empty fiat input = withdraw MAX. Otherwise the entered fiat is converted to
    // USDC (÷ rate). "0"/negative is rejected rather than coerced into "everything".
    const isMax = typedFiat === "";
    const sendUsdc = isMax ? availNum : usdcNum;
    if (!isMax && sendUsdc <= 0) return setError("Enter an amount greater than zero.");
    if (sendUsdc > availNum + 1e-9) return setError("Amount exceeds your available balance.");

    // Exact on-chain `available` bigint for a MAX withdraw (or when the converted
    // amount meets/exceeds the balance) so float rounding can't push the raw
    // amount 1 unit over and revert; otherwise convert the USDC amount.
    const useExactMax = isMax || sendUsdc >= availNum;
    const raw = useExactMax ? (available as bigint) : BigInt(Math.round(sendUsdc * 1e6));

    // FIAT: hand off to the official Cashout widget. It collects/encrypts the
    // payout and runs the full offramp lifecycle. Before opening it, we let the
    // merchant confirm which payout handle to use (saved or a new one) — if they
    // chose a NEW one we persist it on-chain via updateProfile so the widget
    // picks it up. (The widget itself is what actually encrypts + delivers it.)
    if (kind === "fiat") {
      // If the merchant picked "new" and typed a handle, save it on-chain first.
      if (payoutChoice === "new" && newPayout.trim() && newPayout.trim() !== savedPayout) {
        setBusy("fiat");
        try {
          const data = encodeFunctionData({
            abi: INTEGRATOR_ABI, functionName: "updateProfile",
            args: [newPayout.trim(), info?.[1] || "Shop"],
          });
          const hash = await sendTransaction({ to: CONTRACT_ADDRESS, data });
          const rc = await publicClient.waitForTransactionReceipt({ hash });
          if (rc.status === "reverted") throw new Error("Couldn't save the new payout id.");
        } catch (err) {
          setBusy(""); return setError(friendlyError(err, "Couldn't save your payout ID."));
        }
        setBusy("");
      }
      setCashout({ defaultAmountUsdc: raw, code: wdCode, isHome });
      return;
    }

    // USDC: direct on-chain transfer to the merchant's own wallet — no LP, no
    // encryption. Fully self-contained.
    setBusy(kind);
    try {
      const { data } = buildUsdcWithdraw({ amountRaw: raw });
      const hash = await sendTransaction({ to: CONTRACT_ADDRESS, data });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") throw new Error("Withdrawal failed on-chain.");
      setDone(
        `${sendUsdc.toFixed(2)} USDC sent to your wallet ${address ? `(${address.slice(0,6)}…${address.slice(-4)})` : ""}. If you don't see it, add the USDC token to your wallet.`
      );
      setAmount(""); refetch();
    } catch (err) {
      console.error(err);
      setError(friendlyError(err, "Withdrawal failed. Please try again."));
    } finally {
      setBusy("");
    }
  }

  if (!country) return <><Nav back /><div className="screen"><p className="muted" style={{ textAlign: "center" }}>{t("common.loading")}</p></div></>;

  return (
    <>
      <Nav back />
      {cashout && (
        <CashoutWidget
          defaultAmountUsdc={cashout.defaultAmountUsdc}
          isHome={cashout.isHome}
          currency={{ code: cashout.code, flag: wdCountry?.flag, fiat: wdCountry?.fiat, symbol: wdCountry?.symbol }}
          onComplete={() => { setCashout(null); setDone(`Withdrawal in ${wdCountry?.fiat} completed.`); setAmount(""); refetch(); }}
          onCancelled={() => { setCashout(null); refetch(); }}
          onClose={() => { setCashout(null); refetch(); }}
          onError={(m) => setError(m)}
        />
      )}
      <div className="screen">
        {/* In-flight withdrawal warning — a new fiat withdraw is blocked while one
            is unsettled. Explain it and offer a self-service recover. */}
        {inFlight > 0 && (
          <div className="wd-inflight" style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 12, border: "1px solid var(--warn-border, #e0b100)", background: "var(--warn-soft, rgba(224,177,0,.08))", marginBottom: 12 }}>
            <span><Icon.Clock /></span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700 }}>{t("wd.inflightTitle")}</div>
              <div className="muted" style={{ fontSize: 12 }}>{t("wd.inflightBody")}</div>
            </div>
            <button className="btn small secondary" disabled={busy === "recover"}
              onClick={recoverInFlight}>
              {busy === "recover" ? t("wd.working") : t("wd.recover")}
            </button>
          </div>
        )}

        <div className="balance">
          <div className="balance-label">{t("wd.ready")}</div>
          <div className="balance-amount" style={{ fontSize: 42 }}>${availNum.toFixed(2)}</div>
          <div className="balance-sub">
            {availFiat != null ? `≈ ${fmtFiat(country, availFiat)} ${country.code}` : "≈ —"}
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
          <label className="wd-label">{t("wd.amount")} ({country.code})</label>
          <div className="wd-amt-row">
            {/* Amount entered in LOCAL FIAT (₹/R$/…) with the currency symbol; the
                USDC equivalent is shown small below. */}
            <div className="wd-fiat-input" style={{ display: "flex", alignItems: "center", flex: 1, gap: 6 }}>
              <span className="wd-fiat-sym" style={{ fontWeight: 700, color: "var(--muted)" }}>{country.symbol}</span>
              <input className="input" type="number" min="0" step="0.01"
                placeholder={availFiat != null ? availFiat.toFixed(2) : "0.00"} value={amount}
                onChange={(e) => setAmount(e.target.value)} style={{ flex: 1 }} />
            </div>
            <button className="btn secondary small" type="button"
              onClick={() => setAmount(availFiat != null ? availFiat.toFixed(2) : "")}>{t("wd.max")}</button>
          </div>
          {/* small USDC equivalent of whatever fiat is typed */}
          <div className="wd-usdc-hint muted" style={{ fontSize: 12, marginTop: 6 }}>
            ≈ {usdcNum > 0 ? usdcNum.toFixed(2) : availNum.toFixed(2)} USDC
            {typedFiat === "" && <span> · {t("wd.max")}</span>}
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
                  onClick={() => { setWdCode(c.code); setOtherOpen(false); }}>
                  <img className="pk-flag-img" src={flagOf(c.code)} alt="" />
                  <span className="pk-item-txt">{c.name}<small>{c.fiat} · {c.symbol} {c.code}</small></span>
                  {wdCode === c.code && <span className="pk-chk">✓</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* PAYOUT DESTINATION for a fiat cash-out — pick the saved handle or enter
            a new one. The handle is delivered ENCRYPTED by the secure cash-out
            step; if "new" is chosen we persist it on-chain (updateProfile) before
            opening the widget so it uses the right one. USDC withdrawal needs no
            handle (it goes to the merchant's own wallet). */}
        <div className="wd-card" style={{ marginTop: 14 }}>
          <label className="wd-label">{wdCountry?.payoutLabel || "Payout ID"} ({t("wd.forBank")})</label>

          {savedPayout && (
            <button type="button"
              className={`wd-payout-opt ${payoutChoice === "saved" ? "sel" : ""}`}
              onClick={() => setPayoutChoice("saved")}
              style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", marginTop: 8, borderRadius: 10, border: "1px solid var(--border)", background: payoutChoice === "saved" ? "var(--accent-soft, rgba(20,136,255,.08))" : "transparent", cursor: "pointer" }}>
              <span className="wd-radio">{payoutChoice === "saved" ? "●" : "○"}</span>
              <span style={{ flex: 1, textAlign: "left" }}>
                <b>{t("wd.useSaved")}</b>
                <small style={{ display: "block", color: "var(--muted)" }}>{savedPayout}</small>
              </span>
            </button>
          )}

          <button type="button"
            className={`wd-payout-opt ${payoutChoice === "new" ? "sel" : ""}`}
            onClick={() => setPayoutChoice("new")}
            style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "10px 12px", marginTop: 8, borderRadius: 10, border: "1px solid var(--border)", background: payoutChoice === "new" ? "var(--accent-soft, rgba(20,136,255,.08))" : "transparent", cursor: "pointer" }}>
            <span className="wd-radio">{payoutChoice === "new" ? "●" : "○"}</span>
            <span style={{ flex: 1, textAlign: "left" }}><b>{savedPayout ? t("wd.useNew") : t("wd.enterPayout")}</b></span>
          </button>

          {payoutChoice === "new" && (
            <input className="input" style={{ marginTop: 10 }}
              placeholder={wdCountry?.payoutPlaceholder || "your@upi"}
              value={newPayout} onChange={(e) => setNewPayout(e.target.value.trim())} />
          )}
        </div>

        {error && <p className="error" style={{ textAlign: "center" }}>{error}</p>}
        {done && <p className="success" style={{ textAlign: "center" }}>✓ {done}</p>}
      </div>

      {/* If the merchant typed a fiat amount but the USDC↔fiat rate hasn't loaded,
          we can't convert it yet — show a hint and disable withdraw (rather than
          coercing the conversion to 0 and rejecting a valid amount). An empty
          (MAX) input needs no rate, so it stays enabled. */}
      {typedFiat !== "" && !rate && (
        <p className="muted" style={{ textAlign: "center", fontSize: 12 }}>{t("wd.fetchingRate")}</p>
      )}

      <div className="bottombar" style={{ flexDirection: "column", gap: 10 }}>
        <button className="btn" style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
          disabled={!!busy || !ready || availNum <= 0 || overBalance || (typedFiat !== "" && !rate)}
          onClick={() => withdraw("fiat")}>
          <Icon.Bank /> {busy === "fiat" ? t("wd.working") : `${t("wd.sendToBank")} ${wdCountry?.fiat}`}
        </button>
        <button className="btn dark" style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
          disabled={!!busy || !ready || availNum <= 0 || overBalance || (typedFiat !== "" && !rate)}
          onClick={() => withdraw("usdc")}>
          <Icon.Wallet /> {busy === "usdc" ? t("wd.working") : t("wd.keepUsdc")}
        </button>
      </div>
    </>
  );
}
