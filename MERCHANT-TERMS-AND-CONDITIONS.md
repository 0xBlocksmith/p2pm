# Merchant Terms and Conditions

**Application:** PayQR — a non-custodial merchant payment terminal
**Version:** 1.0.0
**Last updated:** 9 July 2026
**Network status:** Testnet build (Base Sepolia). No real money moves.

---

## 0. Who this is for and what it is

This document is for you, the **merchant** — the person or business using PayQR
to accept payments and receive settlements. It sits alongside the Privacy Policy
and the general Terms of Service and does not replace them; where the general
Terms describe the software, this document describes the specific deal you are
entering into as someone accepting money through it.

And, as everywhere else, the foundational fact: **PayQR is not a company, a
bank, an acquirer, a payment facilitator, or any legal entity.** It is
open-source, non-custodial software. Nobody is underwriting you, sponsoring your
merchant account, or standing behind your sales. You are a merchant using a tool
that connects you directly to a public blockchain and to independent peer-to-peer
liquidity providers. There is no PayQR "merchant services" team. This is the
whole point of the model, and everything that follows is a consequence of it.

---

## 1. Becoming a merchant

There is no application, approval, or underwriting process, because there is no
one to approve you. You become a merchant simply by registering on-chain: you
connect a wallet, choose your country/currency and language, and submit a shop
name and a payout identifier (such as a UPI ID, PIX key, or CBU/alias) in a
transaction that is written to the public blockchain. That registration:

- Is **public and permanent.** Your shop name, payout identifier, and settlement
  currency are visible to anyone and cannot be deleted or hidden.
- **Locks your settlement currency** at the moment of registration. Choose
  carefully — for example, a merchant registered in one currency is paid out in
  that currency.
- Is **entirely your responsibility to get right.** If your payout identifier is
  wrong, settlements may be directed to a destination you do not control and
  cannot recover. No one verifies it for you and no one can fix it after the
  fact.

By registering, you represent that you are legally able to operate a business
and accept payments where you live, and that the information you submit is
accurate and yours to submit.

---

## 2. How a sale works, and who does what

Understanding the flow matters, because it tells you exactly who is responsible
at each step:

1. **You** generate a payment request (a QR code) for an amount in your
   currency.
2. **Your customer** pays. PayQR does not touch a card, a bank login, or a
   customer's money — the customer's side is handled through the protocol.
3. **Independent liquidity providers**, through the underlying peer-to-peer
   protocol, provide the value and settle the fiat leg toward your payout
   identifier.
4. **The blockchain** records the order, the settlement, and your balance.
5. **You** later withdraw — either USDC to your own wallet, or fiat via the
   protocol's cash-out widget.

At no point in this chain does PayQR hold your money or act as an intermediary
who owes you settlement. PayQR shows you the state of the world and helps you
build transactions. The value comes from liquidity providers and the protocol;
the finality comes from the blockchain; the decisions come from you.

---

## 3. Settlement, pricing, and timing

You accept the following about how you get paid:

- **Pricing comes from the chain, not from PayQR.** The amount your customer is
  charged and the rate your balance is valued at are derived from on-chain price
  configuration read by the payment widget. PayQR does not set these rates and
  cannot override them. If an on-chain price is wrong or missing for a currency,
  the app can only display what the chain says — it cannot invent a correct
  price. On the current test network, some currencies carry placeholder prices
  that do not reflect real market rates; do not rely on them.
- **Settlement is not guaranteed or instantaneous.** Settlement depends on
  liquidity providers being available and the protocol functioning. An order can
  be delayed, stuck, or fail for reasons entirely outside PayQR's control, and
  no one is obligated to complete it for you.
- **There is a settlement lock.** Value may be time-locked by the underlying
  contract before it is withdrawable. On the test network this lock is a short
  test value, not the production duration.
- **Finality is final.** Once a settlement or withdrawal is on-chain, it cannot
  be reversed, disputed, or clawed back by anyone, including you.

---

## 4. Withdrawals and cash-out

You can move settled value in two ways, and both are yours to execute:

- **USDC to your own wallet**, via a withdrawal transaction you sign.
- **Fiat cash-out**, via the protocol's cash-out widget, which handles its own
  encryption and delivery of payout instructions to liquidity providers.

PayQR does not custody the funds in either path and cannot release, expedite, or
recover a withdrawal on your behalf. If a withdrawal fails, is delayed, or is
sent to the wrong destination because of details you provided, the consequences
are yours.

---

## 5. No chargebacks, no refunds, no reversals — from anyone

This is worth stating on its own because it is the biggest practical difference
from a traditional payment processor. On-chain payments are final. There is:

- **No chargeback mechanism.** A customer cannot force-reverse a settled payment
  through PayQR, and neither can you.
- **No refund button.** If you want to refund a customer, you must send them
  value yourself, as a new transaction, on your own initiative.
- **No dispute resolution service.** There is no arbiter, no ticket queue, and
  no operator who can rule on a disagreement between you and a customer or a
  liquidity provider.

This cuts both ways: you are protected from surprise chargebacks, but you also
have no safety net if you make a mistake or if a counterparty behaves badly.
Price and confirm your sales accordingly.

---

## 6. Fees

Fees that apply to a transaction — such as small-order or network-related fees —
are determined by the protocol and its on-chain configuration, and are reflected
in what the customer is charged. Network gas fees for merchant actions may be
sponsored by a third-party provider under that provider's own terms and quotas,
which can change or run out. PayQR does not itself charge you a fee to use the
software, and equally does not collect, hold, or control any protocol fees — so
it cannot waive, refund, or adjust them.

---

## 7. Your obligations as a merchant

You are running a business, and the obligations of running one are yours alone:

- **Legality.** Only accept payment for goods and services that are legal where
  you and your customer are. Do not use PayQR for fraud, money laundering,
  sanctions evasion, or anything prohibited.
- **Your customers.** Deliver what you sold, honor your own refund and return
  promises to your customers (through your own means — see Section 5), and
  handle any disputes with them directly.
- **Tax and compliance.** All tax reporting, record-keeping, licensing, and
  regulatory compliance related to your sales are entirely your responsibility.
  PayQR performs no KYC on you, no reporting for you, and no withholding for you.
- **Accuracy.** Keep your on-chain details correct, and understand that
  correcting them means a new on-chain action, not a support request.
- **Device and account security.** Protect your login, wallet, and device.
  Sales, balances, and withdrawals flow from whoever controls your session.

---

## 8. Administrative freeze — what it is and is not

The underlying protocol or integrator may include an on-chain administrative
"freeze" capability that a protocol/integrator administrator can exercise
against a merchant account. You should be aware this exists and that it is a
property of the smart contracts — not a service PayQR runs for you and not a
protection promised to you. It is not moderation you can appeal to, and its
existence is not a commitment that anyone will intervene, help, or protect you
in any situation. Conversely, if it is ever exercised against your account, that
is a protocol-level action outside PayQR's control.

---

## 9. No guarantee of business continuity

Nothing here guarantees that PayQR, the protocol, the liquidity providers, or
the supporting infrastructure will keep working, keep prices sane, keep
liquidity available, or keep settling your sales. Any of these can change,
degrade, or disappear at any time. You should not build a business that cannot
survive PayQR simply ceasing to function, because no one owes you its continued
operation.

---

## 10. Independence and no partnership

Using PayQR does not make you a partner, agent, employee, franchisee, or
representative of the authors or contributors of the software, and does not make
them any of those things to you. There is no relationship here beyond your use
of open-source code. No one is jointly liable for your business, and you may not
represent otherwise.

---

## 11. Disclaimer and limitation of liability

As with the general Terms of Service, PayQR is provided "as is," with no
warranty of any kind, and to the maximum extent permitted by law no author,
contributor, or host of the software is liable to you for any loss arising from
your use of it as a merchant — including failed, delayed, or mispriced
settlements, lost or misdirected funds, downtime, or any direct or indirect
damages. There is no entity that custodies your funds and none that can make you
whole. Your practical remedy for dissatisfaction is to stop using the software.

---

## 12. Changes

These Merchant Terms and Conditions are versioned with the code. If they change,
the version and date at the top change, and the history is visible in the
repository. Continuing to operate as a merchant on PayQR after a change means
you accept the current version.

---

## 13. Final acknowledgement

By registering and operating as a merchant on PayQR, you acknowledge that PayQR
is non-custodial, open-source software with no company behind it; that your
merchant details are public and permanent on-chain; that settlements are
performed by independent parties and are final and irreversible; that there are
no chargebacks, refunds, or disputes available through the software; and that the
legal, tax, and operational responsibilities of running your business are
entirely yours. If you are not prepared to accept full responsibility for your
own merchant activity, do not register.
