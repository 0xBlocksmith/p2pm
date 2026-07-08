/**
 * USDC→local-currency rate for the app's fiat estimates (Accept, Withdraw,
 * Dashboard, Transactions, Wallet).
 *
 * SINGLE SOURCE OF TRUTH: the p2p.me protocol itself — never an external FX API.
 * The Accept-page checkout and the fiat withdrawal both price against the
 * Diamond's on-chain `buyPrice`, so every fiat figure the merchant sees MUST
 * come from that same number. Mixing in a market rate (e.g. CoinGecko) made the
 * estimate and the actual charge disagree (₹500 est vs ₹499 charged; far worse
 * for BRL where the on-chain price is a testnet placeholder), which just
 * confuses the merchant. On testnet the on-chain rate may be "wrong"
 * economically — that's fine and intentional: showing the SAME wrong rate
 * everywhere is consistent; showing two different rates is not.
 *
 * Sources, in order:
 *   1. On-chain `getPriceConfig(currency).buyPrice` — the exact rate the
 *      checkout charges / withdrawal settles at. Primary for every currency.
 *   2. p2p.me subgraph — the average rate recent COMPLETED orders settled at
 *      (fiatAmount / usdcAmount). Still a p2p rate; used only if (1) is missing.
 *   3. A static per-currency fallback, so the UI never shows a broken rate.
 */
import { SUBGRAPH_URL, codeToHex } from "./p2p";
import { fetchPriceConfig } from "./pricing";

/** Average settled rate for a currency from the p2p subgraph (fiat per USDC). */
async function fromP2P(code: string) {
  const currencyHex = codeToHex(code);
  const query = `{
    orders_collection(
      first: 8,
      where: { currency: "${currencyHex}", status: 3 },
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
  // is fiat per USDC directly). Average the recent ones for a stable quote.
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

// Static per-currency fallbacks so the UI never shows a broken rate when both
// the on-chain price and the subgraph are unavailable. NOT an FX source — just a
// last resort. Kept rough on purpose.
const FALLBACK = { INR: 90, BRL: 5.4, ARS: 1000 };

/**
 * INR shim kept for existing callers. Delegates to the generic country-aware
 * path (India uses the same on-chain-first sourcing as every other currency).
 */
export async function fetchUsdcInrRate() {
  return fetchUsdcRate({ code: "INR" });
}

/**
 * USDC→local rate for a country, sourced ONLY from the p2p protocol (on-chain
 * price first, then settled-order average, then a static fallback). Returns
 * { rate, source, at }.
 */
export async function fetchUsdcRate(country) {
  const code = country?.code || "INR";

  // 1) On-chain buyPrice — the exact rate checkout/withdrawal use. This is what
  //    keeps every screen's fiat figure equal to the real charge.
  try {
    const cfg = await fetchPriceConfig(code);
    if (cfg && cfg.buyPrice > 0n) {
      return { rate: Number(cfg.buyPrice) / 1e6, source: "p2p on-chain price", at: Date.now() };
    }
  } catch {}

  // 2) p2p.me settled-order average (still a p2p rate, not an external FX API).
  try {
    const p2p = await fromP2P(code);
    if (p2p) return { rate: p2p, source: "p2p.me settled rate", at: Date.now() };
  } catch {}

  // 3) Static fallback.
  return { rate: FALLBACK[code] || 1, source: "offline estimate", at: Date.now() };
}
