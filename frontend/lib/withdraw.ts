/**
 * Withdrawal adapter — isolates the contract call so every page is
 * currency-agnostic (the pages call buildFiatWithdraw / buildFiatWithdrawIn and
 * never touch an ABI).
 *
 * HOME withdraw (merchant's REGISTERED currency):
 *   • `withdrawFiat(amount, circleId, payoutOverride)` — the contract reads the
 *     registered currency from the merchant's profile, so it's generic for
 *     every country. We resolve the circle for THAT country.
 *
 * CROSS-CURRENCY withdraw (a currency you ACCEPTED but didn't register):
 *   • `withdrawFiatIn(amount, circleId, currency, payoutHandle)` — see
 *     buildFiatWithdrawIn below.
 */
import { encodeFunctionData } from "viem";
import { INTEGRATOR_ABI } from "./contract";
import { resolveCircleId, codeToHex } from "./p2p";

/**
 * Build the calldata for a HOME-currency fiat withdrawal (the merchant's
 * registered currency = `country`). The contract reads the registered currency
 * from the merchant's on-chain profile, so this single `withdrawFiat` call is
 * correct for every country (INR / BRL / ARS / …) — only the circle differs.
 * Resolves that country's live circle (never a hardcoded INR circle).
 * Returns { data } ready for sendTransaction({ to: CONTRACT_ADDRESS, data }).
 */
export async function buildFiatWithdraw({ amountRaw, country, payoutOverride = "" }) {
  const circleId = await resolveCircleId(country.code);
  if (circleId == null) throw new Error(`No live circle for ${country.code} yet.`);
  const data = encodeFunctionData({
    abi: INTEGRATOR_ABI,
    functionName: "withdrawFiat",
    args: [amountRaw, circleId, payoutOverride],
  });
  return { data };
}

/**
 * GENERIC cross-currency fiat withdrawal — cash out in ANY supported currency
 * (e.g. withdraw BRL you accepted, even though you registered INR). Resolves the
 * currency's live circle from the subgraph and calls the new `withdrawFiatIn`.
 * Throws if the protocol has no circle for that currency (caller should guard).
 * @param code   ISO currency code, e.g. "BRL"
 * @param payout the payout handle for that currency (PIX/UPI/CBU)
 */
export async function buildFiatWithdrawIn({ amountRaw, code, payout }) {
  const circleId = await resolveCircleId(code);
  if (circleId == null) throw new Error(`No live circle for ${code} yet.`);
  const data = encodeFunctionData({
    abi: INTEGRATOR_ABI,
    functionName: "withdrawFiatIn",
    args: [amountRaw, circleId, codeToHex(code) as `0x${string}`, payout],
  });
  return { data };
}

/** USDC-to-wallet withdrawal — currency-agnostic, unchanged across versions. */
export function buildUsdcWithdraw({ amountRaw }) {
  const data = encodeFunctionData({
    abi: INTEGRATOR_ABI,
    functionName: "withdrawUSDC",
    args: [amountRaw],
  });
  return { data };
}
