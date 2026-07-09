/**
 * p2p.me widget integration helpers.
 *
 * The merchant terminal places orders through the official @p2pdotme/widgets
 * <Checkout> component, which (a) generates and persists a "relay identity"
 * (the user pubkey used to encrypt UPI details) and (b) auto-resolves the
 * INR circleId via the subgraph. Our placeOrder callback then encodes a call
 * to OUR integrator's 6-arg userPlaceOrder.
 *
 * Docs: github.com/p2pdotme/widgets
 */
import { encodeFunctionData, stringToHex, createPublicClient, http } from "viem";
import { INTEGRATOR_ABI, CONTRACT_ADDRESS, CLIENT_ADDRESS, PRODUCT_ID } from "./contract";
import { ACTIVE_CHAIN, RPC_URL } from "./chain";

// The team's Base Sepolia subgraph — enables automatic circle selection.
export const SUBGRAPH_URL =
  process.env.NEXT_PUBLIC_SUBGRAPH_URL ||
  "https://api.studio.thegraph.com/query/1745491/event-indexer/v0.0.6";

export const USDC_ADDRESS = process.env.NEXT_PUBLIC_USDC_ADDRESS || "";
export const DIAMOND_ADDRESS = process.env.NEXT_PUBLIC_DIAMOND_ADDRESS || "";

// INR via UPI, circleId omitted → resolved by the widget through the subgraph.
export const CURRENCIES = [{ symbol: "INR", flag: "🇮🇳", paymentMethod: "UPI", symbolNative: "₹" }];

// ── Generic currency ⇄ bytes32 (no per-country hardcoding) ──────────
// The subgraph stores a currency as a left-aligned bytes32 of the ASCII code.
// e.g. "INR" → 0x494e52…00 , "BRL" → 0x42524c…00.
export function codeToHex(code: string): string {
  let hex = "0x";
  for (let i = 0; i < 32; i++) {
    const ch = i < code.length ? code.charCodeAt(i) : 0;
    hex += ch.toString(16).padStart(2, "0");
  }
  return hex.toLowerCase();
}
export function hexToCode(hex: string): string {
  const h = hex.replace(/^0x/, "");
  let out = "";
  for (let i = 0; i < h.length; i += 2) {
    const b = parseInt(h.slice(i, i + 2), 16);
    if (b === 0) break;
    out += String.fromCharCode(b);
  }
  return out;
}

let _circlesCache: { at: number; rows: { circleId: bigint; code: string }[] } | null = null;

/**
 * GENERIC: fetch every currency the protocol can settle, straight from the live
 * "circles" on the subgraph. This is the single source of truth — whatever the
 * protocol funds appears here automatically, with NO per-country code. Cached
 * 60s. Returns [{ circleId, code }] e.g. [{1,"INR"},{2,"BRL"}, …future…].
 */
export async function fetchSupportedCurrencies(): Promise<{ circleId: bigint; code: string }[]> {
  if (_circlesCache && Date.now() - _circlesCache.at < 60_000) return _circlesCache.rows;
  try {
    const res = await fetch(SUBGRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `{ circles(first: 100) { circleId currency } }` }),
    });
    const json = await res.json();
    const rows = (json.data?.circles || [])
      .map((c: any) => ({ circleId: BigInt(c.circleId), code: hexToCode(c.currency) }))
      .filter((r: any) => r.code.length > 0);
    _circlesCache = { at: Date.now(), rows };
    return rows;
  } catch {
    // offline fallback — the known-live circles so the UI still works
    return [{ circleId: 1n, code: "INR" }, { circleId: 2n, code: "BRL" }];
  }
}

/**
 * GENERIC: resolve the circle id for ANY currency code. Returns null if the
 * protocol has no funded circle for it (→ the UI hides/disables that currency).
 */
export async function resolveCircleId(code: string): Promise<bigint | null> {
  const list = await fetchSupportedCurrencies();
  return list.find((c) => c.code === code)?.circleId ?? null;
}

// ── LP-availability pre-flight ──────────────────────────────────────
// The widget's router will refuse to place an order ("No payment partner
// available" / ROUTING_NO_MERCHANTS) whenever the currency's circle has no
// merchant assignable to THIS buyer+amount at that instant. On testnet each
// circle has a single LP whose availability flickers, so a checkout opened
// during a gap fails at placement. We predict that EXACT condition up front by
// calling the same on-chain view the router calls (getAssignableMerchantsFromCircle),
// and only open the widget once ≥1 LP is assignable — so the merchant never sees
// a failed placement, and we don't paper over it with blind retries.
const ORDER_FLOW_ABI = [
  {
    name: "getAssignableMerchantsFromCircle",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "circleId", type: "uint256" },
      { name: "assignUpto", type: "uint256" },
      { name: "currency", type: "bytes32" },
      { name: "user", type: "address" },
      { name: "usdtAmount", type: "uint256" },
      { name: "fiatAmount", type: "uint256" },
      { name: "orderType", type: "int256" },
      { name: "preferredPCConfigId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "address[]" }],
  },
] as const;

let _rc: { readContract: (args: any) => Promise<any> } | null = null;
function readClient() {
  if (!_rc) {
    _rc = createPublicClient({
      chain: ACTIVE_CHAIN as any,
      transport: http(RPC_URL || undefined),
    }) as unknown as { readContract: (args: any) => Promise<any> };
  }
  return _rc;
}

/**
 * Is at least one LP assignable to fill a BUY order for `code` right now, for
 * this buyer + these amounts? Mirrors the widget router's on-chain eligibility
 * check exactly, so a `true` here means the widget WILL find a partner.
 *
 * @param code      currency code ("INR", "BRL", …)
 * @param user      the buyer address (the merchant's smart account)
 * @param usdcAmount 6-dec USDC the order is for
 * @param fiatAmount 6-dec fiat the order is for
 * Returns false on any read error (treated as "not available yet").
 */
export async function isPaymentPartnerAvailable(
  code: string,
  user: string,
  usdcAmount: bigint,
  fiatAmount: bigint,
): Promise<boolean> {
  try {
    const circleId = await resolveCircleId(code);
    if (circleId == null) return false;
    const merchants = (await readClient().readContract({
      address: DIAMOND_ADDRESS as `0x${string}`,
      abi: ORDER_FLOW_ABI,
      functionName: "getAssignableMerchantsFromCircle",
      // assignUpto 5 mirrors the SDK's default fan-out; orderType 0 = BUY.
      args: [circleId, 5n, codeToHex(code), user, usdcAmount, fiatAmount, 0n, 0n],
    })) as string[];
    return Array.isArray(merchants) && merchants.length >= 1;
  } catch {
    return false;
  }
}

/**
 * Build the placeOrder callback the widget invokes once it has resolved the
 * circleId and the relay identity (pubkey). We encode OUR 6-arg userPlaceOrder
 * — the integrator forwards (currency, circleId, pubKey) to the Diamond and
 * passes its own 0,0 for preferredPaymentChannelConfigId / fiatAmountLimit.
 *
 * @param signer        CheckoutSigner (thirdweb smart-account adapter)
 * @param publicClient  viem public client for receipt parsing
 * @param quantity      bigint product-2 units (USDC cents)
 * @param getIdentity   async () => RelayIdentity ({ publicKey })
 */
export function makePlaceOrder({ signer, publicClient, quantity, getIdentity }) {
  return async (ctx) => {
    const circleId = ctx?.currency?.circleId;
    if (circleId === undefined || circleId === null) {
      throw new Error("No circle resolved for INR — check subgraphUrl/usdcAmount");
    }

    const identity = await getIdentity();
    if (!identity?.publicKey) throw new Error("relay identity missing");

    const data = encodeFunctionData({
      abi: INTEGRATOR_ABI,
      functionName: "userPlaceOrder",
      args: [
        CLIENT_ADDRESS,
        PRODUCT_ID,
        quantity,
        stringToHex(ctx.currency.symbol, { size: 32 }),
        BigInt(circleId),
        identity.publicKey, // 128-char hex, no prefix (BUY path — already works, #307/#309)
      ],
    });

    const { hash } = await signer.sendTransaction({
      to: CONTRACT_ADDRESS,
      data,
      gasLimit: 1_500_000,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") throw new Error("order tx reverted");

    // Decode the orderId from OUR OrderPlaced event (Diamond also emits
    // B2BOrderPlaced; either resolves the id — we use ours since it's in the ABI).
    let orderId = null;
    for (const log of receipt.logs) {
      try {
        const { decodeEventLog } = await import("viem");
        const ev: any = decodeEventLog({ abi: INTEGRATOR_ABI, data: log.data, topics: log.topics });
        if (ev.eventName === "OrderPlaced") {
          orderId = ev.args.orderId.toString();
          break;
        }
      } catch {
        // not our event — skip
      }
    }
    if (!orderId) throw new Error("orderId missing from receipt");

    return { orderId, txHash: hash };
  };
}
