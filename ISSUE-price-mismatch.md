# Issue: USDC amount mismatch between the Accept page and the Order Summary

**Status:** ✅ FIXED — Accept page and Withdraw page now price from the on-chain buy/sell price (same source the widget settles against). Typecheck + production build green.
**Affects:** every currency (INR, BRL, ARS, …), not just INR
**Reported:** ₹1000 shows **12.48 USDC** on the Accept page but **10.99 USDC** in the Order Summary.

---

## ✅ What was implemented

1. **`frontend/lib/price.ts` (new)** — reads the Diamond's on-chain `getPriceConfig().buyPrice` / `.sellPrice`, `getSmallOrderThreshold`, and the V22 per-order-type small-order fee (with the pre-V22 unified fallback) — the EXACT values the widget uses. Exposes:
   - `fetchOnchainPrice(code)` + `quoteFromFiat(fiat, price)` — BUY side (Accept page).
   - `fetchOnchainSellPrice(code)` + `usdcForFiatSell(fiat, price)` — SELL side (Withdraw page).
2. **`frontend/app/qr/page.tsx` (Accept page)** — replaced the off-chain `usdcEquiv = amt / rate.rate` with `quoteFromFiat(...)` off the on-chain `buyPrice`. The USDC it shows and the USDC it hands the widget are now the same number the Order Summary re-prices → **they converge by construction**. Order creation is blocked until the live price loads (never places off a guessed rate). Shows the customer's all-in fiat cost when a small-order fee applies.
3. **`frontend/app/withdraw/page.tsx`** — the same class of bug on the offramp: typed fiat payout → USDC now uses on-chain `sellPrice` (keyed off the withdraw currency `wdCode`, not the display country — also fixed a latent currency-mismatch there).
4. **Fee incidence** — verified against the widget's `orderBreakdown`: on BUY the small-order fee is added to the **customer's** fiat (merchant keeps the full order USDC), so "you keep" = full `usdcAmount`.
5. **dashboard / transactions** — intentionally left on the market rate (`lib/rates.ts`): those are indicative "your held USDC ≈ ₹X" displays, not order quotes, so an on-chain *order* price would be the wrong thing to show there.

*The analysis below is the original root-cause write-up.*

---

## 1. TL;DR (what's actually wrong)

The two screens price the same sale from **two different, unconnected rate sources**:

| Screen | File | Rate source | For ₹1000 |
|---|---|---|---|
| **Accept page** ("You keep … USDC") | `frontend/app/qr/page.tsx` | **Off-chain estimate** from `lib/rates.ts` (subgraph average → CoinGecko → static fallback) | ≈ **12.48 USDC** |
| **Order Summary** (inside the widget) | `@p2pdotme/widgets` `<Checkout>` | **On-chain `getPriceConfig().buyPrice`** from the Diamond + small-order fee | ≈ **10.99 USDC** |

Our app **never reads the on-chain price**. It estimates a USDC amount off-chain, freezes it, and hands that number to the widget — which then re-prices against the *real* on-chain rate. The two rates disagree, so the numbers disagree.

The merchant is shown "you keep 12.48 USDC" — a number the protocol never actually uses. That's the transparency bug.

---

## 2. The exact code path (step by step)

### Step A — Accept page computes USDC off-chain
`frontend/app/qr/page.tsx:168-169`
```ts
const amtNum = Number(amt) || 0;
const usdcEquiv = rate && amtNum > 0 ? amtNum / rate.rate : 0;   // ← off-chain rate
```
`rate` is fetched from `lib/rates.ts` (`qr/page.tsx:162`):
```ts
const load = () => fetchUsdcRate(country).then((r) => alive && setRate(r));
```

### Step B — that rate comes from a subgraph average / CoinGecko / static fallback
`frontend/lib/rates.ts:60-70`
```ts
export async function fetchUsdcInrRate() {
  try { const p2p = await fromP2P();       if (p2p) return { rate: p2p, source: "p2p.me live rate" }; } catch {}
  try { const cg  = await fromCoinGecko(); if (cg)  return { rate: cg,  source: "market rate" };     } catch {}
  return { rate: 90, source: "offline estimate" };   // ← static ₹90 fallback
}
```
- `fromP2P()` averages `fiatAmount/usdcAmount` over the **last 8 completed orders** — a *historical average*, not the price this order will settle at.
- Non-INR currencies (`fetchUsdcRate`, `rates.ts:96-102`) skip even that and use **CoinGecko market rate** or a hardcoded `{ INR: 90, BRL: 5.4, ARS: 1000 }`.

### Step C — the estimate is frozen and shown as "You keep"
`frontend/app/qr/page.tsx:377-380`
```tsx
{rate ? (amtNum > 0 ? `≈ ${usdcEquiv.toFixed(2)} USDC ${t("qr.youKeep")}` : …) : …}
```
On "generate", `usdcEquiv` is quantized and locked into `usdcAmount` (`qr/page.tsx:208-216`):
```ts
const quantity   = BigInt(Math.round(usdcEquiv * 100)); // 0.01-USDC units
const usdcAmount = quantity * 10_000n;                  // 6-dec USDC
setLiveWidget({ usdcAmount, quantity, fiat: amtNum, usdc: usdcEquiv });
```

### Step D — the widget re-prices that USDC against the ON-CHAIN buy price
`frontend/components/CheckoutWidget.tsx:57,60`
```tsx
amount={`${(Number(usdcAmount) / 1e6).toFixed(2)} USDC`}
usdcAmount={usdcAmount}
```
Inside the widget (`node_modules/@p2pdotme/widgets/dist/checkout.js`), the Order Summary reads the Diamond's on-chain price and re-derives the figures:
```js
// getPriceConfig(currency).buyPrice  ← on-chain
const subtotal = opts.usdcAmount * state.buyPrice / 1000000n;   // + small-order fee
```
This on-chain `buyPrice` (≈ ₹91/USDC → 10.99) differs from the off-chain estimate (≈ ₹80/USDC → 12.48), and the small-order fixed fee widens the gap further on small tickets.

---

## 3. Why the two numbers differ (three compounding reasons)

1. **Different rate entirely** — off-chain historical/market average vs. on-chain `buyPrice` set by the protocol. These are simply not the same number.
2. **Small-order fixed fee** — the widget adds `readSmallOrderFixedFee(...)` on small tickets; our estimate ignores fees completely.
3. **Staleness** — our subgraph average is over the last 8 *completed* orders and refreshes every 60 s; the on-chain price can move in between.

Because reasons 1–2 are structural (not just lag), **the numbers will basically never match** as long as the Accept page uses `lib/rates.ts`.

---

## 4. The fix

**Principle:** price the Accept page from the *same* on-chain source the widget settles against, and show fees. One source of truth = no mismatch.

### Option A — price from on-chain `getPriceConfig().buyPrice` (recommended, fixes the mismatch)
Replace the off-chain `usdcEquiv = amt / rate.rate` with a read of the Diamond's `getPriceConfig(currency).buyPrice` (the exact value the widget uses), and derive USDC the same way the widget does, including the small-order fee.

- Add a helper (e.g. in `lib/contract.ts` or a new `lib/price.ts`) that reads `getPriceConfig(currencyHex)` + `getSmallOrderThreshold` + `readSmallOrderFixedFee` from the Diamond via wagmi/viem — mirroring `checkout.js:495-512`.
- In `qr/page.tsx`, compute `usdcEquiv` from that on-chain price instead of `rate.rate`.
- Keep `lib/rates.ts` only as a *labelled* "indicative market rate" if you still want a fiat reference, but the USDC figure the merchant is promised must come from on-chain.

**Result:** Accept page and Order Summary read the same `buyPrice`, so 12.48 == 10.99 (they converge).

### Option B — show the estimate honestly (cheap stop-gap, does NOT fully fix)
If Option A can't land immediately, at minimum:
- Label the Accept figure "≈ estimated, final amount on next screen" so the merchant isn't promised an exact number the protocol won't honour.
- Remove the definitive "you keep 12.48 USDC" wording until it's on-chain-accurate.

This is transparency triage, not a real fix — the mismatch stays; it's just no longer *misleading*.

### Transparency requirement (from the report — applies to either option)
The merchant expects to see, **upfront**, the exact amount that will be credited, including fees and exchange rate. The final screen should break down: **gross USDC · protocol/small-order fee · net USDC credited · effective INR rate.** The widget already computes these (`orderBreakdown` / `preview` in `checkout.js`); surface them on the Accept side too so both screens tell the same story.

---

## 5. Files to touch

| File | Change |
|---|---|
| `frontend/app/qr/page.tsx` | Replace `usdcEquiv = amt / rate.rate` (line 169) with on-chain buy-price pricing; update the "You keep" display (lines 377-380) to show the same number + fee note. |
| `frontend/lib/contract.ts` *(or new `lib/price.ts`)* | Add on-chain `getPriceConfig`/`getSmallOrderThreshold`/small-order-fee reader mirroring `checkout.js:495-512`. |
| `frontend/lib/rates.ts` | Demote to a clearly-labelled *indicative market rate only*, or drop from the USDC calc. |
| `frontend/components/CheckoutWidget.tsx` | (No change needed — already correct; it faithfully re-prices on-chain. It's the app that's wrong.) |

---

## 6. How to verify the fix

1. Enter ₹1000 on the Accept page → note the USDC figure.
2. Proceed to Order Summary → the figure must **match** (within rounding of the 0.01-USDC quantization).
3. Repeat for **BRL and ARS** (the report says it's every currency) — these currently use CoinGecko/static and will mismatch the most.
4. Confirm the small-order fee is reflected on both screens for a small ticket (e.g. ₹50).
5. Confirm the final "credited" breakdown (gross / fee / net / rate) is shown before the merchant commits.

---

## 7. One-line root cause (for the standup)

> The Accept page prices in USDC using an **off-chain estimate** (`lib/rates.ts`), while the Order Summary prices using the **on-chain `getPriceConfig().buyPrice`** — two unconnected rates, so the numbers never agree. Fix: price the Accept page from the same on-chain buy price the widget settles against, and show the fee breakdown.
