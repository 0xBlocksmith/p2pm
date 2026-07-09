"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { usePublicClient } from "wagmi";
import { encodeFunctionData } from "viem";
import { useMerchant } from "../../components/useMerchant";
import { useRelayIdentity } from "../../components/useRelayIdentity";
import { Logo } from "../../components/Icons";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI } from "../../lib/contract";
import { encryptPayout } from "../../lib/payoutCrypto";
import { loadCountry, prefsSet } from "../../lib/countries";

/**
 * Registration only (country + language already chosen on /select). Shop name +
 * the country's payout field → registered ON-CHAIN via registerMerchant
 * (encPayoutId, shopName). The payout handle is encrypted CLIENT-SIDE
 * (encryptPayout) to the merchant's own relay key before it ever goes on-chain —
 * the raw UPI / PIX / CBU is never public. Gas sponsored — no wallet popups.
 */
export default function Onboarding() {
  const router = useRouter();
  const { ready, address, isRegistered, sendTransaction, refetchRegistered } = useMerchant({
    requireRegistered: false,
  });
  const { getIdentity } = useRelayIdentity();
  const publicClient = usePublicClient();

  const [country, setCountry] = useState(null);
  const [payoutId, setPayoutId] = useState("");
  const [shopName, setShopName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // TEMP diagnostic: the raw on-chain/AA reason, shown on-screen so it can be
  // captured without a device console. Remove once registration is confirmed.
  const [debugRaw, setDebugRaw] = useState("");

  // Keep the latest sendTransaction in a ref so the submit poll loop sees the
  // smart wallet becoming ready (the value changes after first render).
  const sendRef = useRef(sendTransaction);
  useEffect(() => { sendRef.current = sendTransaction; }, [sendTransaction]);

  useEffect(() => {
    // Country/language must be chosen first.
    if (!prefsSet()) { router.replace("/login"); return; }
    setCountry(loadCountry());
  }, [router]);

  // Already registered → go to dashboard (only once we actually know).
  useEffect(() => {
    if (isRegistered === true) router.replace("/dashboard");
  }, [isRegistered, router]);

  // Read the on-chain `registered` flag FRESH (bypassing the cached wagmi query),
  // so we never act on a stale `false`. Returns true/false, or null if the read
  // itself fails (treat as "unknown", don't block on it).
  async function isRegisteredOnchain() {
    if (!publicClient || !address) return null;
    try {
      return await publicClient.readContract({
        address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI,
        functionName: "registered", args: [address],
      } as any) as boolean;
    } catch { return null; }
  }

  async function submit(e) {
    e.preventDefault();
    setError("");
    setDebugRaw("");
    if (!shopName.trim()) return setError("Enter your shop name.");
    if (!country.validatePayout(payoutId.trim())) {
      return setError(`Enter a valid ${country.payoutLabel} (like ${country.payoutPlaceholder}).`);
    }
    setBusy(true);
    try {
      // A previous attempt may have actually landed on-chain even if its receipt
      // wait timed out — in which case re-submitting reverts with AlreadyRegistered
      // (surfaced opaquely as "Execution Reverted: {}"). Check the live flag first
      // and just continue to the terminal if we're already set up.
      if (await isRegisteredOnchain()) {
        try { await refetchRegistered?.(); } catch {}
        router.replace("/qr");
        return;
      }
      // Wait for the smart wallet to initialise (it can take a few seconds on
      // first login). Read via ref so we see it appear.
      let tries = 0;
      while (!sendRef.current && tries < 40) {
        await new Promise((r) => setTimeout(r, 400));
        tries++;
      }
      const send = sendRef.current;
      if (!send) {
        setBusy(false);
        return setError("Your gas-free wallet is still connecting. Wait a moment and try again.");
      }

      // Encrypt the payout handle CLIENT-SIDE to the merchant's own relay key —
      // the raw UPI/PIX id must never go on-chain in plaintext (it's PII). The
      // contract stores the opaque ciphertext blob.
      const identity = await getIdentity();
      const encPayout = await encryptPayout(payoutId.trim(), identity);

      // The new contract locks the offramp currency at registration, so we pass
      // the chosen country's ISO code (e.g. "INR"/"BRL"/"ARS") as the 3rd arg.
      const data = encodeFunctionData({
        abi: INTEGRATOR_ABI,
        functionName: "registerMerchant",
        args: [encPayout, shopName.trim(), country.code],
      });
      const hash = await send({ to: CONTRACT_ADDRESS, data });

      // Confirm the receipt; surface an on-chain revert instead of silently
      // routing on to /qr (which would bounce back here as still-unregistered).
      try {
        const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
        if (receipt?.status === "reverted") {
          setBusy(false);
          return setError("Registration failed on-chain. Please try again.");
        }
      } catch {
        // Receipt slow? Fall through — the refetched `registered` flag confirms it.
      }
      // Refresh the cached `registered` read BEFORE navigating. /qr reads the same
      // wagmi query key; without this it sees the stale `false` and bounces the
      // merchant back to onboarding → dashboard instead of the terminal.
      try { await refetchRegistered?.(); } catch {}
      // They came here from "Accept Payment" — continue to the terminal.
      router.replace("/qr");
    } catch (err) {
      // Log the FULL error object — thirdweb/bundler nests the real reason
      // (paymaster declined, account-deploy failure, revert reason) in fields that
      // the flattened string below often loses. Essential for diagnosing the
      // opaque "Execution Reverted: {}" that the AA path produces.
      console.error("register failed (full):", err);
      try { console.error("register failed (json):", JSON.stringify(err, Object.getOwnPropertyNames(err || {}))); } catch {}
      const raw = String(
        err?.shortMessage || err?.details || err?.reason ||
        err?.cause?.shortMessage || err?.cause?.message || err?.message || ""
      );
      // TEMP: surface the deepest detail on-screen for diagnosis (data field,
      // cause chain, metaMessages) — not just the flattened one-liner.
      try {
        const parts = [
          err?.name, err?.shortMessage, err?.details, err?.reason,
          err?.data, err?.cause?.shortMessage, err?.cause?.message, err?.cause?.data,
          Array.isArray(err?.metaMessages) ? err.metaMessages.join(" | ") : "",
          err?.message,
        ].filter(Boolean);
        setDebugRaw([...new Set(parts.map(String))].join("\n").slice(0, 800));
      } catch { setDebugRaw(String(err?.message || err || "")); }
      // The revert might be AlreadyRegistered — meaning a prior attempt DID land.
      // The AA/RPC path often strips the custom-error data, so this surfaces as an
      // opaque "Execution Reverted: {}". Re-check the live flag: if we're actually
      // registered, this "failure" is a success we just couldn't read — go on.
      if (/revert|reverted|already/i.test(raw)) {
        if (await isRegisteredOnchain()) {
          try { await refetchRegistered?.(); } catch {}
          router.replace("/qr");
          return;
        }
      }
      if (/User rejected|reject|denied/i.test(raw)) {
        setError("Cancelled.");
      } else if (/5\d\d|522|504|timed out|timeout|Unexpected token|not valid JSON|network|fetch failed/i.test(raw)) {
        // Transient thirdweb bundler/paymaster infra error (already auto-retried).
        setError("Network hiccup reaching the gas-free wallet service. Please tap again in a moment.");
      } else if (/revert|reverted/i.test(raw)) {
        // A real on-chain revert whose reason the RPC didn't return (empty data →
        // "{}"). Don't show the raw "{}" — give an actionable message.
        setError("Setup couldn't be completed on-chain. Please check your details and try again.");
      } else {
        setError(`Setup failed: ${raw || "please try again"}`);
      }
      setBusy(false);
    }
  }

  if (!country) {
    return <div className="onb-screen"><p className="muted">Loading…</p></div>;
  }

  return (
    <div className="onb-screen">
      <div className="onb-card">
        <div className="brand login-brand" style={{ marginBottom: 14 }}>
          <Logo size={28} className="brand-mark" /> PayQR
        </div>
        <h1 className="onb-h1">Set up<br />your shop</h1>
        <p className="muted onb-sub">
          {country.flag} {country.name} · you’re paid out in {country.code} ({country.fiat}).
        </p>
        <form onSubmit={submit}>
          <div className="field">
            <label>SHOP NAME</label>
            <input
              className="input"
              value={shopName}
              onChange={(e) => setShopName(e.target.value)}
              placeholder="My Shop"
            />
          </div>
          <div className="field">
            <label>{country.payoutLabel.toUpperCase()} (WHERE PAYOUTS LAND)</label>
            <input
              className="input"
              value={payoutId}
              onChange={(e) => setPayoutId(e.target.value)}
              placeholder={country.payoutPlaceholder}
            />
          </div>
          <p className="muted" style={{ fontSize: 12, marginBottom: 14 }}>
            Gas-free — we cover all network fees.
          </p>
          <button className="btn" disabled={busy} type="submit" style={{ width: "100%" }}>
            {busy ? "Setting up…" : ready ? "Open my terminal" : "Open my terminal"}
          </button>
          {!ready && !busy && (
            <p className="muted" style={{ fontSize: 11.5, textAlign: "center", marginTop: 6 }}>
              Connecting your gas-free wallet…
            </p>
          )}
          {error && <p className="error">{error}</p>}
          {debugRaw && (
            <pre style={{
              fontSize: 10.5, lineHeight: 1.35, whiteSpace: "pre-wrap", wordBreak: "break-word",
              background: "rgba(0,0,0,0.05)", color: "#b00", padding: "8px 10px",
              borderRadius: 8, marginTop: 8, maxHeight: 180, overflow: "auto",
            }}>
              {debugRaw}
            </pre>
          )}
          <button
            type="button"
            className="onb-back"
            onClick={() => router.replace("/login")}
            disabled={busy}
          >
            ‹ Change country / language
          </button>
        </form>
      </div>
    </div>
  );
}
