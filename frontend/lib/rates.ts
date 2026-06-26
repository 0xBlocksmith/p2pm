/**
 * Live USDC→INR rate for the POS estimate.
 *
 * Primary source: the p2p.me subgraph — the ACTUAL rate recent INR orders
 * settled at (fiatAmount / usdcAmount on completed orders). This is the real
 * price merchants get from the protocol's LPs, not just a market reference.
 * Fallback: CoinGecko market rate, then a static estimate.
 */
import { SUBGRAPH_URL } from "./p2p";

const INR_HEX =
  "0x494e520000000000000000000000000000000000000000000000000000000000";

async function fromP2P() {
  const query = `{
    orders_collection(
      first: 8,
      where: { currency: "${INR_HEX}", status: 3 },
      orderBy: orderId,
      orderDirection: desc
    ) {
      usdcAmount
      fiatAmount
      actualUsdcAmount
      actualFiatAmount
    }
  }`;
  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
    cache: "no-store",
  });
  const json = await res.json();
  const orders = json?.data?.orders_collection || [];

  // Each order's rate = fiatAmount / usdcAmount (both 6-decimal, so the ratio
  // is INR per USDC directly). Average the recent ones for a stable quote.
  const rates = [];
  for (const o of orders) {
    const usdc = Number(o.actualUsdcAmount || o.usdcAmount);
    const fiat = Number(o.actualFiatAmount || o.fiatAmount);
    if (usdc > 0 && fiat > 0) rates.push(fiat / usdc);
  }
  if (rates.length === 0) return null;
  const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
  return avg > 0 ? avg : null;
}

async function fromCoinGecko() {
  const r = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=inr",
    { cache: "no-store" }
  );
  const j = await r.json();
  const rate = j["usd-coin"]?.inr;
  return rate && rate > 0 ? rate : null;
}

export async function fetchUsdcInrRate() {
  try {
    const p2p = await fromP2P();
    if (p2p) return { rate: p2p, source: "p2p.me live rate", at: Date.now() };
  } catch {}
  try {
    const cg = await fromCoinGecko();
    if (cg) return { rate: cg, source: "market rate", at: Date.now() };
  } catch {}
  return { rate: 90, source: "offline estimate", at: Date.now() };
}

// Per-currency USDC rate via CoinGecko (USDC ≈ 1 USD, so vs_currencies works).
// India keeps the p2p live rate (the real protocol price); others use market.
async function marketRate(vs) {
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=${vs.toLowerCase()}`,
      { cache: "no-store" }
    );
    const j = await r.json();
    const rate = j["usd-coin"]?.[vs.toLowerCase()];
    return rate && rate > 0 ? rate : null;
  } catch {
    return null;
  }
}

// Sensible offline fallbacks so the UI never shows a broken rate.
const FALLBACK = { INR: 90, BRL: 5.4, ARS: 1000 };

/**
 * Country-aware USDC→local rate. For India, prefer the p2p live rate (the price
 * merchants actually get on-chain); for others, market rate, then fallback.
 * Returns { rate, source }.
 */
export async function fetchUsdcRate(country) {
  const code = country?.code || "INR";
  if (code === "INR") return fetchUsdcInrRate();
  const m = await marketRate(code);
  if (m) return { rate: m, source: "market rate", at: Date.now() };
  return { rate: FALLBACK[code] || 1, source: "offline estimate", at: Date.now() };
}
