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
  buyPrice: bigint;            // 6-dec fiat per USDC — what a CUSTOMER pays to buy (checkout)
  sellPrice: bigint;           // 6-dec fiat per USDC — what a MERCHANT gets cashing OUT (withdraw)
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
    const sellPrice = ((price as any).sellPrice as bigint) ?? 0n;
    if (!buyPrice || buyPrice <= 0n) return null;
    return {
      buyPrice,
      sellPrice,
      smallOrderThreshold: threshold as bigint,
      smallOrderFixedFee: fixedFee,
    };
  } catch {
    return null;
  }
}

// Our integrator prices in whole USDC CENTS (product-2 units = 0.01 USDC) — the
// on-chain `quantity` can't represent anything finer, so usdcAmount must always
// be a multiple of this.
const USDC_CENT = 10_000n; // 6-dec units

/**
 * Size the USDC amount so the customer's on-chain total lands as close as
 * possible to the quoted fiat. `quoteFiat` is the plain fiat number the
 * merchant typed (e.g. 500 for ₹500). Returns 6-dec `usdcAmount`, already
 * snapped to a whole USDC cent (the only granularity the contract accepts),
 * or null if it can't be priced.
 *
 * Inverts the widget's totalFiat = usdcAmount*buyPrice/1e6 + feeUsdc*buyPrice/1e6.
 * The fee only applies to small orders (usdcAmount <= threshold), so we solve
 * once assuming the fee applies, then drop it if the result is above threshold
 * and re-solve without it — matching the widget's own conditional exactly.
 *
 * The exact-fiat solution is rarely a whole cent, and rounding it naively (as
 * we used to, in the caller, after this function returned) can drift the
 * displayed total by up to half a cent of USDC — at low buyPrice currencies
 * that's nearly a full unit of fiat (e.g. ~₹0.91 at 91 INR/USDC), which read
 * as "the total doesn't match what I typed" on small orders. Snap to the
 * nearest cent HERE instead, checking both neighbours against the actual
 * resulting fiat total (including the fee's own threshold flip), so the
 * final total is the closest a whole-cent amount can get to the quote.
 */
export function usdcForFiat(quoteFiat: number, cfg: PriceConfig): bigint {
  const quoteFiat6 = BigInt(Math.round(quoteFiat * 1e6)); // 6-dec fiat
  const { buyPrice, smallOrderThreshold, smallOrderFixedFee } = cfg;

  // Exact-fiat usdc solving totalFiat == quoteFiat6, before snapping to a cent.
  const grossUsdc = (quoteFiat6 * 1_000_000n) / buyPrice;
  let usdc = grossUsdc > smallOrderFixedFee ? grossUsdc - smallOrderFixedFee : grossUsdc;
  if (usdc > smallOrderThreshold) usdc = grossUsdc;
  if (usdc <= 0n) return 0n;

  // What the customer actually pays for a given (already cent-snapped) usdc
  // amount, mirroring the widget's own preview math exactly.
  const totalFiatFor = (u: bigint) => {
    const feeUsdc = u > 0n && u <= smallOrderThreshold ? smallOrderFixedFee : 0n;
    return u * buyPrice / 1_000_000n + feeUsdc * buyPrice / 1_000_000n;
  };

  const lo = (usdc / USDC_CENT) * USDC_CENT;
  const hi = lo + USDC_CENT;
  if (lo <= 0n) return hi;
  const loDiff = quoteFiat6 > totalFiatFor(lo) ? quoteFiat6 - totalFiatFor(lo) : totalFiatFor(lo) - quoteFiat6;
  const hiDiff = totalFiatFor(hi) > quoteFiat6 ? totalFiatFor(hi) - quoteFiat6 : quoteFiat6 - totalFiatFor(hi);
  return hiDiff < loDiff ? hi : lo;
}
