# PayQR Vault — Design & Security (as built)

**Status:** implemented, tested (94 passing), self-audited. Ready for Aash's review
before redeploy/whitelist.
**Goal (from the team):** move fund custody out of the integrator into a separate
**Vault** so we can (1) yield idle balance *long-term*, (2) migrate the integrator
without moving funds, and (3) lock funds + shut the integrator down if it looks
compromised. Aash: *"Pay special attention to how an integrator is connected to
vault — that logic should be airtight."* This doc is the airtight link, spelled out.

**Decisions locked in (from the team):**
- **No yield / no strategy in v1.** Funds stay 100% liquid. The vault is custody +
  migration + kill-switch only. A future owner-gated `setStrategy` can slot in later
  *without changing `pull`* — but there is zero yield code in this version, so there
  is zero yield attack surface.
- **Multi-owner, not multisig-in-contract.** Both the vault and the integrator have a
  **set of owners**, each with full access. The deployer is the first owner; more can
  be seeded at construction or added later. The last owner can never be removed.
- **RBAC kept in the integrator.** The 5-tier role system (NONE/VIEWER/SUPPORT/
  MANAGER/FINANCE) is unchanged; owners sit above it (effective FINANCE).

---

## 1. Before → after

**Before:** all merchant USDC lived *inside* `MerchantTerminalIntegrator`. Invariant
`usdc.balanceOf(integrator) >= totalOwed`. A new integrator would need every
merchant's funds physically moved; a compromised integrator had direct custody.

**After:** all USDC lives in **`PayQRVault`**. The integrator keeps ALL accounting
(buckets, `totalOwed`, roles, limits, settlement) but **holds no funds** — it asks
the vault to move USDC via `pull`. New invariant: **`vault.balance() >= totalOwed`**.

```
                 ┌────────────────────────┐
   USDC in  ───► │  merchant proxy        │
                 └───────────┬────────────┘
                             │ onOrderComplete pulls proxy→integrator
                             ▼
                 ┌────────────────────────┐        ┌───────────────────┐
                 │  Integrator            │ ─push─► │  Vault (custody)  │
                 │  (accounting only:     │ _toVault│  holds ALL USDC   │
                 │   buckets, totalOwed,  │ ◄─pull─ │  100% liquid (v1) │
                 │   roles, limits)       │ _vaultPull  lockable        │
                 └────────────────────────┘         └───────────────────┘
                             │ withdrawals → vault.pull(to, amount)
                             ▼
                    merchant wallet / proxy / LP
```

Because `UserProxy.transferERC20ToIntegrator` is hardcoded to send to `integrator()`,
the deposit path is **proxy → integrator → vault** (`onOrderComplete` pulls off the
proxy, then `_toVault` forwards into custody). This avoids any change to the pinned
UserProxy.

---

## 2. The integrator ↔ vault link — **airtight** (the security core)

The vault is deliberately **dumb about ownership, smart about access**. It does not
re-derive who is owed what (that is the integrator's tested job). It guarantees
exactly one thing: *only the one linked integrator can move USDC, and never while
locked.*

### 2a. `pull` is the ONLY exit, tightly shaped
```solidity
function pull(address to, uint256 amount)
    external onlyIntegrator whenNotLocked nonReentrant
{
    if (to == address(0) || amount == 0) revert BadPull();
    usdc.safeTransfer(to, amount);
    emit Pulled(to, amount);
}
```
No `pullFrom`, no arbitrary `call`, no `approve` to third parties. One function, one
token (USDC), guarded by **onlyIntegrator + whenNotLocked + nonReentrant**. Small
surface = auditable.

### 2b. Only the ONE linked integrator can pull
```solidity
address public integrator;                 // the single authorised caller
modifier onlyIntegrator() { if (msg.sender != integrator) revert NotIntegrator(); _; }
```
The vault never trusts a caller-supplied "who I am" — it checks `msg.sender ==
integrator` directly. An old integrator is powerless the instant the vault repoints.

### 2c. **The mutual handshake** — the link cannot desync ⭐
This is the part that makes the two-sided link airtight, and it was added *because of
the audit* (see §5). The vault refuses to authorise an integrator that isn't itself
pointed back at the vault:
```solidity
function setIntegrator(address next) external onlyOwner {
    if (next != address(0) && IIntegratorLink(next).vault() != address(this))
        revert LinkMismatch();
    integrator = next;
    emit IntegratorSet(prev, next);
}
```
- You **cannot** point the vault at an integrator whose `vault` doesn't already equal
  this vault. So deposits (`integrator → vault` via `_toVault`) and withdrawals
  (`vault → integrator` via `pull`) can **never** target mismatched custody.
- The switch is **atomic in one tx**: the moment `setIntegrator` returns, the old
  integrator can't pull and the new one can. There is no window where both, or
  neither, are authorised.
- `setIntegrator(address(0))` skips the check — it only *disables* pulls (belt-and-
  braces with `lock()`), authorising nothing.

Correct wiring order for a migration is therefore forced:
`newIntegrator.setVault(theVault)` → `vault.setIntegrator(newIntegrator)`. The
handshake makes an asymmetric link impossible to commit.

### 2d. Kill-switch (break-glass)
```solidity
bool public locked;
function lock()   external onlyOwner { locked = true;  emit Locked(msg.sender); }
function unlock() external onlyOwner { locked = false; emit Unlocked(msg.sender); }
modifier whenNotLocked() { if (locked) revert VaultLocked(); _; }
```
If the integrator looks compromised, any owner calls `lock()` → every `pull` reverts
until `unlock()`. Merchants can't withdraw during a freeze either — that's the price
of the safety switch; it's break-glass, not a normal state.

---

## 3. Multi-owner governance (both contracts)

```solidity
mapping(address => bool) public isOwner;
uint256 public ownerCount;
modifier onlyOwner() { if (!isOwner[msg.sender]) revert NotOwner(); _; }
```
- A **set** of owners, each with full access (add/remove owners, `setIntegrator`,
  `lock`/`unlock` on the vault; plus `setVault`, `setRole`, recovery, etc. on the
  integrator).
- Deployer is the first owner; extras can be seeded at construction (`_owners[]`) or
  added later.
- **The last owner can never be removed** (`ownerCount == 1` guard) — the contract
  can't be orphaned.
- On the integrator, an owner's **effective role tier is FINANCE** (top), so the
  existing hierarchical `onlyRole` checks admit owners automatically.

`transferOwnership(new)` is a back-compat 1→1 handoff (add `new`, drop caller). A
**self-transfer is rejected** (`newOwner == msg.sender` reverts) so it can't silently
evict the caller — an audit fix (§5).

> **Note on trust:** the vault owner-set and the integrator owner-set are independent.
> In practice they should be the **same** set (ideally each a multisig). A vault owner
> who is not an integrator owner can `lock()` or `setIntegrator(...)`; keep the sets
> aligned operationally. The handshake (§2c) already prevents the dangerous *pointing*
> mistakes; owner-set alignment is a key-management policy, documented here so the
> reviewer can enforce it.

---

## 4. The 12 money-movement points (integrator)

All fund movement goes through three helpers so there is exactly one way in and one
way out of custody:

```solidity
function _toVault(uint256 amount) internal {           // integrator → vault (in)
    if (amount > 0 && vault != address(0)) usdc.safeTransfer(vault, amount);
}
function _vaultPull(address to, uint256 amount) internal {   // vault → to (out)
    if (vault == address(0)) revert VaultNotSet();
    if (amount > 0) IPayQRVault(vault).pull(to, amount);
}
function _pool() internal view returns (uint256) {     // solvency base
    uint256 held = usdc.balanceOf(address(this));
    return vault == address(0) ? held : IPayQRVault(vault).balance() + held;
}
```

| Point | Flow |
|-------|------|
| `onOrderComplete` (BUY settle) | proxy → integrator (`transferERC20ToIntegrator`) → `_toVault(amount)`; then `_creditBucket` (+`totalOwed`) |
| `withdrawUSDC` | `_deductUnlocked` (−`totalOwed`) → `_vaultPull(merchant, amount)` |
| `_withdrawFiat` (SELL placement) | `_deductUnlocked` → `_vaultPull(merchantProxy, amount)` |
| `deliverFiatPayout` fee | `_deductUnlocked(topUp)` → `_pool() < topUp` check → `_vaultPull(merchantProxy, topUp)` |
| `reconcileWithdrawal` | sweep proxy → integrator → `_toVault(proxyBal)`; re-credit capped at `proxyBal` |
| `adminAbortWithdrawal` | same sweep + re-credit |
| `adminForceSettle` | same sweep + re-credit |

**Solvency proof sketch** (verified in the audit, §5): every `+totalOwed`
(`_creditBucket`) is preceded in the same tx by USDC actually landing in the vault
(`_toVault`), and every `−vault` (`_vaultPull`) is preceded by a `−totalOwed`
(`_deductUnlocked`) of the same amount that *reverts if the unlocked balance is
short*. Recovery re-credits are capped at the physically-swept `proxyBal`. So
`vault.balance() >= totalOwed` holds across all 12 points. The offramp fee is charged
to the withdrawing merchant (debited from their own buckets), never the pool.

---

## 5. Security review — what the audit found & fixed

An adversarial multi-agent audit (3 attackers on the vault-link, multi-owner, and
lifecycle/solvency; every finding independently verified by a separate skeptic;
17 raw findings → 6 confirmed after verification; plus a completeness critic). Result:
**the access-control and solvency core was already sound** (only-integrator pull, no
bypass, reentrancy-guarded, invariant preserved across every path). Three real issues
were found and **all three are now fixed**:

| Sev | Issue | Fix |
|-----|-------|-----|
| MEDIUM | `onOrderComplete` reverted if `vault == 0` (integrator-first deploy, before `setVault`). Because the Diamond try/catches the callback *after* sending USDC to the proxy, a completion in that window could strand the deposit on the proxy with no recovery. | **Credit-and-hold.** `_toVault` no longer reverts on `vault == 0` — the USDC simply stays on the integrator (its only exits are vault-gated, so it can't leak) and the merchant is still credited. Owner calls **`flushToVault()`** once the vault is wired to forward the held balance. The deposit/credit path is now infallible — a completion callback can never revert on operator wiring state. |
| **(critic)** | **Migration desync**: the two-sided link was two independent writes with no mutual check; and `totalOwed` (accounting) is integrator-local while the vault balance is global, so a fresh integrator would start `totalOwed = 0` while inheriting the whole vault balance. | **Mutual handshake** (§2c): `vault.setIntegrator` requires the candidate to point back → the link can't be asymmetric. **`migrateState(prior)`** (§6): a one-shot, owner-only, `totalOwed == 0`-guarded copy of the prior integrator's `totalOwed`, so accounting matches the custody it adopts at cutover. |
| LOW | `transferOwnership(self)` with ≥2 owners silently evicted the caller (fell through to the drop-caller branch). | Reject `newOwner == msg.sender` explicitly. |

Findings the auditors raised but that were **verified as non-issues** (documented so
the reviewer needn't re-derive them): direct-donation to a proxy can only *gift* a
merchant their fee (no fund loss, invariant intact); the surplus-on-proxy asymmetry
means the vault can hold *more* than `totalOwed`, never less.

---

## 5b. Second (whole-system) audit + payout-handle privacy

After the link fixes, a **second, broader** adversarial audit ran over the *entire*
system (vault + integrator + proxy + payout handling) across 5 lenses — fund/solvency,
access-control, migration-lifecycle, reentrancy/ordering, and **payout-handle
privacy** — each finding independently verified (2 auditors/lens; 20 raw findings → the
verified set below). **The fund logic, access control, migration link, and reentrancy
all came back CLEAN** (every lost-funds / solvency / access / reentrancy claim was
refuted on verification). Two things were actioned:

| Sev | Issue | Fix |
|-----|-------|-----|
| **HIGH→fixed** | **Payout handle stored & logged in plaintext.** The merchant's real UPI/PIX/CBU id was written to public storage (`merchants[].payoutId`), returned by `getMerchantInfo`, and emitted in `MerchantRegistered`/`MerchantProfileUpdated`. On a public chain this maps every merchant wallet → their real-world bank/UPI identity (PII leak; not a fund risk, but enables targeted fraud/doxxing). | **Encrypt the handle on-chain to the merchant key.** The field is now `bytes encPayoutId` — the app encrypts the handle **client-side** to the merchant's relay pubkey before sending; the contract stores an **opaque, non-empty blob it never decodes**. It is **removed from both events entirely** and `getMerchantInfo` returns only the ciphertext. A dedicated test proves the plaintext never appears in storage or any log. |
| INFO | `finalizeWithdrawal` lacked `nonReentrant` (all other settle paths have it). Not exploitable today (its only external call is a `view` staticcall + a flag flip, no value movement), but an inconsistency. | Added `nonReentrant` for defense-in-depth/consistency. |

The completeness critic's remaining hunches (a MANAGER self-setting `trustedRelayer` to
grief a fee; migration stranding an in-flight slot; a bucket-cap re-lock edge) were each
**independently verified and rejected** as griefing/edge cases with no fund-loss,
solvency, or access impact — several already covered by existing recovery paths. They
are noted here so the reviewer needn't re-derive them.

> **⚠️ FRONTEND REQUIREMENT (must ship together with this contract).**
> There is NO backend in this system — the encryption happens entirely **in the
> merchant's browser**, and the ciphertext lives on-chain. The privacy guarantee
> depends on the app encrypting the payout handle before it is ever sent. Concretely:
> - `registerMerchant` / `registerMerchantRaw` / `updateProfile` now take **`bytes`
>   (ciphertext)**, not a plaintext `string`. The app must encrypt the UPI/PIX handle
>   to the merchant's relay pubkey (the same secp256k1 identity already used for the
>   SELL flow) and pass the resulting blob.
> - `getMerchantInfo()[0]` now returns **ciphertext bytes** — the app decrypts it
>   in the merchant's browser for display, and decrypts it locally at withdraw time
>   before re-encrypting the payout payload to the LP (the existing
>   `deliverFiatPayout` flow — unchanged).
> - The `MerchantRegistered` / `MerchantProfileUpdated` events **no longer carry the
>   handle** — any indexer/subgraph that read it must instead read the (encrypted)
>   value via the getter, or the app supplies it from its own state.
> If the frontend is NOT updated to encrypt, registration will fail to encode (bytes vs
> string) — so there is no silent-plaintext failure mode, but the app work is required
> for the feature to function.

---

## 6. Migration flow (why this is simpler)

Shipping a new integrator (new logic/fix), funds untouched:
1. Deploy `IntegratorV2` with `_vault = theVault` (so `V2.vault()` points back).
2. **(optional) `V2.migrateState(V1)`** — one-shot owner call copying `totalOwed` so
   V2's aggregate accounting matches the vault balance it's about to control.
   *Caveat:* this copies the scalar `totalOwed` only, **not** per-merchant buckets —
   it's for a controlled cutover where merchant-level state is re-established from V1's
   events, or where V1 is drained first and this is left unused (`totalOwed` stays 0).
3. `vault.setIntegrator(V2)` — passes the handshake (step 1 wired the back-pointer);
   **V1 can no longer pull, V2 can, atomically**. No USDC moved.

Compared to before, a new integrator no longer needs every merchant's funds
physically transferred — just a pointer change behind the handshake.

---

## 7. Threat model

| Attack | Defense |
|--------|---------|
| Random contract calls `vault.pull` | `onlyIntegrator` — hard `msg.sender` check |
| Compromised integrator drains vault | `lock()` freezes all pulls in one tx (any owner) |
| Attacker swaps the integrator | `setIntegrator` is `onlyOwner` **and** requires the mutual handshake |
| **Link pointed at a mismatched integrator/vault** | **handshake (`LinkMismatch`) makes an asymmetric link impossible to commit** |
| Old integrator still pulls after migration | `onlyIntegrator` checks the *new* value; repoint is atomic |
| Deposit stranded before vault is wired | credit-and-hold on the integrator + `flushToVault` — completion never reverts |
| Fresh integrator's accounting desyncs from inherited custody | one-shot `migrateState` seeds `totalOwed` |
| Reentrancy via USDC / callback | `nonReentrant` on `pull`; USDC is callback-free; CEI on the integrator's flagged paths |
| Integrator over-pulls (double spend) | integrator's `totalOwed`/bucket accounting is authoritative and unchanged; `_deductUnlocked` reverts if short |
| Contract orphaned (no owner) | last owner can't be removed |
| `transferOwnership(self)` self-eviction | rejected explicitly |
| **Merchant payout handle (PII) leaked on-chain** | **handle is client-side encrypted to the merchant key; stored as an opaque blob, never in events; raw handle never on-chain** |
| Owner key compromised | owners should be multisigs; keep vault & integrator owner-sets aligned (policy, §3) |

---

## 8. Files & tests

- **`contracts/integrators/merchant-terminal/PayQRVault.sol`** — custody; `pull`
  (only exit), `setIntegrator` (+ handshake), `lock`/`unlock`, multi-owner. No yield
  code.
- **`contracts/integrators/merchant-terminal/MerchantTerminalIntegrator.sol`** —
  accounting unchanged; money routed via `_toVault`/`_vaultPull`/`_pool`; multi-owner
  + RBAC; `setVault`, `flushToVault`, `migrateState`; `transferOwnership` self-guard.
- **Tests (94 passing):** `test/PayQRVault.ts` (airtight pull, handshake/`LinkMismatch`,
  kill-switch, migration, multi-owner) and `test/MerchantTerminalIntegrator.ts`
  (full BUY/withdraw/recovery lifecycles routed through the vault, plus the audit-fix
  block: handshake, vault==0 credit-and-hold + flush, `migrateState`, self-transfer
  guard). `contracts/test/MockVaultIntegrator.sol` backs the vault unit tests.

## 9. Deploy / cutover (vault-first)

1. Deploy `PayQRVault(usdc, [owners…])`.
2. Deploy `MerchantTerminalIntegrator(diamond, usdc, vaultAddr, [owners…])` — the
   `vault` back-pointer is set in the constructor, so the handshake will pass.
3. `vault.setIntegrator(integratorAddr)` — mutual handshake authorises the link.
4. (migration only) `integrator.migrateState(oldIntegrator)` if carrying over
   aggregate `totalOwed`.
5. Whitelist the integrator (`usdcThroughIntegrator = FALSE`) + `proxyImpl`. The vault
   is not whitelisted (it never talks to the Diamond).

*Yield is intentionally out of scope for v1. When it's time, a future `setStrategy`
+ liquid-reserve + auto-recall design plugs into the vault without touching `pull` or
the integrator link — a separate proposal + review.*
