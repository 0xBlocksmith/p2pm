/**
 * On-chain checkout pricing — so the customer pays EXACTLY the fiat the merchant
 * quoted (e.g. ₹500), with all USDC↔fiat spread/fees absorbed on the merchant's
 * USDC side.
 *
 * The p2p.me <Checkout> widget derives the fiat the customer sees & pays from
 * the on-chain price config, NOT from anything we hand it as a display string:
 *
 *     chargedFiat = usdcAmount * buyPrice / 1e6
 *     feeUsdc     = (usdcAmount <= smallOrderThreshold) ? smallOrderFixedFee : 0
 *     feeFiat     = feeUsdc * buyPrice / 1e6
 *     totalFiat   = chargedFiat + feeFiat          // what the customer pays
 *
 * If we size usdcAmount from our own estimate rate (lib/rates.ts) it won't match
 * the Diamond's live buyPrice, so a ₹500 quote renders as ~₹492. To pin the
 * customer's total to the quote we must INVERT the widget's formula against the
 * SAME on-chain numbers it reads, and size usdcAmount so totalFiat == quote:
 *
 *     usdcAmount = round(quoteFiat6 * 1e6 / buyPrice) - feeUsdc
 *
 * This reads getPriceConfig / getSmallOrderThreshold / getSmallOrderFixedFeeBuy
 * off the Diamond exactly like the widget (checkout.js) does, so the preview
 * screen, the accepted "Pay exactly X" screen, the UPI deep-link, and SDK
 * routing all land on the quoted fiat.
 */
import { createPublicClient, http, stringToHex, parseAbi } from "viem";
import { ACTIVE_CHAIN, RPC_URL } from "./chain";
import { DIAMOND_ADDRESS } from "./p2p";

// Minimal slice of the Diamond ABI — only the reads the widget uses to price a
// BUY. Mirrors @p2pdotme/widgets' DIAMOND_ABI (getPriceConfig tuple + the V22
// per-order-type small-order fee selector, with a pre-V22 unified fallback).
const PRICE_ABI = parseAbi([
  "struct PriceConfig { uint256 buyPrice; uint256 sellPrice; int256 buyPriceOffset; uint256 baseSpread; }",
  "function getPriceConfig(bytes32 currency) view returns (PriceConfig)",
  "function getSmallOrderThreshold(bytes32 currency) view returns (uint256)",
  "function getSmallOrderFixedFeeBuy(bytes32 currency) view returns (uint256)",
  "function getSmallOrderFixedFee(bytes32 currency) view returns (uint256)", // deprecated unified (pre-V22)
]);

const reader = createPublicClient({ chain: ACTIVE_CHAIN, transport: http(RPC_URL) });

export type PriceConfig = {
  buyPrice: bigint;            // 6-dec fiat per USDC
  smallOrderThreshold: bigint; // 6-dec USDC; orders <= this pay the fixed fee
  smallOrderFixedFee: bigint;  // 6-dec USDC (BUY pays half the unified fee)
};

/** BUY small-order fee — typed V22 selector, fall back to the unified one. */
async function readBuyFixedFee(currencyHex: `0x${string}`): Promise<bigint> {
  try {
    return (await reader.readContract({
      address: DIAMOND_ADDRESS as `0x${string}`, abi: PRICE_ABI,
      functionName: "getSmallOrderFixedFeeBuy", args: [currencyHex],
    } as any)) as bigint;
  } catch {
    try {
      return (await reader.readContract({
        address: DIAMOND_ADDRESS as `0x${string}`, abi: PRICE_ABI,
        functionName: "getSmallOrderFixedFee", args: [currencyHex],
      } as any)) as bigint;
    } catch {
      return 0n;
    }
  }
}

/**
 * Read the live on-chain price config for a currency code ("INR", "BRL", …).
 * Returns null if the Diamond isn't configured/reachable (caller falls back to
 * the estimate-rate path so the terminal still works).
 */
export async function fetchPriceConfig(code: string): Promise<PriceConfig | null> {
  if (!DIAMOND_ADDRESS) return null;
  const currencyHex = stringToHex(code, { size: 32 });
  try {
    const [price, threshold, fixedFee] = await Promise.all([
      reader.readContract({
        address: DIAMOND_ADDRESS as `0x${string}`, abi: PRICE_ABI,
        functionName: "getPriceConfig", args: [currencyHex],
      } as any),
      reader.readContract({
        address: DIAMOND_ADDRESS as `0x${string}`, abi: PRICE_ABI,
        functionName: "getSmallOrderThreshold", args: [currencyHex],
      } as any),
      readBuyFixedFee(currencyHex),
    ]);
    const buyPrice = (price as any).buyPrice as bigint;
    if (!buyPrice || buyPrice <= 0n) return null;
    return {
      buyPrice,
      smallOrderThreshold: threshold as bigint,
      smallOrderFixedFee: fixedFee,
    };
  } catch {
    return null;
  }
}

/**
 * Size the USDC amount so the customer's on-chain total lands EXACTLY on the
 * quoted fiat. `quoteFiat` is the plain fiat number the merchant typed (e.g.
 * 500 for ₹500). Returns 6-dec `usdcAmount`, or null if it can't be priced.
 *
 * Inverts the widget's totalFiat = usdcAmount*buyPrice/1e6 + feeUsdc*buyPrice/1e6.
 * The fee only applies to small orders (usdcAmount <= threshold), so we solve
 * once assuming the fee applies, then drop it if the result is above threshold
 * and re-solve without it — matching the widget's own conditional exactly.
 */
export function usdcForFiat(quoteFiat: number, cfg: PriceConfig): bigint {
  const quoteFiat6 = BigInt(Math.round(quoteFiat * 1e6)); // 6-dec fiat
  const { buyPrice, smallOrderThreshold, smallOrderFixedFee } = cfg;

  // grossUsdc solves usdcAmount*buyPrice/1e6 == quoteFiat6 (before backing out a fee).
  const grossUsdc = (quoteFiat6 * 1_000_000n) / buyPrice;

  // Assume the fee applies (typical POS small order): back it out so that
  // (usdcAmount + fee)*buyPrice/1e6 == quoteFiat6.
  let usdc = grossUsdc > smallOrderFixedFee ? grossUsdc - smallOrderFixedFee : grossUsdc;

  // If that lands ABOVE the small-order threshold, no fee is actually charged —
  // re-solve without the fee so we don't undershoot the quote.
  if (usdc > smallOrderThreshold) usdc = grossUsdc;

  return usdc > 0n ? usdc : 0n;
}
