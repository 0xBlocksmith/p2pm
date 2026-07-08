# Issue: Non-INR currency pricing is wrong (BRL massively overpriced, ARS unpriceable)

**Status:** Open · **Severity:** High (customers overcharged ~185× on BRL; ARS orders cannot be placed)
**Reported:** 2026-07-08 (BRL test order, see screenshot) · **Filed by:** review

---

## Symptom

A BRL test checkout for **0.01 USDC** renders as:

| Row | Value |
|---|---|
| Order summary | 0.01 USDC |
| Subtotal | **BRL 10.00** |
| Transaction fee | **BRL 62.50** |
| **You pay** | **BRL 72.50** |

A 0.01 USDC order (≈ **R$ 0.05** at the real market rate) is billed to the
customer as **R$ 72.50** — roughly **1,450× the correct amount**. INR orders are
priced correctly; only non-INR currencies are affected.

---

## Root cause — it is NOT a frontend bug

The amounts on the checkout screen are computed **by the p2p.me `<Checkout>`
widget itself**, directly from the on-chain price config it reads off the
Diamond. The widget's formula (verified in
`node_modules/@p2pdotme/widgets/dist/checkout.js`) is:

```
subtotal = usdcAmount * buyPrice / 1e6
feeFiat  = smallOrderFixedFeeBuy * buyPrice / 1e6   (only when usdcAmount <= smallOrderThreshold)
total    = subtotal + feeFiat
```

Reading the **live Diamond** (`getPriceConfig` / `getSmallOrderThreshold` /
`getSmallOrderFixedFeeBuy`) on Base Sepolia
(`0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9`):

| Currency | on-chain `buyPrice` | fiat/USDC | Correct? | `fixedFeeBuy` | `threshold` |
|---|---:|---:|---|---:|---:|
| **INR** | `91000000` | 91 | ✅ ~correct | 0.0625 USDC | 10 USDC |
| **BRL** | `1000000000` | **1000** | ❌ should be ~**5.4** (≈185× too high) | 0.0625 USDC | 10 USDC |
| **ARS** | `0` | **0** | ❌ **unconfigured** | 0 | 0 |

Plugging BRL's `buyPrice = 1000` into the widget formula reproduces the
screenshot exactly:

- subtotal = `0.01 × 1000` = **BRL 10.00** ✔
- fee = `0.0625 × 1000` = **BRL 62.50** ✔ (order ≤ 10 USDC threshold, so the fixed fee applies)
- total = **BRL 72.50** ✔

So the frontend is faithfully displaying a **wrong on-chain price**. The BRL
`buyPrice` is set to 1000 (a placeholder — looks like a copy of a high-rate
currency), and ARS has never been priced at all.

### Why "only fixed for INR" is a misconception about the frontend

The frontend estimate fix (`lib/pricing.ts` + `app/qr/page.tsx`) **is
currency-generic** — it calls `fetchPriceConfig(country.code)` and
`usdcForFiat(amt, cfg)` for whatever currency is selected, with no INR
special-casing. It successfully makes the Accept-page estimate MATCH the
checkout total for every currency. The catch: for BRL it now makes the estimate
agree with the checkout on the **wrong** number, because the shared source of
truth — the on-chain `buyPrice` — is itself wrong. Consistency was fixed;
correctness of the underlying price data was not (and can't be, from the app).

The one genuinely INR-only piece of code is the market-rate *reference* in
`lib/rates.ts` (`fetchUsdcInrRate` uses the p2p subgraph; others use CoinGecko).
That only affects the pre-submit "≈ X" estimate fallback, **not** the price the
customer is actually charged — so it is not the cause of this bug.

---

## Impact

- **BRL:** every customer is overcharged ~185× on the subtotal, and the fixed
  fee is inflated to **R$ 62.50** on small orders. Any real BRL order is
  unusable / would be a chargeback.
- **ARS:** `buyPrice = 0` → the widget cannot derive a fiat total; an ARS order
  cannot be priced or placed at all. ARS is still user-selectable in the
  terminal currency picker (`lib/countries.ts`), so a merchant can pick a dead
  currency.
- **INR:** unaffected — priced correctly.

---

## Fix — protocol data change, not an app deploy

The correct `buyPrice` (and small-order fee/threshold) must be set on the
**Diamond**, via the p2p.me protocol's admin `setPriceConfig` (there is no such
entrypoint in this repo — it lives protocol-side). Required:

1. **BRL** — set `buyPrice` from `1000000000` to the real rate, ≈ `5400000`
   (5.4 BRL/USDC, tracked to the live market). Re-check `smallOrderFixedFeeBuy`:
   0.0625 USDC × 5.4 ≈ R$ 0.34, which is sane; at the current wrong price it's
   R$ 62.50.
2. **ARS** — configure a real `buyPrice` (≈ `1000000000` for ~1000 ARS/USDC,
   *if* that is actually correct — verify against the live ARS market) plus its
   threshold and fee. Until then, ARS should be treated as unavailable.

### App-side mitigations (defensive, until the data is fixed)

These don't fix the price but stop the app from presenting a broken one:

- **Gate unpriced / mispriced currencies in the terminal.** `fetchPriceConfig`
  already returns `null` when `buyPrice <= 0` — the qr page could hide or
  disable any currency whose on-chain price is missing (catches ARS today) and
  optionally sanity-check the on-chain rate against the market reference
  (`lib/rates.ts`), warning the merchant when they diverge by more than, say,
  3× (catches BRL today).
- **Surface the divergence** rather than silently charging it: if
  `onchainRate / marketRate > N`, show "pricing unavailable for this currency —
  contact support" instead of a checkout.

---

## Verification steps (repro)

```bash
cd frontend
node -e '
require("dotenv").config({path:".env.local"});
const {createPublicClient,http,stringToHex,parseAbi}=require("viem");
const {base,baseSepolia}=require("viem/chains");
const chain=process.env.NEXT_PUBLIC_CHAIN==="base"?base:baseSepolia;
const c=createPublicClient({chain,transport:http(process.env.NEXT_PUBLIC_RPC_URL)});
const abi=parseAbi([
 "struct PriceConfig { uint256 buyPrice; uint256 sellPrice; int256 buyPriceOffset; uint256 baseSpread; }",
 "function getPriceConfig(bytes32 currency) view returns (PriceConfig)",
 "function getSmallOrderThreshold(bytes32 currency) view returns (uint256)",
 "function getSmallOrderFixedFeeBuy(bytes32 currency) view returns (uint256)",
]);
(async()=>{ for(const code of ["INR","BRL","ARS"]){
 const cur=stringToHex(code,{size:32});
 const pc=await c.readContract({address:process.env.NEXT_PUBLIC_DIAMOND_ADDRESS,abi,functionName:"getPriceConfig",args:[cur]});
 console.log(code,"buyPrice",pc.buyPrice.toString(),"=",Number(pc.buyPrice)/1e6,"fiat/USDC");
}})();'
```

Expected (current, buggy) output:

```
INR buyPrice 91000000 = 91 fiat/USDC
BRL buyPrice 1000000000 = 1000 fiat/USDC   <-- WRONG (should be ~5.4)
ARS buyPrice 0 = 0 fiat/USDC               <-- UNCONFIGURED
```

---

## Files referenced

- `frontend/lib/pricing.ts` — on-chain price read + `usdcForFiat` inversion (generic, correct)
- `frontend/lib/rates.ts` — market-rate *reference* only; INR uses subgraph, others CoinGecko
- `frontend/app/qr/page.tsx` — Accept-page estimate (uses on-chain price, generic)
- `frontend/components/CheckoutWidget.tsx` — passes `usdcAmount` to the p2p widget
- `node_modules/@p2pdotme/widgets/dist/checkout.js` — widget's fiat/fee formula (the display math)
