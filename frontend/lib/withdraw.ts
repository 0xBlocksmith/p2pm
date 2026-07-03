/**
 * Withdrawal adapter — isolates the contract call so pages never touch an ABI.
 *
 * Only the USDC-to-wallet withdrawal is built here. The FIAT (SELL) withdrawal is
 * handled end-to-end by the official @p2pdotme Cashout widget (CashoutWidget),
 * which supplies its OWN relay identity/pubkey and does the encryption + delivery.
 * The old buildFiatWithdraw / buildFiatWithdrawIn / getRelayPubKey helpers were
 * removed: they were unused (dead code) and reading the relay keypair here was a
 * cross-account leak surface on a shared device.
 */
import { encodeFunctionData } from "viem";
import { INTEGRATOR_ABI } from "./contract";

/** USDC-to-wallet withdrawal — currency-agnostic. */
export function buildUsdcWithdraw({ amountRaw }: { amountRaw: bigint }) {
  const data = encodeFunctionData({
    abi: INTEGRATOR_ABI,
    functionName: "withdrawUSDC",
    args: [amountRaw],
  });
  return { data };
}
