# Issue: Non-INR currency pricing is wrong (BRL massively overpriced, ARS unpriceable)

**Status:** App-side mitigations DONE · underlying on-chain price fix still OPEN (protocol-side)
**Severity:** High (customers overcharged ~185× on BRL; ARS orders cannot be placed)
**Reported:** 2026-07-08 (BRL test order, see screenshot) · **Filed by:** review
**Last updated:** 2026-07-08

> **TL;DR of the update:** the root cause is unchanged — BRL/ARS have wrong
> on-chain prices on the Diamond, which only the protocol admin can fix via
> `setPriceConfig`. On the app side we have since (a) removed the external FX
> rate so every screen shows ONE p2p rate, (b) switched dashboard/withdraw to
> the sell price, and (c) fixed the BRL/ARS amount-typing denomination. These
> make the app self-consistent and readable, but a BRL/ARS checkout is still
> economically wrong until the on-chain price is corrected. See
> **[App-side changes already shipped](#app-side-changes-already-shipped)**.

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

There *was* one genuinely INR-only piece of code — the market-rate *reference*
in `lib/rates.ts` (INR used the p2p subgraph; others used CoinGecko). It only
affected the pre-submit "≈ X" estimate, not the charged price, so it was never
the cause of this bug. It has since been removed entirely (see
[App-side changes already shipped](#app-side-changes-already-shipped)):
`lib/rates.ts` now sources every currency from the on-chain p2p price, with no
external FX at all.

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

### App-side mitigations still worth doing (defensive, until the data is fixed)

These don't fix the price but stop the app from presenting a broken one — NOT
yet implemented:

- **Gate unpriced currencies in the terminal.** `fetchPriceConfig` returns
  `null` when `buyPrice <= 0`, so the qr page could hide/disable any currency
  with no on-chain price (catches **ARS** today, which is still selectable).
- **Warn on a mispriced currency.** Sanity-check the on-chain rate against a
  reference and surface "pricing unavailable — contact support" when they
  diverge wildly (would catch **BRL** at 1000 today). Note: since the app no
  longer fetches an external reference rate (see below), this check would need a
  hardcoded plausibility band per currency, or a re-introduced read-only
  reference used *only* for the sanity check (never for charging).

---

## App-side changes already shipped

Since this issue was filed, the following app-side work landed on
`rebranded-app`. **None of it fixes the underlying wrong on-chain price** — that
is still protocol-side — but together they make the app self-consistent and stop
compounding the confusion:

1. **Removed the external FX rate; one p2p rate everywhere.**
   `lib/rates.ts` no longer calls CoinGecko. `fetchUsdcRate(country, side)` now
   sources every currency from the on-chain p2p price (`getPriceConfig`), then
   the p2p subgraph settled-order average, then a static offline fallback — no
   external exchange API. Previously the Accept/Withdraw pages showed a *market*
   rate while checkout charged the *on-chain* rate, so the merchant saw two
   different numbers for the same currency (worst on BRL). Now the estimate the
   merchant sees matches what the widget charges. On testnet the on-chain rate
   may be economically "wrong" (BRL 1000) — but it's shown consistently, which
   was the explicit intent.

2. **Dashboard & Withdraw now value USDC at the SELL price.**
   `PriceConfig` now carries `sellPrice`; `fetchUsdcRate(country, "sell")` is
   used on the dashboard and withdraw pages so "your balance is worth ≈ X" and
   "you'll withdraw ≈ X" reflect the merchant cash-OUT rate (sell), while the
   Accept page keeps the customer BUY rate. Live values: INR buy 91 / sell 89,
   BRL buy 1000 / sell 990.

3. **Fixed BRL/ARS amount-typing denomination.**
   The live keypad display (`fmtTyped` in `app/qr/page.tsx`) formatted the
   integer part with `toLocaleString(locale)`, so for `pt-BR`/`es-AR` (which use
   "." as the THOUSANDS separator) "1000" rendered as "1.000" — reading like a
   decimal, and "1000.50" became the ambiguous "1.000.50" colliding with the
   keypad's "." decimal key. It now always groups with a comma and keeps "." as
   the decimal ("1,000" / "1,000.50"), unambiguous and consistent with what was
   typed. (`fmtFiat`, used for settled/quoted values, stays locale-aware — there
   "R$1.000" for one thousand is the *correct* Brazilian convention.)

4. **Resume screen shows the session's own currency.**
   The "Payment in progress" panel formatted the pending amount with the current
   `country`, which can revert to the merchant's home currency on remount — so a
   BRL/ARS session could show the ₹ symbol / INR grouping. It now resolves and
   formats in the currency the session was started in.

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

- `frontend/lib/pricing.ts` — on-chain price read (`buyPrice` + now `sellPrice`) + `usdcForFiat` inversion (generic, correct)
- `frontend/lib/rates.ts` — USDC→fiat rate; now p2p-only (`getPriceConfig` → subgraph → static), `side: "buy" | "sell"`; no external FX
- `frontend/app/qr/page.tsx` — Accept-page estimate (on-chain buy price); `fmtTyped` denomination fix; resume-currency fix
- `frontend/app/dashboard/page.tsx` — balance valuation, now at the sell price
- `frontend/app/withdraw/page.tsx` — withdraw estimate + fiat→USDC sizing, now at the sell price
- `frontend/components/CheckoutWidget.tsx` — passes `usdcAmount` to the p2p widget
- `node_modules/@p2pdotme/widgets/dist/checkout.js` — widget's fiat/fee formula (the display math)
