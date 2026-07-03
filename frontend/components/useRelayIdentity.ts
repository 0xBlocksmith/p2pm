"use client";

import { useSmartAccount } from "./useSmartAccount";

/**
 * Lazily creates + persists the p2p relay identity (the keypair whose pubkey the
 * LP encrypts the payout details to) — SCOPED TO THE CONNECTED SMART-ACCOUNT
 * ADDRESS.
 *
 * SECURITY: the relay identity must never be shared across merchants on a shared
 * device. The p2p SDK's default store is a single global localStorage slot, so a
 * merchant who didn't formally log out could leave their key behind for the next
 * account to silently reuse — meaning merchant B's payout details would get
 * encrypted to merchant A's key (A could then decrypt B's UPI/PIX handle). To
 * make that impossible, we key the identity by the connected address: each
 * merchant gets their OWN keypair, and switching accounts can never adopt a stale
 * one. (clearLocalUserData still wipes them on logout as defence-in-depth.)
 */
const KEY_PREFIX = "payqr.relay:"; // + lowercased smart-account address

export function useRelayIdentity() {
  const { address } = useSmartAccount();

  async function getIdentity() {
    if (!address) throw new Error("Wallet not connected — cannot create a relay identity.");
    const { createRelayIdentity } = await import("@p2pdotme/sdk/orders");
    const storeKey = KEY_PREFIX + address.toLowerCase();

    // Read our per-address slot.
    let identity: any = null;
    try {
      const raw = localStorage.getItem(storeKey);
      if (raw) identity = JSON.parse(raw);
    } catch { identity = null; }

    // Create + persist if missing or corrupt.
    if (!identity || !identity.publicKey || !identity.privateKey) {
      identity = createRelayIdentity();
      try { localStorage.setItem(storeKey, JSON.stringify(identity)); } catch {}
    }
    return identity;
  }

  return { getIdentity };
}
// Note: clearing on logout/account-switch is centralized in
// lib/countries.ts:clearLocalUserData and useAuth's account-switch guard — both
// wipe payqr.relay:* and the widget's global @P2PME:RELAY_IDENTITY key.
