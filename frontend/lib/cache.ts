/**
 * Caching helpers — for data that is STATIC per session only.
 *
 * IMPORTANT: never cache live financial data here. Balances, daily-tx info,
 * settlement buckets, in-flight withdrawal state, exchange rates, and
 * transaction/order lists must stay fresh (they already poll or use no-store).
 * This file is exclusively for values that don't change during a session:
 * the merchant's registration bool, shop profile, registered currency, contract
 * owner, and derived proxy address.
 */

// react-query staleTime for reads that are effectively constant for the
// session. With this set, useReadContract won't re-hit the RPC on every page
// mount — it serves the cached value and only refetches when it genuinely goes
// stale (e.g. after the window has been backgrounded for a long while).
export const STATIC_STALE_MS = 5 * 60 * 1000; // 5 min

// ── Merchant profile: persisted to localStorage for INSTANT first paint ──
// getMerchantInfo returns (payoutId, shopName, currency-bytes32, registered,
// frozen). Only the non-financial identity fields are cached; balances are
// never stored. On next load the shop name / currency render immediately from
// localStorage while the fresh on-chain read confirms in the background.

const PROFILE_KEY_PREFIX = "payqr.merchantProfile:";

export type MerchantProfile = {
  payoutId: string;
  shopName: string;
  currency: string; // bytes32 hex, as returned by getMerchantInfo()[2]
  registered: boolean;
};

/** Load the cached profile for an address, or null. Address-keyed so switching
 *  accounts never shows the previous merchant's shop name. */
export function loadMerchantProfile(address?: string): MerchantProfile | null {
  if (typeof window === "undefined" || !address) return null;
  try {
    const raw = localStorage.getItem(PROFILE_KEY_PREFIX + address.toLowerCase());
    return raw ? (JSON.parse(raw) as MerchantProfile) : null;
  } catch {
    return null;
  }
}

/** Persist the profile for an address. No-op if the info tuple is missing. */
export function saveMerchantProfile(address: string | undefined, info: any): void {
  if (typeof window === "undefined" || !address || !info) return;
  try {
    const profile: MerchantProfile = {
      payoutId: info[0] ?? "",
      shopName: info[1] ?? "",
      currency: info[2] ?? "",
      registered: info[3] === true,
    };
    localStorage.setItem(PROFILE_KEY_PREFIX + address.toLowerCase(), JSON.stringify(profile));
  } catch {
    /* storage full / disabled — non-fatal, we just fall back to the live read */
  }
}

/** Wipe every cached merchant profile (call on logout / account switch). */
export function clearMerchantProfiles(): void {
  if (typeof window === "undefined") return;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PROFILE_KEY_PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}
