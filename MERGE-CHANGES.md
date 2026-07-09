# What Changed — `feat/vault-custody-payout-encryption` merged into `rebranded-app`

**Merge commit:** `6af6bdb`
**Your branch tip before merge:** `7a799c9` (Fixed the Currency conversion for BRL)
**Merged branch tip:** `a4897ef`
**Date:** 9 July 2026
**Totals:** 31 files changed · **+3,265 / −743**

This document explains everything the merge brought into your `rebranded-app`
branch, in plain terms — what was added, what changed, what was removed, and the
one conflict that mattered and how it was resolved. Nothing was pushed; this is
all local.

---

## The headline: three big things arrived

1. **Segregated Vault custody** — merchant funds no longer live inside the
   integrator contract; they move to a separate, lockable `PayQRVault`.
2. **Client-side encrypted payout handles** — your UPI / PIX / CBU is now
   encrypted in the browser before it ever touches the chain, instead of sitting
   on-chain in the clear.
3. **Single on-chain price source** — the old off-chain rate estimate
   (`lib/rates.ts`) was removed and replaced by `lib/price.ts`, which prices off
   the exact same on-chain values the checkout widget uses. This is the piece
   that overlapped with your BRL currency work (see "The one real conflict").

Everything else is supporting fixes for reliability (relay identity, sponsored
transactions, checkout LP pre-check).

---

## New files added

| File | What it is |
|---|---|
| `payment-integrators/contracts/integrators/merchant-terminal/PayQRVault.sol` | The new **Vault** contract. Holds all merchant USDC; the integrator now holds no funds and only does accounting. Multi-owner, lockable (kill-switch), no yield in v1. |
| `payment-integrators/contracts/test/MockVaultIntegrator.sol` | Test helper for the vault ↔ integrator link. |
| `payment-integrators/test/PayQRVault.ts` | Vault test suite. |
| `payment-integrators/docs/VAULT-DESIGN.md` | Full design + security writeup of the vault (the "airtight" integrator↔vault link), 322 lines. |
| `frontend/lib/price.ts` | New **on-chain pricing** module. Reads the Diamond's `buyPrice`/`sellPrice`, small-order threshold and fee, and inverts the widget's own formula so the Accept page and the checkout Order Summary always agree. |
| `frontend/lib/payoutCrypto.ts` | **Payout-handle encryption** helpers (`encryptPayout` / `decryptPayout`). Encrypts your UPI/PIX/CBU to your own relay key in the browser, stores only ciphertext on-chain. |
| `frontend/patches/@p2pdotme+widgets+1.4.0.patch` | A `patch-package` patch pinning a fix into the p2p widgets dependency. |
| `ISSUE-price-mismatch.md` | Writeup of the price-mismatch bug that the on-chain pricing change fixes. |

---

## Files removed

| File | Why |
|---|---|
| `frontend/lib/rates.ts` | **Deleted.** This was the off-chain rate estimate (subgraph average / CoinGecko / static fallback). It was the sole reason the Accept page and the checkout total could disagree. All pricing is now on-chain via `lib/price.ts`. |

> Note: `frontend/lib/pricing.ts` still exists but is now unused (orphaned) after
> this change. It was left untouched by the merge and can be cleaned up later — it
> does nothing and breaks nothing.

---

## Smart-contract changes (the vault model)

**Before:** every merchant's USDC sat *inside* `MerchantTerminalIntegrator`.
Replacing the integrator would mean physically moving every merchant's funds, and
a compromised integrator had direct custody of the money.

**After:** all USDC lives in **`PayQRVault`**. The integrator keeps *all* the
accounting (balances, `totalOwed`, roles, limits, settlement) but **holds no
funds** — it asks the vault to move USDC via a `pull` call. The deposit path is
`proxy → integrator → vault`; withdrawals are `vault.pull(to, amount)`.

Why this matters (the team's three goals):
- **Yield later** — idle balance can eventually earn yield (no yield code in v1,
  so no yield attack surface yet).
- **Migrate the integrator** without moving funds.
- **Kill-switch** — funds can be locked and the integrator shut down if it ever
  looks compromised.

Other contract-side changes:
- **Multi-owner** model on both vault and integrator (a *set* of owners, each
  with full access; the last owner can't be removed) — plus a super-admin tier.
  The existing 5-tier RBAC (NONE/VIEWER/SUPPORT/MANAGER/FINANCE) is unchanged;
  owners sit above it.
- `MerchantTerminalIntegrator.sol` reworked to route custody to the vault
  (+433 / large change), with its test suite expanded accordingly.
- `deployment-record.json` bumped to **v12**; `deploy-merchant-terminal.ts` and
  `hardhat.config.ts` updated to deploy the vault stack.

---

## Frontend changes

**Pricing (`dashboard`, `qr`, `withdraw`):**
- All three pages moved off `fetchUsdcRate` (`lib/rates.ts`) onto the on-chain
  `lib/price.ts`. The dashboard and withdraw now value USDC at the on-chain
  **sell** price; the Accept page prices off the on-chain **buy** price — so what
  the merchant sees matches what the widget charges, by construction.
- The Accept (`qr`) page gained a **pre-flight liquidity-provider check** with a
  calm "connecting…" wait, instead of failing abruptly when no LP is ready.

**Payout encryption (`settings`, `login`, `onboarding`):**
- Your payout handle (UPI/PIX/CBU) is encrypted to your own relay key before
  going on-chain, and decrypted back in the browser for display.
- Cross-device caveat handled gracefully: on a new device (new relay key) the old
  ciphertext can't be decrypted, so the UI shows a neutral `•••• (saved)` label
  rather than garbage; re-entering the handle re-encrypts it. No funds are ever at
  risk — this value is display/pre-fill convenience only.
- Currency is locked at registration; preferences handling made safer.

**Reliability:**
- **Relay identity** now writes its *full* identity into the SDK store so orders
  aren't silently blocked (`useRelayIdentity.ts`, `lib/p2p.ts`).
- **Sponsored transactions** auto-retry on transient thirdweb bundler errors
  (`useSmartAccount.ts`).
- Minor touch-ups to `CheckoutWidget`, `WalletSheet`, `contract.ts`,
  `receipt`, `transactions`.

**Dependencies:**
- `package.json` / `package-lock.json` updated for the p2p SDK/widgets and
  `patch-package` (which applies the widgets patch above on install).

---

## Your own work — all preserved

None of your `rebranded-app` work was dropped. The merge kept:
- Your **withdraw UI redesign** (destination chooser, two-balance display,
  multi-step USDC confirm flow) — only its *pricing engine* was swapped to the
  on-chain sell price.
- Your **branding** ("PayQR") — identical on both sides, nothing lost.
- Your settings/shop-editing UI, receipt links, and the rest of the rebranded
  app.

---

## The one real conflict (and how it was resolved)

Both branches had worked on **pricing** at the same time:

- **Your side (`rebranded-app`):** the BRL currency-conversion fix, still built on
  the off-chain `lib/rates.ts` estimate.
- **The feature side:** removed `lib/rates.ts` entirely and replaced it with the
  on-chain `lib/price.ts` "single source of truth."

These were two solutions to the **same problem** (screens showing different
numbers for the same currency). The resolution took the **feature branch's
on-chain approach** for all pricing, because it's the fuller fix — it makes the
Accept page and the widget agree by construction, which is exactly what your BRL
fix was also trying to achieve. Your BRL-specific patch is therefore superseded,
not lost: the underlying issue it addressed is now handled on-chain for every
currency.

Files touched by this conflict: `dashboard/page.tsx`, `qr/page.tsx`,
`settings/page.tsx`, `withdraw/page.tsx`, and the `rates.ts` deletion.

---

## Verification done

- **Typecheck passed** (`tsc --noEmit`, exit 0) — no dangling imports of the
  deleted `rates.ts`.
- No conflict markers remain anywhere.
- No unmerged paths; the merge is a clean commit with both parents
  (`7a799c9` your tip + `a4897ef` the feature tip).

**Not yet done / suggested next steps:**
- Run the contract test suite (`cd payment-integrators && npm test`) to confirm
  the vault tests pass in your tree.
- Run the app (`cd frontend && npm run dev`) and sanity-check a checkout + a
  withdrawal, since pricing and the withdraw flow both changed.
- Consider deleting the now-orphaned `frontend/lib/pricing.ts`.
- The vault contracts need re-deploy + re-whitelisting by the p2p team before any
  of the custody change is live.

---

*This is local only — nothing was pushed. The merge commit is `6af6bdb` on
`rebranded-app`.*
