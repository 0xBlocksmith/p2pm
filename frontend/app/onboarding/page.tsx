"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { usePublicClient } from "wagmi";
import { encodeFunctionData } from "viem";
import { useMerchant } from "../../components/useMerchant";
import { Logo } from "../../components/Icons";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI } from "../../lib/contract";
import { loadCountry, prefsSet } from "../../lib/countries";

/**
 * Registration only (country + language already chosen on /select). Shop name +
 * the country's payout field → registered ON-CHAIN via registerMerchant
 * (payoutId, shopName). The payout id is a generic string, so UPI / PIX / CBU
 * all fit today. Gas sponsored — no wallet popups.
 */
export default function Onboarding() {
  const router = useRouter();
  const { ready, address, isRegistered, sendTransaction, refetchRegistered } = useMerchant({
    requireRegistered: false,
  });
  const publicClient = usePublicClient();

  const [country, setCountry] = useState(null);
  const [payoutId, setPayoutId] = useState("");
  const [shopName, setShopName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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

  async function submit(e) {
    e.preventDefault();
    setError("");
    if (!shopName.trim()) return setError("Enter your shop name.");
    if (!country.validatePayout(payoutId.trim())) {
      return setError(`Enter a valid ${country.payoutLabel} (like ${country.payoutPlaceholder}).`);
    }
    setBusy(true);
    try {
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

      // The new contract locks the offramp currency at registration, so we pass
      // the chosen country's ISO code (e.g. "INR"/"BRL"/"ARS") as the 3rd arg.
      const data = encodeFunctionData({
        abi: INTEGRATOR_ABI,
        functionName: "registerMerchant",
        args: [payoutId.trim(), shopName.trim(), country.code],
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
      console.error("register failed:", err);
      const msg = err?.shortMessage || err?.details || err?.message || "Setup failed";
      setError(msg.includes("User rejected") ? "Cancelled." : `Setup failed: ${msg}`);
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
