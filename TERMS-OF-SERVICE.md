# Terms of Service

**Application:** PayQR — a non-custodial merchant payment terminal
**Version:** 1.0.0
**Last updated:** 9 July 2026
**Network status:** Testnet build (Base Sepolia). No real money moves.

---

## 0. The most important thing on this page

PayQR is **not a company, not a bank, not a payment processor, and not a legal
entity of any kind.** It is a decentralized application — open-source software
that runs in your browser and talks directly to a public blockchain. There is
no business operating it, no office, no support obligation, and no one who can
take custody of your money, freeze a transaction for you, refund you, or step in
when something goes wrong on-chain. These Terms exist to make that unmistakably
clear before you use the software.

If you were hoping there is a company standing behind this that guarantees your
funds or fixes your mistakes: there is not. Everything below follows from that
single fact. Use the app only if you accept it.

---

## 1. What you are agreeing to

By opening, connecting a wallet to, or otherwise using PayQR, you agree to these
Terms. If you do not agree, do not use it. There is no account to close and no
contract to sign — using the software **is** the agreement, and stopping using
it is how you leave.

Because PayQR is code, "these Terms" means the version published alongside the
code you are running. The version and date at the top identify which one applies
to you, and the full history is visible in the repository.

---

## 2. What PayQR does, in plain terms

PayQR is a front-end for a peer-to-peer settlement protocol. It lets a merchant:

- Log in with a wallet (via a third-party wallet/gas-sponsorship provider) and
  register a shop, on-chain, with a shop name and a payout identifier (such as a
  UPI ID, PIX key, or CBU/alias) and a settlement currency.
- Generate a payment QR code so a customer can pay.
- Have the fiat side of that payment settled **peer-to-peer** by independent
  liquidity providers through the underlying protocol — not by PayQR.
- View balances, order history, and settlements read live from the public chain
  and a public indexer.
- Withdraw settled value, either as USDC to their own wallet or as fiat via the
  protocol's cash-out widget.

PayQR itself is only the interface. It never holds your money, never touches a
bank or card rail, and never sits in the middle of a settlement. It builds
transactions and shows you information; **you** approve the transactions and
**the protocol and its liquidity providers** do the settling.

---

## 3. Non-custodial: we never hold your funds

This deserves its own section because it is the crux of everything. PayQR is
**non-custodial**. At no point does PayQR, or anyone who publishes it, hold,
control, or have access to your funds, your wallet keys, or your customers'
money. Your balance lives on-chain in a smart contract that you interact with
directly. When you withdraw, the transaction is sent from your own wallet.

The practical consequences are absolute and non-negotiable:

- We **cannot** reverse, cancel, refund, or "chargeback" a transaction. On-chain
  transactions are final.
- We **cannot** recover funds sent to the wrong place, lost to a mistake, or
  stolen from a compromised wallet or device.
- We **cannot** unfreeze, unstick, or manually settle an order for you.
- We **cannot** access your account "from our side" to help, because there is no
  side and no account we hold.

If a normal payment company could do it for you, assume PayQR cannot.

---

## 4. Your responsibilities

Because there is no operator to lean on, the responsibility that a payment
company would normally carry falls on you:

- **Your wallet and device.** You are solely responsible for the security of
  your login method, your wallet, and the device you use. Anyone with access to
  your logged-in session can act as you.
- **The details you enter.** Your payout identifier, shop name, and settlement
  currency are submitted **on-chain** and are public and permanent. If you type
  the wrong payout ID, settlements may go somewhere you cannot recover them.
  Check everything before you confirm.
- **What you accept payment for.** You are responsible for the legality of your
  business and your transactions where you operate. See Section 6.
- **Your taxes, licenses, and compliance.** PayQR does no tax reporting,
  withholding, KYC, or regulatory filing for you. Whatever the law requires of
  you as a merchant is entirely your responsibility.
- **Understanding what you are doing.** This is blockchain software. If you do
  not understand wallets, on-chain finality, stablecoins, or peer-to-peer
  settlement, learn before you rely on it for real value.

---

## 5. Testnet status — this is not real money yet

The current build runs on **Base Sepolia, a test network.** No real money moves.
The settlement lock is a short test value, the fiat leg is simulated by a
liquidity provider, and prices on the test network may be economically wrong
(for example, some non-INR currencies carry placeholder on-chain prices that do
not reflect real exchange rates). **Do not treat testnet activity as real
payments, and do not rely on testnet balances as if they were money.** If and
when a production network is used, that will be a different context with its own
real-world risk — and none of the "it's only a test" comfort will apply.

---

## 6. Acceptable use

You agree not to use PayQR to facilitate anything illegal where you operate,
including money laundering, terrorism financing, fraud, sanctions evasion, or
the sale of prohibited goods or services. You also agree not to attack, exploit,
or abuse the app, the protocol, its contracts, or the infrastructure it relies
on. Because the app is decentralized, no one can technically stop you from
misusing it — which means the responsibility and the legal exposure for misuse
are entirely yours.

Note that the underlying protocol/integrator may include an administrative
"freeze" capability exercised on-chain by a protocol or integrator
administrator. This is a property of the smart contracts, not a service PayQR
operates on your behalf, and it is not a promise of protection, moderation, or
recourse to you.

---

## 7. Third-party infrastructure

PayQR depends on independent third parties it does not control: a blockchain and
its RPC providers, a wallet/authentication/gas-sponsorship provider, a public
indexer/subgraph, liquidity providers who perform the fiat settlement, and a
hosting/CDN provider that serves the static files. Your use of PayQR is also
subject to those parties' terms. If any of them changes, degrades, goes down,
or disappears, PayQR may stop working in whole or in part, and no one owes you a
fix, a refund, or continuity. We make no promises about their availability,
correctness, or conduct.

---

## 8. Availability and changes

PayQR may change, break, be taken offline, be forked, or stop being maintained
at any time, without notice. Because it is a static, open-source dapp, it may
also continue to exist and run even if no one is maintaining it — with all the
risk that implies. There is no guaranteed uptime, no maintenance commitment, and
no roadmap you can hold anyone to.

---

## 9. No warranty

THE APPLICATION IS PROVIDED "AS IS" AND "AS AVAILABLE," WITH ALL FAULTS AND
WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION
ANY WARRANTY OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE,
ACCURACY, OR NON-INFRINGEMENT. No one warrants that the app is secure,
error-free, uninterrupted, correctly priced, or that settlements will occur,
succeed, or reach you. You use it entirely at your own risk.

---

## 10. Limitation of liability

To the maximum extent permitted by law, no person who authored, published,
contributed to, or hosted this open-source software is liable to you for any
loss or damage of any kind — including lost funds, lost profit, lost data,
failed or delayed settlements, mispricing, downtime, or any direct, indirect,
incidental, special, consequential, or punitive damage — arising from or related
to your use of, or inability to use, PayQR. This is not a limitation a company
is offering you; it is a statement of reality. There is no entity holding your
funds and no entity that can make you whole. Your only practical remedy is to
stop using the software.

---

## 11. Indemnity

To the extent the law allows, you agree to hold harmless the authors,
contributors, and hosts of PayQR from any claim, loss, or expense arising out of
your use of the app, your merchant activity, your violation of these Terms, or
your violation of any law or the rights of others.

---

## 12. No legal, financial, or tax advice

Nothing in the app or its documentation is legal, financial, accounting, or tax
advice. Decisions about accepting crypto-settled payments, handling stablecoins,
and meeting your obligations as a merchant are yours to make, ideally with your
own qualified advisers.

---

## 13. Entire understanding

These Terms, together with the Privacy Policy and the Merchant Terms and
Conditions published alongside them, are the entire understanding between you
and the software regarding its use. Because there is no legal entity on the other
side, these are best understood as the rules of the road for interacting with a
piece of public software — not a negotiated contract with a counterparty who can
be sued into performing.

---

## 14. Final acknowledgement

By using PayQR you acknowledge that you have read this document, that you
understand PayQR is a non-custodial dapp with no company behind it, that no one
can recover your funds or reverse your transactions, and that everything you do
with it is at your own risk and on your own responsibility. If you are not
comfortable with that, do not use the app.
