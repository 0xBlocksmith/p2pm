"use client";

import { createThirdwebClient, defineChain } from "thirdweb";
import { base, baseSepolia } from "thirdweb/chains";

/**
 * Central thirdweb setup. Replaces the old Privy + Pimlico stack.
 *
 * The merchant's on-chain identity is a thirdweb SMART ACCOUNT (ERC-4337),
 * created from an in-app wallet (email/social login). Gas is SPONSORED by the
 * thirdweb paymaster (sponsorGas: true), so the merchant transacts with 0 ETH —
 * same zero-ETH UX as before.
 *
 * REQUIRED env: NEXT_PUBLIC_THIRDWEB_CLIENT_ID
 *   Get it from thirdweb.com/dashboard → your project → Settings → Client ID.
 *   It is public (safe to ship to the browser), but LOCK IT DOWN in the
 *   dashboard: restrict it to your production domain(s) so nobody else can use
 *   your sponsorship quota.
 */
export const THIRDWEB_CLIENT_ID = process.env.NEXT_PUBLIC_THIRDWEB_CLIENT_ID || "";

export const thirdwebClient = createThirdwebClient({
  // A missing id is a hard misconfig — surface it clearly rather than failing
  // deep inside a wallet call. (Still constructs so the build succeeds.)
  clientId: THIRDWEB_CLIENT_ID || "MISSING_THIRDWEB_CLIENT_ID",
});

// Active chain mirrors lib/chain.ts (env-selected). Base Sepolia today.
export const THIRDWEB_CHAIN =
  process.env.NEXT_PUBLIC_CHAIN === "base" ? base : baseSepolia;
