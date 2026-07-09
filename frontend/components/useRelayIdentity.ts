"use client";

import { useCallback } from "react";
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

// The p2p SDK/widget's OWN relay-identity store key. The widget places (via its
// internal path) and — crucially — DECRYPTS the LP's payout handle using the
// identity in THIS global slot (createLocalStorageRelayStore's DEFAULT_KEY). Our
// checkout, however, PLACES the order with our PER-ADDRESS key (see
// lib/p2p.ts makePlaceOrder → userPlaceOrder pubKey). If the two differ, the LP
// encrypts to our key but the widget decrypts with this one → decryption fails
// and the widget shows the literal fallback string "Session changed" in the PIX/
// UPI field instead of the real handle. We fix that by mirroring our per-address
// identity INTO this slot before the widget mounts, so place-key == decrypt-key.
const SDK_GLOBAL_KEY = "@P2PME:RELAY_IDENTITY";

export function useRelayIdentity() {
  const { address } = useSmartAccount();

  // Memoized on `address` so consumers can safely use it in a useEffect dep array
  // without the effect re-firing every render (which would re-import the SDK and
  // re-decrypt the saved payout on every 1s ticker tick — see settings/withdraw).
  const getIdentity = useCallback(async () => {
    if (!address) throw new Error("Wallet not connected — cannot create a relay identity.");
    const { createRelayIdentity } = await import("@p2pdotme/sdk/orders");
    const storeKey = KEY_PREFIX + address.toLowerCase();

    // Read our per-address slot.
    let identity: any = null;
    try {
      const raw = localStorage.getItem(storeKey);
      if (raw) identity = JSON.parse(raw);
    } catch { identity = null; }

    // Create + persist if missing OR incomplete. We require all THREE fields the
    // SDK validates (address, publicKey, privateKey) — an identity missing any of
    // them (e.g. an older key written before `address` was included) fails the
    // SDK's schema downstream and blocks every order, so treat it as corrupt and
    // regenerate a full, valid keypair.
    if (!identity || !identity.address || !identity.publicKey || !identity.privateKey) {
      identity = createRelayIdentity();
      try { localStorage.setItem(storeKey, JSON.stringify(identity)); } catch {}
    }
    return identity;
  }, [address]);

  // Mirror our per-address identity into the SDK/widget GLOBAL slot so the widget
  // decrypts the LP's payout with the SAME key we placed the order with (fixes the
  // "Session changed" placeholder — see SDK_GLOBAL_KEY note above). Call this right
  // before mounting <Checkout>/<Cashout>. Idempotent: only writes when the stored
  // global key differs, so it won't thrash the widget's cached identity.
  const syncToSdkStore = useCallback(async () => {
    const identity = await getIdentity();
    if (!identity?.publicKey || !identity?.privateKey) return;
    try {
      const existing = localStorage.getItem(SDK_GLOBAL_KEY);
      // Write the FULL identity shape the SDK validates against
      // (ZodRelayIdentitySchema = { address, publicKey, privateKey }). Writing only
      // {publicKey, privateKey} — dropping `address` — makes the SDK's safeParse
      // FAIL with "Stored relay identity failed validation", which it surfaces (very
      // misleadingly) as ROUTING_NO_MERCHANTS and blocks EVERY order. `address` is
      // required and must pass viem isAddress, so mirror all three fields verbatim.
      const desired = JSON.stringify({
        address: identity.address,
        publicKey: identity.publicKey,
        privateKey: identity.privateKey,
      });
      if (existing !== desired) localStorage.setItem(SDK_GLOBAL_KEY, desired);
    } catch { /* localStorage unavailable — nothing we can do */ }
    return identity;
  }, [getIdentity]);

  return { getIdentity, syncToSdkStore };
}
// Note: clearing on logout/account-switch is centralized in
// lib/countries.ts:clearLocalUserData and useAuth's account-switch guard — both
// wipe payqr.relay:* and the widget's global @P2PME:RELAY_IDENTITY key.
