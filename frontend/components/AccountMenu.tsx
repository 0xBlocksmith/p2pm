"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useReadContract } from "wagmi";
import { useSmartAccount } from "./useSmartAccount";
import { useAuth } from "./useAuth";
import { clearLocalUserData } from "../lib/countries";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, fmtUsdc } from "../lib/contract";

/**
 * Top-right avatar. Tap to reveal a dropdown with the smart wallet address
 * (copy), balance, and logout. Replaces the old Wallet nav tab.
 */
export function AccountMenu() {
  const router = useRouter();
  const { logout, email } = useAuth();
  const { address } = useSmartAccount();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);

  const { data: balance } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: INTEGRATOR_ABI,
    functionName: "getMerchantBalance",
    args: [address],
    query: { enabled: !!address, refetchInterval: 30000 },
  });
  const [pending, available] = balance ?? [0n, 0n];

  useEffect(() => {
    function onDoc(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const initial = (email || "M").slice(0, 1).toUpperCase();

  function copy() {
    if (!address) return;
    navigator.clipboard?.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className="acct" ref={ref}>
      <button className="avatar" onClick={() => setOpen((o) => !o)} aria-label="Account">
        {initial}
      </button>

      {open && (
        <div className="acct-pop">
          <div className="acct-head">
            <div className="avatar lg">{initial}</div>
            <div className="acct-id">
              {email && <div className="acct-email">{email}</div>}
              <button className="acct-addr" onClick={copy} title="Copy address" disabled={!address}>
                {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "connecting…"}
                {address && (
                  <span className="muted" style={{ marginLeft: 6 }}>{copied ? "copied ✓" : "⧉"}</span>
                )}
              </button>
            </div>
          </div>

          <div className="acct-bal">
            <div>
              <div className="muted" style={{ fontSize: 12 }}>Available</div>
              <strong>{fmtUsdc(available)} USDC</strong>
            </div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>Locked</div>
              <strong>{fmtUsdc(pending)} USDC</strong>
            </div>
          </div>

          <Link className="acct-menu-link" href="/settings" onClick={() => setOpen(false)}>Settings</Link>

          <button
            className="btn secondary small"
            style={{ width: "100%" }}
            onClick={() => { setOpen(false); clearLocalUserData(); logout().finally(() => router.replace("/login")); }}
          >
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
