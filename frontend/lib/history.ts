// Merchant transaction history straight from the p2p.me subgraph — no backend
// database. The subgraph indexes every on-chain order; we query the ones placed
// by this merchant (userAddress). Balances/locks still come live from the
// contract; this is purely the historical list for the Transactions page.

import { keccak256, stringToBytes } from "viem";
import { SUBGRAPH_URL } from "./p2p";

const ST = { 0: "matching", 1: "matching", 2: "matching", 3: "settled", 4: "cancelled" };

/**
 * Fetch a merchant's orders from the subgraph.
 * Returns rows shaped for the Transactions page:
 *   { orderId, amount (raw 6-dec string), status, txHash, createdAt(ms), placedAt }
 * status: 'matching' | 'settled' | 'cancelled'  (the page maps these to badges)
 */
export async function fetchHistory(address) {
  if (!address) return [];
  const query = `{
    orders_collection(
      first: 50,
      where: { userAddress: "${address.toLowerCase()}" },
      orderBy: orderId,
      orderDirection: desc
    ) {
      orderId
      status
      usdcAmount
      placedAt
      completedAt
      transactionHash
    }
  }`;

  let data;
  try {
    const res = await fetch(SUBGRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      cache: "no-store",
    });
    data = await res.json();
  } catch {
    return [];
  }
  const rows = data?.data?.orders_collection || [];

  return rows.map((o) => {
    const placed = Number(o.placedAt) * 1000;
    return {
      orderId: String(o.orderId),
      amount: String(o.usdcAmount), // raw 6-dec
      status: ST[Number(o.status)] || "matching",
      txHash: o.transactionHash || null,
      createdAt: new Date(placed).toISOString(),
      placedAt: Number(o.placedAt),
      completedAt: o.completedAt ? Number(o.completedAt) : null,
    };
  });
}

/**
 * Fetch a merchant's FIAT WITHDRAWALS from the subgraph.
 *
 * A fiat withdrawal is a SELL order (orderType = 1) placed by the merchant's
 * per-merchant PROXY address (not their EOA). They're indexed in the p2p.me
 * subgraph's `b2Borders` keyed by our integrator. So: pass the merchant's proxy
 * address (read on-chain via `proxyAddress(merchant)`) and we return its SELL
 * orders. No contract change, no event-log scraping needed.
 *
 * Returns rows shaped like fetchHistory but tagged kind:"withdraw":
 *   { orderId, amount(raw 6-dec USDC), kind:"withdraw", txHash, createdAt, placedAt }
 */
export async function fetchWithdrawals(proxyAddress) {
  if (!proxyAddress) return [];
  const query = `{
    b2Borders(
      first: 50,
      where: { user: "${proxyAddress.toLowerCase()}", orderType: 1 },
      orderBy: blockTimestamp,
      orderDirection: desc
    ) {
      orderId
      amount
      transactionHash
      blockTimestamp
    }
  }`;
  let data;
  try {
    const res = await fetch(SUBGRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      cache: "no-store",
    });
    data = await res.json();
  } catch {
    return [];
  }
  const rows = data?.data?.b2Borders || [];
  return rows.map((o) => {
    const ts = Number(o.blockTimestamp) * 1000;
    return {
      orderId: String(o.orderId),
      amount: String(o.amount), // raw 6-dec USDC
      kind: "withdraw",
      status: "withdrawn",
      txHash: o.transactionHash || null,
      createdAt: new Date(ts).toISOString(),
      placedAt: Number(o.blockTimestamp),
    };
  });
}

/**
 * Fetch a SINGLE order by id from the subgraph — powers the public,
 * no-auth customer receipt page (/receipt/[orderId]). The customer who
 * just paid can open the link and verify the sale on-chain.
 * Returns null if not found.
 *   { orderId, amount(raw 6-dec), status, txHash, placedAt, completedAt }
 */
export async function fetchOrder(orderId) {
  // On-chain order ids are integers — reject anything else so a crafted id can't
  // reach the query as arbitrary text (defense-in-depth for the public receipt).
  const id = String(orderId ?? "").trim();
  if (!/^\d+$/.test(id)) return null;
  const query = `{
    orders_collection(first: 1, where: { orderId: "${id}" }) {
      orderId
      status
      usdcAmount
      userAddress
      placedAt
      completedAt
      transactionHash
    }
  }`;
  let data;
  try {
    const res = await fetch(SUBGRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      cache: "no-store",
    });
    data = await res.json();
  } catch {
    return null;
  }
  const o = data?.data?.orders_collection?.[0];
  if (!o) return null;
  return {
    orderId: String(o.orderId),
    amount: String(o.usdcAmount),
    status: ST[Number(o.status)] || "matching",
    userAddress: o.userAddress || null,   // the placer proxy (resolves to the merchant)
    txHash: o.transactionHash || null,
    placedAt: Number(o.placedAt),
    completedAt: o.completedAt ? Number(o.completedAt) : null,
  };
}

/**
 * Receipt link access token — there's no backend to hold a signing secret, so
 * instead of a real signature we derive the token from the order's on-chain
 * tx hash, which is unpredictable until the payment actually settles. A link
 * minted before the real payment lands can't guess it; the receipt page
 * recomputes this from the SAME chain data it already fetches and rejects a
 * mismatch. Not cryptographically unforgeable (no secret key), but enough to
 * stop someone from browsing to a link for /receipt/<other-order-id>.
 */
export function receiptToken(orderId: string, txHash: string): string {
  return keccak256(stringToBytes(`${orderId}:${txHash.toLowerCase()}`)).slice(2, 18);
}
