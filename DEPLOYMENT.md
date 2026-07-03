# Deployment Guide — P2PM Merchant Terminal (Base Sepolia)

A frontend-only app: the merchant's browser talks directly to the chain, the
p2p.me subgraph, and thirdweb (auth + gasless smart account). **No backend, no database.**

> Testnet build on Base Sepolia. The settlement lock is 10 minutes (test value).
> No real money moves — the p2p LP simulates the fiat (INR) leg on Sepolia.

---

## Architecture

```
 Merchant browser (Next.js, hosted on Netlify — see netlify.toml)
        │
        ├── Contract via RPC ── balances, registration (shop name + UPI),
        │   (Base Sepolia)       withdrawals, settlement buckets
        │
        ├── Subgraph ─────────── order history
        │
        ├── thirdweb ─────────── gasless smart account (merchant identity + gas,
        │                        in-app wallet login + sponsored ERC-4337)
        │
        └── CoinGecko / subgraph ─ live USDC↔INR rate
```

- **Money + profile truth** = the integrator contract on-chain (read live).
- **Order history** = the p2p.me subgraph (no database).
- **Nothing is stored off-chain.**

---

## Live addresses (Base Sepolia)

> **Source of truth:** `payment-integrators/deployment-record.json` — update BOTH
> that file and this table on every redeploy. `frontend/.env.local` (and the
> hosting platform's env vars) must point at the same integrator + client.

| Thing | Address |
|------|---------|
| Integrator (audited, ready to whitelist) | `0x66Fc15D3CC89f0090ca82A1308CbeBA85897E80e` |
| proxyImpl | `0x5a8b584067E2AdE97fCc1Cb665885857221Bd587` |
| Price client | `0x5C66483903bcDaAeC8Bc1735cc6D983Ab0ca98bC` |
| p2p Diamond | `0xeb0BB8E3c014D915D9B2df03aBB130a1Fb44beb9` |
| USDC | `0x4095fE4f1E636f11A95820BA2bB87F335Bd1040d` |
| Subgraph | `https://api.studio.thegraph.com/query/1745491/event-indexer/v0.0.6` |

Whitelist params: integrator + proxyImpl above, `usdcThroughIntegrator = FALSE`.

---

## 1. thirdweb (auth + gasless smart account)

thirdweb.com/dashboard → your project:
- **Client ID** (Settings): copy it into `NEXT_PUBLIC_THIRDWEB_CLIENT_ID`. Restrict
  it to your production domain(s) so nobody drains your sponsored quota.
- **In-App Wallets → Auth**: enable the login methods you want (email + Google
  recommended; also available: phone, Apple, Facebook, Discord, X, Telegram,
  Farcaster, passkey). Only enabled methods appear in the login modal.
- **Account Abstraction**: on **testnet it is free and enabled by default** for any
  project with a valid Client ID, so merchant transactions are gasless on Base
  Sepolia (84532) — no paymaster URL to configure. (Mainnet later requires a paid
  plan + billing and an explicit sponsorship policy.)

## 2. Frontend → Netlify (current setup; Vercel works the same way)

1. netlify.com → **Add new site** → import the repo → **Base directory `frontend`**
   (also declared in the root `netlify.toml`).
2. Add the `NEXT_PUBLIC_*` env vars (see `frontend/.env.example`):
   THIRDWEB_CLIENT_ID, CHAIN=baseSepolia, RPC_URL, CONTRACT_ADDRESS, CLIENT_ADDRESS,
   DIAMOND_ADDRESS, USDC_ADDRESS, SUBGRAPH_URL — CONTRACT/CLIENT must match the
   "Live addresses" table above.
3. Deploy → Netlify builds Next.js and gives an `https://…netlify.app` URL.

## 3. Verify

- Open the URL → log in → register (shop name + UPI, on-chain) → New Sale →
  the QR generates → on completion the proof card shows real Basescan links.
- Everything is verifiable on https://sepolia.basescan.org.

---

## Notes / limits (testnet)

- **10-minute settlement** (test value), not the 30-day production lock.
- **No real INR** — the LP simulates the fiat leg on Sepolia.
- **Free Alchemy RPC** — fine for a demo; the withdrawal-history event scan is
  light but can be slow under rate limits.
- The contract is **deployed from `payment-integrators/`**
  (`npx hardhat run scripts/deploy-merchant-terminal.ts --network baseSepolia`).
  Any logic change requires a redeploy **and** re-whitelisting by the p2p team.
