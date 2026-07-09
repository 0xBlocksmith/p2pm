# Privacy Policy

**Application:** PayQR — a non-custodial merchant payment terminal
**Version:** 1.0.0
**Last updated:** 9 July 2026
**Network status:** Testnet build (Base Sepolia). No real money moves.

---

## 0. Read this first

PayQR is not a company, a bank, a money-services business, or any other legal
entity. It is a decentralized application (a "dapp") — a piece of open-source
software that runs entirely in your own web browser and talks directly to a
public blockchain. There is no operator sitting between you and the chain, and
there is no server that quietly collects your data on the side. When this
document says "we," it means the people who publish this code, and the only
thing "we" can actually do to your data is decide what the code does — not
where your data lives or who can read it once it is on a public ledger.

Because of that, this Privacy Policy is unusual. Most privacy policies describe
what a business does with the personal information it holds. PayQR holds
almost nothing. The honest, complete version of this document is mostly a list
of things we do **not** collect, do **not** store, and could **not** hand over
even if we wanted to — plus a clear warning about the one place where your
information genuinely is public and permanent: the blockchain itself.

---

## 1. What PayQR actually is (so the rest makes sense)

PayQR is a front-end-only application. When you open it, your browser loads a
static website and then does everything locally: it connects a wallet, reads
balances and prices from the blockchain, builds transactions, and asks you to
approve them. The three external things it talks to are all infrastructure, not
data collectors working on our behalf:

- **A public blockchain** (currently Base Sepolia, an Ethereum test network),
  where merchant registration, balances, settlements, and withdrawals live.
- **A wallet and gas-sponsorship provider** (thirdweb) that lets you log in and
  sign transactions without holding raw private keys or paying network fees.
- **A public data indexer** (a "subgraph") that reads the blockchain and returns
  your order history, so the app can show past sales without any database.

There is **no PayQR backend, no PayQR database, and no PayQR user account**. We
do not run a server that stores your sales, your customers, your balances, or
your identity. Everything the app shows you is read live from the public chain
or from your own browser's local storage.

---

## 2. Information the app never collects

To be blunt about the things people usually worry about:

- We do **not** collect your name, your email, or your phone number on a PayQR
  server — because there is no PayQR server. If you log in with email or a
  social account, that authentication is handled by your chosen wallet provider,
  not by us, and is governed by that provider's own privacy policy.
- We do **not** collect your customers' identities, card numbers, or bank
  details. PayQR never sees a card or a bank login; the fiat leg of a payment
  is handled peer-to-peer by independent liquidity providers through the
  underlying protocol.
- We do **not** run analytics, advertising, tracking pixels, fingerprinting, or
  third-party marketing trackers inside the app.
- We do **not** build a profile of you, sell data, or share data with
  advertisers — there is nothing to sell and no mechanism to sell it.
- We do **not** operate customer-support tooling that reads your transactions.
  If you contact whoever is helping you, you decide what to share.

---

## 3. Information that is stored — and exactly where

There are only two places any information related to you exists, and neither of
them is a PayQR-controlled server.

### 3.1 On the public blockchain (permanent and public)

This is the important one. When you use PayQR, certain actions write data to a
public blockchain that anyone in the world can read, forever. This is inherent
to how a dapp works — it is a feature, not a leak, but you must understand it.
The following are recorded on-chain:

- Your **wallet address** (a public account identifier).
- Your **shop name**, submitted during registration.
- Your **payout identifier** — for example your UPI ID, PIX key, or CBU/alias —
  which you enter so that settlements can reach you. Treat this as public.
- Your **settlement currency** (e.g. INR, BRL, ARS), locked at registration.
- Your **balances, orders, settlements, and withdrawals**, as they occur.

Blockchain data is public, permanent, and cannot be edited or deleted — not by
us, and not by you. Anyone can view it (for example on a block explorer such as
Basescan). Do not put anything on-chain that you are not comfortable making
public. In particular, your payout ID and shop name are visible to anyone who
looks at your merchant record.

### 3.2 In your own browser (local, and only yours)

The app keeps a small amount of state in your browser's local storage so it can
work smoothly: your selected country and language, your onboarding progress, an
in-progress sale so a refresh doesn't lose it, and a cryptographic "relay
identity" used to receive encrypted payout instructions from liquidity
providers. This data lives on your device, under your control. It is never sent
to a PayQR server (there isn't one). When you log out, the app deliberately
clears this per-merchant state so that a shared device does not leak one
merchant's payout key or shop name into the next person's session.

---

## 4. Third-party infrastructure you inevitably touch

Running a dapp still means loading code and making network requests, and those
requests reach independent providers who have their own policies. Using PayQR
means you also interact with:

- **A blockchain RPC provider**, which relays your read and write requests to
  the chain and can, like any network intermediary, see request metadata such as
  your IP address.
- **A wallet / authentication / gas-sponsorship provider** (thirdweb), which
  manages login and account abstraction. Your login method and its associated
  data are handled under that provider's privacy terms.
- **A blockchain indexer / subgraph**, which serves your order history read from
  public chain data.
- **A hosting/CDN provider** (currently Netlify) that serves the static app
  files, and may log standard request metadata like IP and user agent as any web
  host does.

We do not control these providers and do not receive your data from them. Their
handling of any metadata is governed by their own privacy policies, not this
one. We name them here so you know who is actually in the path.

---

## 5. Cookies and tracking

PayQR does not set advertising or tracking cookies and does not embed
third-party trackers for marketing. The only client-side storage is the
functional local-storage state described in Section 3.2, which exists purely to
make the app usable. Third-party infrastructure providers (Section 4) may set
their own technical cookies or log requests as part of delivering their service.

---

## 6. Your control over your data

Because there is no central operator holding your information, the controls are
different from a normal service:

- **Browser data:** you can clear it at any time by logging out (which wipes the
  per-merchant state) or by clearing your browser storage.
- **On-chain data:** this cannot be deleted, corrected, or hidden by anyone,
  including us. This is a permanent property of public blockchains. The only way
  to avoid on-chain disclosure of something is to not submit it in the first
  place.
- **Data-subject requests:** there is no database for us to search, export, or
  erase on your behalf, because we do not hold your personal data. Requests of
  that kind can only meaningfully be directed at the independent providers in
  Section 4, under their own policies.

---

## 7. Children

PayQR is intended for merchants operating a business and is not directed at
children. Do not use it if you are not old enough to enter into a binding
agreement where you live.

---

## 8. Security, and its limits

The app is designed to keep sensitive material — such as your relay identity and
your wallet session — on your own device and to clear it on logout. But no
software is perfectly secure, and a dapp shifts a lot of responsibility onto
you. You are responsible for the security of your device, your browser, your
login method, and your wallet. If someone gains access to your logged-in device
or your wallet, they can act as you. We cannot freeze, reverse, or recover funds
or transactions on your behalf.

---

## 9. Changes to this policy

Because this document lives in the code repository alongside the app, it is
versioned like the code. If it changes, the version number and "last updated"
date at the top change with it, and the history is visible in the repository.
Continuing to use the app after a change means you accept the current version.

---

## 10. No warranty, no legal entity, no promises we cannot keep

This is open-source software provided as-is, with no warranty of any kind. There
is no company behind it, no support desk that owes you a response, and no entity
that can be held to a service level. The purpose of this Privacy Policy is not
to reassure you that a business is protecting your data — it is to tell you the
truth: almost none of your data is in our hands, the part that is public is
public forever on the blockchain, and everything else lives on your own device.
Use the app only if you understand and accept that.
