"use client";

import { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { encodeFunctionData } from "viem";
import { useReadContract, usePublicClient } from "wagmi";
import { Nav } from "../../components/Nav";
import { useMerchant } from "../../components/useMerchant";
import { useRelayIdentity } from "../../components/useRelayIdentity";
import { Icon } from "../../components/Icons";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, fmtUsdc, currencyFromBytes32, friendlyError } from "../../lib/contract";
import { STATIC_STALE_MS } from "../../lib/cache";
import { encryptPayout, decryptPayout } from "../../lib/payoutCrypto";
import { fetchOnchainSellPrice, usdcForFiatSell, PriceNotConfiguredError } from "../../lib/price";
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
  const { getIdentity } = useRelayIdentity();
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
  // ON-CHAIN SELL price for the currency being withdrawn IN (wdCode). This is the
  // rate the offramp actually settles at, so the merchant's typed fiat payout
  // matches what the Cashout widget delivers — same fix as the Accept page's buy
  // price. Keyed off wdCode (the SELL currency), NOT the display country.
  const [sellPrice, setSellPrice] = useState(null);
  const [sellErr, setSellErr] = useState("");        // clear msg when a currency isn't priced
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [cashout, setCashout] = useState(null); // active fiat cash-out (Cashout widget)
  const [payoutChoice, setPayoutChoice] = useState("saved"); // "saved" | "new"
  const [newPayout, setNewPayout] = useState("");
  // USDC-withdraw multi-step flow: null (form) → "address" (review destination)
  //   → "confirm" (final dialog) → success (`done` set). The amount to send is
  // captured when entering the flow so it can't shift underneath the merchant.
  const [usdcStep, setUsdcStep] = useState<null | "address" | "confirm">(null);
  const [usdcSend, setUsdcSend] = useState<{ raw: bigint; usdc: number }>({ raw: 0n, usdc: 0 });
  // Which destination the merchant is withdrawing to: chosen FIRST, before any
  // currency/UPI UI is shown, so we don't ask USDC-bound questions about local
  // currency (and vice versa). null = not yet chosen.
  const [destChoice, setDestChoice] = useState<null | "fiat" | "usdc">(null);

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
  // Live on-chain SELL price for the withdraw currency. Refetched when the
  // merchant switches withdraw currency; cleared on failure so the amount field
  // shows a "loading rate" state rather than converting off a stale/guessed rate.
  useEffect(() => {
    if (!wdCode) return;
    let on = true;
    // "sell" price: withdrawal converts the merchant's USDC → fiat, so the
    // "≈ X" figures must use the cash-OUT (on-chain SELL) rate, not the buy price.
    const load = () =>
      fetchOnchainSellPrice(wdCode)
        .then((p) => { if (on) { setSellPrice(p); setSellErr(""); } })
        .catch((e) => {
          if (!on) return;
          setSellPrice(null);
          setSellErr(
            e instanceof PriceNotConfiguredError
              ? `Withdrawals in ${wdCode} aren't available yet.`
              : ""
          );
        });
    load();
    const t = setInterval(load, 60_000);
    return () => { on = false; clearInterval(t); };
  }, [wdCode]);

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
    args: [address], query: { enabled: !!address, staleTime: STATIC_STALE_MS },
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
    args: [address], query: { enabled: !!address && inFlight > 0, staleTime: STATIC_STALE_MS },
  });
  // Is the connected wallet a contract OWNER? Only an owner can run the admin
  // recovery (freeze → adminAbort → unfreeze) that frees an order the LP left
  // stuck at "matching" (which reconcileWithdrawal alone can't). The contract is
  // MULTI-OWNER (no owner() getter) — check membership via isOwner(address).
  const { data: ownerFlag } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "isOwner",
    args: [address as `0x${string}`], query: { enabled: !!address && inFlight > 0 },
  });
  const isOwner = !!ownerFlag;
  // info[0] is now the ENCRYPTED payout blob — decrypt it client-side for the
  // "use saved" option. null when not decryptable on this device (different relay
  // key); we then only offer "enter a new one".
  const encSaved = (info?.[0] as string) || "";
  const [savedPayout, setSavedPayout] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!encSaved || encSaved === "0x") { if (alive) setSavedPayout(""); return; }
      try {
        const id = await getIdentity();
        const plain = await decryptPayout(encSaved, id);
        if (alive) setSavedPayout(plain || "");
      } catch { if (alive) setSavedPayout(""); }
    })();
    return () => { alive = false; };
  }, [encSaved, getIdentity]);

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
  const availNum = Number(available) / 1e6;               // withdrawable (unlocked) USDC
  // Withdrawable in local fiat, at the ON-CHAIN sell rate the offramp settles at
  // (not an off-chain guess) — so the "≈ ₹X" preview matches what a full cash-out
  // would actually deliver.
  const availFiat = sellPrice ? availNum * sellPrice.rate : null;
  // ACCOUNT BALANCE = everything the contract holds for this merchant, matured
  // or not (pending = still-locked buckets + available = unlocked). NOT
  // totalDeposited, which is a lifetime counter that never decreases.
  const pendingNum = Number(pending) / 1e6;
  const accountNum = pendingNum + availNum;               // total USDC in contract
  const accountFiat = sellPrice ? accountNum * sellPrice.rate : null;
  // Soonest unlock across the locked buckets → drives the maturity note with the
  // REAL on-chain wait (this build settles in ~10 min; prod uses 30 days). We
  // read the actual timestamp rather than hardcode a period that may be wrong.
  const nextUnlock = lockedBuckets.reduce(
    (min, b) => Math.min(min, Number(b.unlockTimestamp)),
    Infinity
  );
  const nextUnlockSecs = nextUnlock === Infinity ? 0 : Math.max(0, nextUnlock - now);

  // The AMOUNT FIELD is entered in LOCAL FIAT (₹ / R$ / …) for the bank path —
  // what a shopkeeper thinks in — and converted to USDC under the hood using the
  // on-chain SELL price. Empty = withdraw MAX. On the USDC path the same field is
  // USDC directly, no conversion needed.
  const typedFiat = amount.trim();
  // fiat the user wants → USDC via the on-chain sellPrice. Empty means "everything".
  const fiatNum = typedFiat === "" ? availFiat ?? 0 : (Number(typedFiat) || 0);
  const usdcNum = typedFiat === ""
    ? availNum
    : destChoice === "usdc"
      ? (Number(typedFiat) || 0)
      : (sellPrice ? Number(usdcForFiatSell(Number(typedFiat) || 0, sellPrice)) / 1e6 : 0);
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
    // USDC via the on-chain sellPrice. "0"/negative is rejected rather than
    // coerced into "everything".
    const isMax = typedFiat === "";
    // A non-max fiat withdraw MUST have the live sell price — never size an
    // offramp off a guessed rate, or the delivered fiat won't match what was typed.
    if (!isMax && !sellPrice) {
      return setError("Live rate is still loading — one moment.");
    }
    const sendUsdc = isMax ? availNum : usdcNum;
    if (!isMax && sendUsdc <= 0) return setError("Enter an amount greater than zero.");
    if (sendUsdc > availNum + 1e-9) return setError("Amount exceeds your available balance.");

    // Exact on-chain `available` bigint for a MAX withdraw (or when the converted
    // amount meets/exceeds the balance) so float rounding can't push the raw
    // amount 1 unit over and revert; otherwise use the EXACT on-chain-derived
    // bigint (no float round-trip) from the sell price.
    const useExactMax = isMax || sendUsdc >= availNum;
    const raw = useExactMax
      ? (available as bigint)
      : usdcForFiatSell(Number(typedFiat) || 0, sellPrice);

    // FIAT: hand off to the official Cashout widget. It collects + encrypts the
    // payout FRESH in its own UI and runs the full offramp lifecycle — it does
    // NOT read our on-chain handle. So persisting a "new" default handle here is
    // a pure convenience (updates the merchant's saved default for next time); it
    // must NEVER block the withdraw. We validate it, then save BEST-EFFORT.
    if (kind === "fiat") {
      // If the merchant picked "new" and typed a handle, validate + save it as
      // their default (encrypted client-side — the raw handle never goes on-chain).
      // A failed/reverted save is non-fatal: we still open the widget.
      if (payoutChoice === "new" && newPayout.trim() && newPayout.trim() !== savedPayout) {
        // Validate on plaintext, same guard as onboarding/settings.
        if (wdCountry?.validatePayout && !wdCountry.validatePayout(newPayout.trim())) {
          return setError(`Enter a valid ${wdCountry.payoutLabel} (like ${wdCountry.payoutPlaceholder}).`);
        }
        // Only touch shopName if we actually have it loaded, so we never clobber
        // the real name with a placeholder.
        const currentShop = (info?.[1] as string) || "";
        if (currentShop) {
          setBusy("fiat");
          try {
            const identity = await getIdentity();
            const encNew = await encryptPayout(newPayout.trim(), identity);
            const data = encodeFunctionData({
              abi: INTEGRATOR_ABI, functionName: "updateProfile",
              args: [encNew, currentShop],
            });
            const hash = await sendTransaction({ to: CONTRACT_ADDRESS, data });
            await publicClient.waitForTransactionReceipt({ hash });
            // Best-effort: even if it reverted, fall through to the widget — the
            // widget collects the payout itself and doesn't need the saved copy.
          } catch {
            /* non-fatal — saving the default handle is optional; proceed to cash out */
          }
        }
        setBusy("");
      }
      setCashout({ defaultAmountUsdc: raw, code: wdCode, isHome });
      return;
    }

    // USDC: don't send immediately — capture the amount and step through
    // review (destination address) → confirm dialog → send. The transfer goes
    // to the merchant's OWN connected wallet (withdrawUSDC → msg.sender).
    setUsdcSend({ raw, usdc: sendUsdc });
    setUsdcStep("address");
  }

  // Final on-chain USDC send, fired from the confirm dialog.
  async function confirmUsdcWithdraw() {
    setError("");
    setBusy("usdc");
    try {
      const { data } = buildUsdcWithdraw({ amountRaw: usdcSend.raw });
      const hash = await sendTransaction({ to: CONTRACT_ADDRESS, data });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") throw new Error("Withdrawal failed on-chain.");
      setUsdcStep(null);
      setDone(
        `${usdcSend.usdc.toFixed(2)} USDC sent to your wallet ${address ? `(${address.slice(0,6)}…${address.slice(-4)})` : ""}. If you don't see it, add the USDC token to your wallet.`
      );
      setAmount(""); refetch();
    } catch (err) {
      console.error(err);
      setUsdcStep(null);
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
        {/* USDC WITHDRAW — STEP 2: review the destination wallet before sending.
            The transfer goes to the merchant's OWN connected wallet, shown here
            (read-only) so they can confirm exactly where it lands. */}
        {usdcStep === "address" && (
          <div className="wd-usdc-step">
            <button className="wallet-back" onClick={() => { setUsdcStep(null); setError(""); }}>
              <Icon.Back width="16" height="16" /> {t("wd.usdcTitle")}
            </button>
            <div className="wd-usdc-amt">
              <span className="wd-usdc-amt-val">{usdcSend.usdc.toFixed(2)} USDC</span>
              <span className="wd-usdc-amt-sub">{t("wd.usdcToWallet")}</span>
            </div>
            <label className="wallet-label">{t("wd.destAddress")}</label>
            <div className="wd-usdc-addr">
              {address || "…"}
            </div>
            <p className="wallet-hint" style={{ marginTop: 8 }}>{t("wd.usdcOwnWalletNote")}</p>
            {error && <p className="error" style={{ textAlign: "center", marginTop: 10 }}>{error}</p>}
            <button className="btn" style={{ width: "100%", marginTop: 16 }}
              disabled={!address || !!busy} onClick={() => setUsdcStep("confirm")}>
              {t("common.continue")}
            </button>
          </div>
        )}

        {/* In-flight withdrawal warning — a new fiat withdraw is blocked while one
            is unsettled. Explain it and offer a self-service recover. */}
        {!usdcStep && inFlight > 0 && (
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

        {/* The withdraw FORM — hidden while stepping through the USDC flow. */}
        {!usdcStep && (
        <>
        {/* TWO balance figures, side by side, so the merchant sees at a glance
            what they HAVE (account balance = everything in the contract) vs what
            they can withdraw RIGHT NOW (matured/unlocked). The gap is funds still
            in the settlement window. Fiat previews use the on-chain SELL rate for
            the WITHDRAW currency (wdCountry/wdCode). */}
        <div className="wd-balances">
          <div className="wd-bal-box">
            <div className="wd-bal-label">{t("wd.accountBalance")}</div>
            <div className="wd-bal-amt">${accountNum.toFixed(2)}</div>
            <div className="wd-bal-sub">
              {accountFiat != null ? `≈ ${fmtFiat(wdCountry, accountFiat)} ${wdCode}` : "≈ —"}
            </div>
          </div>
          <div className="wd-bal-box">
            <div className="wd-bal-label">{t("wd.withdrawable")}</div>
            <div className="wd-bal-amt">${availNum.toFixed(2)}</div>
            <div className="wd-bal-sub">
              {availFiat != null ? `≈ ${fmtFiat(wdCountry, availFiat)} ${wdCode}` : "≈ —"}
            </div>
          </div>
        </div>
        {/* Funds still maturing → show how much and the REAL time until the next
            tranche unlocks (read from chain, not a hardcoded period). */}
        {pendingNum > 0 && (
          <div className="wd-maturity">
            {fmtUsdc(pending)} USDC {t("wd.settlingNote")}
            {nextUnlockSecs > 0 ? ` · ${t("wd.maturityNote")} (${fmtRemaining(nextUnlockSecs)})` : ""}
          </div>
        )}

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

        {/* STEP 1 — ask WHERE first: local currency (bank/UPI) or USDC wallet.
            Nothing currency- or UPI-specific is shown until this is answered,
            so a USDC withdrawal never has to wade through fiat/UPI fields. */}
        {!destChoice && (
          <div className="wd-dest-bar">
            <div className="wd-dest-head">{t("wd.chooseDest")}</div>
            <button className="wd-dest-btn"
              disabled={!ready || availNum <= 0}
              onClick={() => { setAmount(""); setDestChoice("fiat"); }}>
              <span className="wd-dest-ico"><Icon.Bank /></span>
              <span className="wd-dest-txt">
                <b>{t("wd.sendToBank")} {wdCountry?.fiat}</b>
                <small>{t("wd.destBankHint")}</small>
              </span>
              <span className="wd-dest-arrow">›</span>
            </button>
            <button className="wd-dest-btn usdc"
              disabled={!ready || availNum <= 0}
              onClick={() => { setAmount(""); setDestChoice("usdc"); }}>
              <span className="wd-dest-ico"><Icon.Wallet /></span>
              <span className="wd-dest-txt">
                <b>{t("wd.usdcTitle")}</b>
                <small>{t("wd.destUsdcHint")}</small>
              </span>
              <span className="wd-dest-arrow">›</span>
            </button>
          </div>
        )}

        {/* STEP 2, fiat path — amount, withdraw currency, and UPI/payout fields.
            Only ever shown after "Send to my UPI/bank" is chosen. */}
        {destChoice === "fiat" && (
          <>
            <button className="wallet-back" onClick={() => setDestChoice(null)}>
              <Icon.Back width="16" height="16" /> {t("wd.sendToBank")} {wdCountry?.fiat}
            </button>

            <div className="wd-card">
              <label className="wd-label">{t("wd.amount")} ({wdCode})</label>
              <div className="wd-amt-row">
                {/* Amount entered in LOCAL FIAT (₹/R$/…) with the currency symbol; the
                    USDC equivalent is shown small below. Uses the WITHDRAW currency
                    (wdCountry), which the on-chain sell price + settlement key off. */}
                <div className="wd-fiat-input" style={{ display: "flex", alignItems: "center", flex: 1, gap: 6 }}>
                  <span className="wd-fiat-sym" style={{ fontWeight: 700, color: "var(--muted)" }}>{wdCountry?.symbol}</span>
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
                opening the widget so it uses the right one. */}
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

            {/* If the merchant typed a fiat amount but the USDC↔fiat rate hasn't loaded,
                we can't convert it yet — show a hint and disable withdraw (rather than
                coercing the conversion to 0 and rejecting a valid amount). An empty
                (MAX) input needs no rate, so it stays enabled. */}
            {typedFiat !== "" && !sellPrice && !sellErr && (
              <p className="muted" style={{ textAlign: "center", fontSize: 12, marginTop: 10 }}>{t("wd.fetchingRate")}</p>
            )}
            {sellErr && (
              <p className="muted" style={{ textAlign: "center", fontSize: 12, marginTop: 10 }}>{sellErr}</p>
            )}

            <button className="btn" style={{ width: "100%", marginTop: 16 }}
              disabled={!!busy || !ready || availNum <= 0 || overBalance || (typedFiat !== "" && !sellPrice)}
              onClick={() => withdraw("fiat")}>
              {busy === "fiat" ? t("wd.working") : `${t("wd.sendToBank")} ${wdCountry?.fiat}`}
            </button>
          </>
        )}

        {/* STEP 2, USDC path — just the amount; destination is the merchant's own
            connected wallet, confirmed in the next step. No fiat/UPI fields at all. */}
        {destChoice === "usdc" && (
          <>
            <button className="wallet-back" onClick={() => setDestChoice(null)}>
              <Icon.Back width="16" height="16" /> {t("wd.usdcTitle")}
            </button>

            <div className="wd-card">
              <label className="wd-label">{t("wd.amount")} (USDC)</label>
              <div className="wd-amt-row">
                <div className="wd-fiat-input" style={{ display: "flex", alignItems: "center", flex: 1, gap: 6 }}>
                  <input className="input" type="number" min="0" step="0.01"
                    placeholder={availNum.toFixed(2)} value={amount}
                    onChange={(e) => setAmount(e.target.value)} style={{ flex: 1 }} />
                  <span className="wd-fiat-sym" style={{ fontWeight: 700, color: "var(--muted)" }}>USDC</span>
                </div>
                <button className="btn secondary small" type="button"
                  onClick={() => setAmount(availNum.toFixed(2))}>{t("wd.max")}</button>
              </div>
              {overBalance && <p className="error">{t("wd.exceeds")}</p>}
            </div>

            {error && <p className="error" style={{ textAlign: "center" }}>{error}</p>}
            {done && <p className="success" style={{ textAlign: "center" }}>✓ {done}</p>}

            <button className="btn" style={{ width: "100%", marginTop: 16 }}
              disabled={!!busy || !ready || availNum <= 0 || overBalance}
              onClick={() => withdraw("usdc")}>
              {t("common.continue")}
            </button>
          </>
        )}
        </>
        )}
      </div>

      {/* USDC WITHDRAW — STEP 3: final confirm dialog before the on-chain send. */}
      {usdcStep === "confirm" && (
        <div className="confirm-overlay" onClick={() => busy ? null : setUsdcStep("address")}>
          <div className="confirm-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-h">{t("wd.usdcConfirmTitle")}</div>
            <div className="confirm-amt">{usdcSend.usdc.toFixed(2)} USDC</div>
            <p className="confirm-sub">
              {t("wd.usdcConfirmBody")}
            </p>
            <div className="confirm-row">
              <span>{t("wd.destAddress")}</span>
              <b>{address ? `${address.slice(0, 8)}…${address.slice(-6)}` : "—"}</b>
            </div>
            {error && <p className="error" style={{ textAlign: "center", marginTop: 8 }}>{error}</p>}
            <div className="confirm-actions">
              <button className="btn ghost" disabled={!!busy} onClick={() => setUsdcStep("address")}>
                {t("common.cancel")}
              </button>
              <button className="btn" disabled={!!busy} onClick={confirmUsdcWithdraw}>
                {busy === "usdc" ? t("wd.working") : t("wd.usdcConfirmCta")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
