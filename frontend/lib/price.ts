/**
 * ON-CHAIN pricing for the POS terminal — the SINGLE source of truth.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Accept page used to estimate USDC off-chain (lib/rates.ts: a subgraph
 * average / CoinGecko / static fallback), while the p2p.me checkout widget's
 * "Order Summary" re-prices the same order against the Diamond's ON-CHAIN
 * `getPriceConfig().buyPrice`. Two unconnected rates → the two screens showed
 * different USDC (e.g. ₹1000 → 12.48 here vs 10.99 there). See ISSUE-price-mismatch.md.
 *
 * This module reads the EXACT same on-chain values the widget reads
 * (getPriceConfig.buyPrice, getSmallOrderThreshold, small-order BUY fixed fee)
 * and derives the merchant's USDC from the typed fiat by INVERTING the widget's
 * own formula. Because both screens now key off `buyPrice`, they agree.
 *
 * THE WIDGET'S MODEL (checkout.js, verbatim math)
 * -----------------------------------------------
 *   fiat(6-dec)  = usdcAmount(6-dec) * buyPrice / 1e6          // buyPrice = fiat-per-USDC, 6-dec fixed point
 *   feeUsdc      = usdcAmount <= smallOrderThreshold ? smallOrderFixedFee : 0
 *   totalFiat    = fiat + feeUsdc * buyPrice / 1e6             // what the CUSTOMER pays
 *   creditedUsdc = usdcAmount - feeUsdc                        // what the MERCHANT keeps
 *
 * We invert the first line to go fiat → usdc:
 *   usdcAmount   = fiat * 1e6 / buyPrice
 * and quantize to the product's 0.01-USDC unit (same as qr/page.tsx), then
 * report the fee-adjusted "you keep".
 */
import { createPublicClient, http, stringToHex } from "viem";
import { ACTIVE_CHAIN, RPC_URL } from "./chain";
import { DIAMOND_ADDRESS } from "./p2p";

// Minimal slice of the Diamond ABI — the exact selectors the widget uses to
// price an order. Mirrors @p2pdotme/widgets DIAMOND_ABI (getPriceConfig tuple +
// small-order threshold + the V22 per-order-type fee selectors with the
// pre-V22 unified fallback). Kept local so we never diverge from the contract.
const DIAMOND_PRICE_ABI = [
  {
    name: "getPriceConfig",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_currency", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "buyPrice", type: "uint256" },
          { name: "sellPrice", type: "uint256" },
          { name: "buyPriceOffset", type: "int256" },
          { name: "baseSpread", type: "uint256" },
        ],
      },
    ],
  },
  {
    name: "getSmallOrderThreshold",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_currency", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  // V22 charges HALF the unified fee on BUY; read the typed selector, fall back
  // to the deprecated unified one for pre-V22 Diamonds (see readBuyFixedFee).
  {
    name: "getSmallOrderFixedFeeBuy",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_currency", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getSmallOrderFixedFeeSell",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_currency", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "getSmallOrderFixedFee",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_currency", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// Reuse one public client for the price reads (its own RPC, independent of the
// merchant's wallet — the price is public and read even before connect).
// Typed as a minimal read surface: viem's strict readContract overloads fight
// with an `as const` ABI + a chain-cast client (deep generic inference), so we
// expose just readContract and keep explicit return-type casts at each call.
type ReadClient = { readContract: (args: any) => Promise<any> };
let _client: ReadClient | null = null;
function client(): ReadClient {
  if (!_client) {
    _client = createPublicClient({
      chain: ACTIVE_CHAIN as any,
      transport: http(RPC_URL || undefined),
    }) as unknown as ReadClient;
  }
  return _client;
}

/**
 * Mirror of the widget's readSmallOrderFixedFee(…, orderType): read the V22 typed
 * per-order-type selector, fall back to the deprecated unified selector on a
 * pre-V22 Diamond. BUY pays half the unified fee, SELL/PAY the full fee.
 */
async function readFixedFee(currencyHex: `0x${string}`, orderType: "buy" | "sell"): Promise<bigint> {
  const diamond = DIAMOND_ADDRESS as `0x${string}`;
  const typedFn = orderType === "buy" ? "getSmallOrderFixedFeeBuy" : "getSmallOrderFixedFeeSell";
  try {
    return (await client().readContract({
      address: diamond,
      abi: DIAMOND_PRICE_ABI,
      functionName: typedFn,
      args: [currencyHex],
    })) as bigint;
  } catch {
    return (await client().readContract({
      address: diamond,
      abi: DIAMOND_PRICE_ABI,
      functionName: "getSmallOrderFixedFee",
      args: [currencyHex],
    })) as bigint;
  }
}

/**
 * Thrown when the Diamond has NO price configured for a currency (buyPrice /
 * sellPrice == 0) — distinct from a network/read failure. The currency exists in
 * the UI but the protocol hasn't priced it yet (e.g. ARS on testnet). Callers
 * show "not available yet", NOT a "retrying…" spinner.
 */
export class PriceNotConfiguredError extends Error {
  constructor(public readonly currencyCode: string, public readonly side: "buy" | "sell") {
    super(`No on-chain ${side} price for ${currencyCode}`);
    this.name = "PriceNotConfiguredError";
  }
}

export type OnchainPrice = {
  /** fiat-per-USDC, 6-decimal fixed point (getPriceConfig.buyPrice). */
  buyPrice: bigint;
  /** orders at/below this USDC amount (6-dec) pay the fixed BUY fee. */
  smallOrderThreshold: bigint;
  /** the fixed BUY fee in USDC (6-dec) for small orders. */
  smallOrderFixedFee: bigint;
  /** human INR-per-USDC (buyPrice / 1e6) — for display parity with lib/rates. */
  rate: number;
  /** whom this came from — always "on-chain" here (contrast lib/rates sources). */
  source: "on-chain buy price";
};

export type OnchainSellPrice = {
  /** fiat-per-USDC on the SELL (offramp) side, 6-decimal fixed point. */
  sellPrice: bigint;
  /** orders at/below this USDC amount (6-dec) pay the fixed SELL fee. */
  smallOrderThreshold: bigint;
  /** the fixed SELL fee in USDC (6-dec) for small orders. */
  smallOrderFixedFee: bigint;
  /** human fiat-per-USDC (sellPrice / 1e6). */
  rate: number;
  source: "on-chain sell price";
};

/**
 * Read the Diamond's live buy-side price config for `currencyCode` (e.g. "INR").
 * This is the EXACT rate the checkout widget settles against — using it on the
 * Accept page is what eliminates the Order-Summary mismatch. Throws if the
 * Diamond address is unset or the read reverts (caller should fall back to a
 * clearly-labelled indicative rate and/or block order creation).
 */
export async function fetchOnchainPrice(currencyCode: string): Promise<OnchainPrice> {
  if (!DIAMOND_ADDRESS) throw new Error("Diamond address not configured");
  const currencyHex = stringToHex(currencyCode, { size: 32 }) as `0x${string}`;
  const diamond = DIAMOND_ADDRESS as `0x${string}`;

  const [price, threshold, fixedFee] = await Promise.all([
    client().readContract({
      address: diamond,
      abi: DIAMOND_PRICE_ABI,
      functionName: "getPriceConfig",
      args: [currencyHex],
    }) as Promise<{ buyPrice: bigint; sellPrice: bigint; buyPriceOffset: bigint; baseSpread: bigint }>,
    client().readContract({
      address: diamond,
      abi: DIAMOND_PRICE_ABI,
      functionName: "getSmallOrderThreshold",
      args: [currencyHex],
    }) as Promise<bigint>,
    readFixedFee(currencyHex, "buy"),
  ]);

  const buyPrice = price.buyPrice;
  if (!buyPrice || buyPrice <= 0n) throw new PriceNotConfiguredError(currencyCode, "buy");

  return {
    buyPrice,
    smallOrderThreshold: threshold ?? 0n,
    smallOrderFixedFee: fixedFee ?? 0n,
    rate: Number(buyPrice) / 1e6,
    source: "on-chain buy price",
  };
}

export type Quote = {
  /** the order amount in USDC (6-dec) — what userPlaceOrder is for; equals the widget's usdcAmount. */
  usdcAmount: bigint;
  /** product-2 quantity (0.01-USDC units) — usdcAmount / 1e4. */
  quantity: bigint;
  /**
   * The small-order fixed fee in USDC (6-dec), 0 above the threshold. It is
   * DEDUCTED from the entered amount: the customer pays exactly the fiat the
   * merchant typed, and this fee comes out of the merchant's proceeds.
   */
  feeUsdc: bigint;
  /** USDC the merchant receives = usdcAmount − feeUsdc (the merchant absorbs the fee). */
  creditedUsdc: bigint;
  /** fiat the merchant's ORDER is worth (usdcAmount*buyPrice/1e6), before the fee. */
  subtotalFiat: bigint;
  /** fiat the CUSTOMER pays all-in = subtotal + fee ≈ the entered amount (fee is baked in). */
  totalFiat: bigint;
  /** convenience floats for display (already /1e6). */
  usdc: number;
  credited: number;
  fee: number;
  total: number;
};

/**
 * Turn a typed fiat amount into an on-chain-accurate quote by INVERTING the
 * widget's fiat = usdc*buyPrice/1e6. Quantizes usdcAmount to the 0.01-USDC unit
 * exactly as qr/page.tsx does (so the on-chain order total is what we show).
 *
 * FEE MODEL (fee taken OUT of the entered amount, not added on top):
 *   The widget always computes the customer's total as subtotal + fee. To make
 *   the customer pay EXACTLY the entered fiat, we size the order so that
 *   subtotal = entered − fee. Then the widget's total = (entered − fee) + fee =
 *   entered (to the cent), and the merchant receives usdcAmount − fee. So the fee
 *   is effectively collected from the merchant's proceeds, and `credited` =
 *   usdcAmount − feeUsdc.
 *
 *   Because the fee threshold is defined on the ORDER amount (usdcAmount), and
 *   sizing for (entered − fee) can nudge usdcAmount across that threshold, we
 *   solve it in two passes: size for the gross first to learn whether the fee
 *   applies, then, if it does, re-size for (entered − feeFiat).
 *
 * @param fiatAmount  the local-currency amount the merchant typed (e.g. 1000 for ₹1000)
 * @param p           the on-chain price from fetchOnchainPrice
 */
export function quoteFromFiat(fiatAmount: number, p: OnchainPrice): Quote {
  // fiat(6-dec) = usd(6-dec) * buyPrice / 1e6  ⇒  usd = fiat * 1e6 / buyPrice.
  // Quantize to the 0.01-USDC product unit (nearest cent) so usdcAmount is a
  // clean multiple of 1e4 — identical to qr/page.tsx's quantity math.
  const sizeFor = (fiat6: bigint): bigint => {
    const rawUsdc6 = p.buyPrice > 0n ? (fiat6 * 1_000_000n) / p.buyPrice : 0n;
    const q = (rawUsdc6 + 5_000n) / 10_000n; // +half-cent for round-to-nearest
    return q;
  };
  const feeFor = (usdcAmount: bigint): bigint =>
    p.smallOrderThreshold > 0n && usdcAmount > 0n && usdcAmount <= p.smallOrderThreshold
      ? p.smallOrderFixedFee
      : 0n;

  const enteredFiat6 = BigInt(Math.round(fiatAmount * 1e6));

  // Pass 1: size for the FULL entered amount to discover whether the small-order
  // fee applies at this order size.
  let quantity = sizeFor(enteredFiat6);
  let usdcAmount = quantity * 10_000n;
  let feeUsdc = feeFor(usdcAmount);

  // Pass 2: if a fee applies, re-size the order so subtotal = entered − feeFiat,
  // making the widget's (subtotal + fee) land back on the entered amount. The fee
  // then comes out of what the merchant keeps.
  if (feeUsdc > 0n) {
    const feeFiat = (feeUsdc * p.buyPrice) / 1_000_000n;
    const netFiat6 = enteredFiat6 > feeFiat ? enteredFiat6 - feeFiat : 0n;
    quantity = sizeFor(netFiat6);
    usdcAmount = quantity * 10_000n;
    // Recompute incidence at the new (smaller) order size — it's still ≤ threshold,
    // so the fee stays; feeUsdc is unchanged, but recompute defensively.
    feeUsdc = feeFor(usdcAmount);
  }

  // The merchant absorbs the fee: they receive the order amount minus it.
  const creditedUsdc = usdcAmount > feeUsdc ? usdcAmount - feeUsdc : 0n;
  const feeFiat = (feeUsdc * p.buyPrice) / 1_000_000n;
  const subtotalFiat = (usdcAmount * p.buyPrice) / 1_000_000n;
  const totalFiat = subtotalFiat + feeFiat; // ≈ the entered amount

  return {
    usdcAmount,
    quantity,
    feeUsdc,
    creditedUsdc,
    subtotalFiat,
    totalFiat,
    usdc: Number(usdcAmount) / 1e6,
    credited: Number(creditedUsdc) / 1e6,
    fee: Number(feeUsdc) / 1e6,
    total: Number(totalFiat) / 1e6,
  };
}

/**
 * Read the Diamond's live SELL-side price config for `currencyCode`. This is the
 * rate a fiat WITHDRAWAL (offramp) settles at — using it on the withdraw page is
 * what makes the merchant's typed fiat payout match the amount the Cashout widget
 * (and the on-chain SELL) actually delivers. Throws on unset Diamond / revert.
 */
export async function fetchOnchainSellPrice(currencyCode: string): Promise<OnchainSellPrice> {
  if (!DIAMOND_ADDRESS) throw new Error("Diamond address not configured");
  const currencyHex = stringToHex(currencyCode, { size: 32 }) as `0x${string}`;
  const diamond = DIAMOND_ADDRESS as `0x${string}`;

  const [price, threshold, fixedFee] = await Promise.all([
    client().readContract({
      address: diamond,
      abi: DIAMOND_PRICE_ABI,
      functionName: "getPriceConfig",
      args: [currencyHex],
    }) as Promise<{ buyPrice: bigint; sellPrice: bigint; buyPriceOffset: bigint; baseSpread: bigint }>,
    client().readContract({
      address: diamond,
      abi: DIAMOND_PRICE_ABI,
      functionName: "getSmallOrderThreshold",
      args: [currencyHex],
    }) as Promise<bigint>,
    readFixedFee(currencyHex, "sell"),
  ]);

  const sellPrice = price.sellPrice;
  if (!sellPrice || sellPrice <= 0n) throw new PriceNotConfiguredError(currencyCode, "sell");

  return {
    sellPrice,
    smallOrderThreshold: threshold ?? 0n,
    smallOrderFixedFee: fixedFee ?? 0n,
    rate: Number(sellPrice) / 1e6,
    source: "on-chain sell price",
  };
}

/**
 * Convert a typed fiat PAYOUT target to the USDC amount to withdraw, using the
 * on-chain sellPrice (fiat = usdc * sellPrice / 1e6 ⇒ usdc = fiat * 1e6 / sellPrice).
 * Returns the raw 6-dec USDC bigint. The small-order SELL fee is NOT added here —
 * the Cashout widget/contract deducts it from the settled fiat; this only sizes
 * the USDC the merchant is offramping so the fiat quote lines up with settlement.
 */
export function usdcForFiatSell(fiatAmount: number, p: OnchainSellPrice): bigint {
  const fiat6 = BigInt(Math.round(fiatAmount * 1e6));
  return p.sellPrice > 0n ? (fiat6 * 1_000_000n) / p.sellPrice : 0n;
}
