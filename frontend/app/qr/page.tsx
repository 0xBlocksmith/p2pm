"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useReadContract } from "wagmi";
import { Nav } from "../../components/Nav";
import { useMerchant } from "../../components/useMerchant";
import { Icon } from "../../components/Icons";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, perTxCapUsdc, currencyFromBytes32, USDC_UNIT } from "../../lib/contract";
import { fetchOnchainPrice, quoteFromFiat, PriceNotConfiguredError, type OnchainPrice, type Quote } from "../../lib/price";
import { STATIC_STALE_MS, loadMerchantProfile, saveMerchantProfile } from "../../lib/cache";
import { loadCountry, fmtFiat, COUNTRIES, getCountry } from "../../lib/countries";
import { loadPendingOrder, savePendingOrder, clearPendingOrder, isPaymentPartnerAvailable } from "../../lib/p2p";
import { fetchOrder, receiptToken } from "../../lib/history";
import type { PendingOrder } from "../../lib/p2p";
import { useT } from "../../lib/i18n";
import dynamic from "next/dynamic";

const INTEGRATOR = CONTRACT_ADDRESS;
const SCAN = "https://sepolia.basescan.org";

const CheckoutWidget = dynamic(
  () => import("../../components/CheckoutWidget").then((m) => m.CheckoutWidget),
  { ssr: false }
);

// Quick-amount presets per country (local fiat).
const QUICK = { INR: [10, 20, 50], BRL: [5, 10, 20], ARS: [500, 1000, 2000] };
// Quick-amount presets when charging directly in USDC.
const QUICK_USDC = [1, 5, 10];

// Format the RAW typed amount for display: group the integer part with a comma
// and keep the decimal part EXACTLY as typed (so "10.", "10.1", "10.10" all
// render faithfully while the merchant is entering them). Passing the string
// through a number formatter would round/strip the in-progress decimal, and a
// locale formatter would turn "1000" into "1.000" for pt-BR / es-AR (which use
// "." as their thousands separator) — ambiguous against the keypad's decimal ".".
function fmtTyped(raw: string, _country?: any): string {
  if (!raw) return "0";
  const [intPart, decPart] = raw.split(".");
  const grouped = (intPart || "0").replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return decPart !== undefined ? `${grouped}.${decPart}` : grouped;
}

// A short success chime + vibration — like every POS app.
function paymentFeedback() {
  try {
    if (navigator.vibrate) navigator.vibrate([40, 30, 60]);
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const notes = [880, 1175]; // a pleasant two-note "ding"
    notes.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.14;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      o.start(t); o.stop(t + 0.2);
    });
  } catch {}
}

export default function PosQr() {
  const router = useRouter();
  const { ready, address } = useMerchant();
  const { t } = useT();

  const [country, setCountry] = useState(null);   // the currency THIS sale charges in
  const [payOpts, setPayOpts] = useState([]);     // countries the protocol can settle
  const [pickOpen, setPickOpen] = useState(false);
  const [amt, setAmt] = useState("");        // local fiat the merchant types
  const [lastAmt, setLastAmt] = useState(""); // for "repeat"
  const [inputMode, setInputMode] = useState<"fiat" | "usdc">("fiat"); // what `amt` is denominated in
  // ON-CHAIN price = the SINGLE source of truth. `price` holds the Diamond's live
  // getPriceConfig().buyPrice (+ small-order fee) — the EXACT rate the checkout
  // widget settles against, so the Accept figure and the Order Summary agree.
  const [price, setPrice] = useState<OnchainPrice | null>(null);
  const [priceErr, setPriceErr] = useState("");
  const [error, setError] = useState("");
  const [liveWidget, setLiveWidget] = useState(null);
  const [done, setDone] = useState(null);
  const [payError, setPayError] = useState("");
  const [busy, setBusy] = useState(false); // pricing the sale
  const [imgBusy, setImgBusy] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);
  // Pre-flight: when the merchant taps Accept we first confirm an LP is
  // assignable for this currency+amount (the exact on-chain check the widget's
  // router runs) BEFORE opening checkout — so placement never fails with "no
  // payment partner". `connecting` holds the pending order while we poll; the
  // widget only mounts once a partner is found.
  const [connecting, setConnecting] = useState<any>(null);
  // A payment session that was started but not finished (widget closed / left)
  // BEFORE the order landed on-chain. Persisted so the merchant can RESUME it
  // instead of losing the sale, and can CANCEL a stuck one. Cleared on
  // complete/cancel.
  const [pendingSession, setPendingSession] = useState(null);
  const SESSION_KEY = "payqr.pendingSession";
  const SESSION_TTL_MS = 15 * 60 * 1000; // 15 min — a stale session auto-expires
  const [pending, setPending] = useState<PendingOrder | null>(null); // order placed on-chain but never finished

  // Default the sale currency to the merchant's registered country.
  useEffect(() => { setCountry(loadCountry()); }, []);

  // On load, restore a recent unfinished session (drop it if older than the TTL).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (!s?.startedAt || Date.now() - s.startedAt > SESSION_TTL_MS) {
        localStorage.removeItem(SESSION_KEY);
        return;
      }
      setPendingSession(s);
    } catch { localStorage.removeItem(SESSION_KEY); }
  }, []);

  function saveSession(s) {
    const rec = { ...s, startedAt: Date.now() };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(rec)); } catch {}
    setPendingSession(rec);
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch {}
    setPendingSession(null);
  }
  function resumeSession() {
    if (!pendingSession) return;
    setPayError(""); setDone(null);
    // Restore the SAME currency the session was originally sized in — `country`
    // may have since reverted to the merchant's registered/home currency (e.g.
    // on a remount), and mounting the widget against the wrong currency prices
    // this session's usdcAmount using a different currency's on-chain rate.
    const sessionCountry =
      (pendingSession.countryId != null ? getCountry(pendingSession.countryId) : null) ||
      COUNTRIES.find((c) => c.code === pendingSession.currency) ||
      country;
    setCountry(sessionCountry);
    setLiveWidget({
      usdcAmount: BigInt(pendingSession.usdcAmount),
      quantity: BigInt(pendingSession.quantity),
      fiat: pendingSession.fiat, usdc: pendingSession.usdc, country: sessionCountry,
    });
  }

  // On mount, check for a payment that was placed on-chain but never finished
  // (e.g. merchant closed the QR dialog mid-payment) so it can be resumed
  // instead of silently lost.
  useEffect(() => { setPending(loadPendingOrder()); }, []);

  // Every configured country is selectable as the accept currency. The widget
  // resolves the circle for the picked currency at order time; if the protocol
  // adds a circle, nothing here changes.
  useEffect(() => { setPayOpts(COUNTRIES); }, []);

  // Accepting a payment requires registration. If the merchant reached here
  // without registering, send them to set up their shop first.
  const { data: isRegistered } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "registered",
    args: [address], query: { enabled: !!address, staleTime: STATIC_STALE_MS },
  });
  useEffect(() => {
    if (isRegistered === false) router.replace("/onboarding");
  }, [isRegistered, router]);

  // Shop profile (name / registered currency) is static for the session — cache it.
  const { data: info } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantInfo",
    args: [address], query: { enabled: !!address, staleTime: STATIC_STALE_MS },
  });
  // Persist the (non-financial) profile so the shop name paints INSTANTLY on the
  // next visit while the fresh on-chain read confirms in the background.
  const [cachedProfile, setCachedProfile] = useState(() => loadMerchantProfile(address));
  useEffect(() => { setCachedProfile(loadMerchantProfile(address)); }, [address]);
  useEffect(() => { if (address && info) saveMerchantProfile(address, info); }, [address, info]);
  const shopLabel = info?.[1] || cachedProfile?.shopName || "";

  const { data: daily, refetch: refetchDaily } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getDailyTxInfo",
    args: [address], query: { enabled: !!address, refetchInterval: 20000 },
  });
  const [used, limit] = daily ?? [0n, 25n];
  const limitReached = daily ? used >= limit : false;

  // LIVE per-tx cap: read perTxCap(registeredCurrency) straight from the contract
  // (info[2] is the registered currency as bytes32) so the cap ALWAYS matches
  // on-chain — including any admin setPerTxCap override — with no redeploy. Falls
  // back to the hardcoded 50/100 mirror only until this read resolves.
  const registeredCurrencyB32 = (info?.[2] as `0x${string}`) || undefined;
  const { data: liveCapRaw } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "perTxCap",
    args: [registeredCurrencyB32 as `0x${string}`],
    query: { enabled: !!registeredCurrencyB32 },
  });

  // LIVE on-chain buy price for the sale currency — the value the widget's Order
  // Summary uses. Refetched on currency change and every 60s so the terminal
  // stays in step with any admin re-price. On failure we surface priceErr and
  // show a retry state; order creation is blocked until a real on-chain price
  // loads (see generate()) — we never place an order off a guessed rate.
  useEffect(() => {
    if (!country?.code) { setPrice(null); return; }
    let alive = true;
    setPrice(null); // clear stale price while the new currency's loads
    const load = () =>
      fetchOnchainPrice(country.code)
        .then((p) => { if (alive) { setPrice(p); setPriceErr(""); } })
        .catch((e) => {
          if (!alive) return;
          setPrice(null);
          // Distinguish "protocol hasn't priced this currency yet" (permanent,
          // no point retrying) from a transient read failure (keep retrying).
          setPriceErr(
            e instanceof PriceNotConfiguredError
              ? `${country.name || country.code} isn't available for payments yet.`
              : "Couldn't load the live price. Retrying…"
          );
        });
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [country?.code, country?.name]);

  const amtNum = Number(amt) || 0;
  // The on-chain buyPrice as fiat-per-USDC, for the current currency, when usable.
  const estRate = price ? price.rate : null;

  // Build the on-chain quote. In FIAT mode we invert the widget's formula through
  // the Diamond's buyPrice (quoteFromFiat sizes the order so the CUSTOMER pays the
  // entered amount and the fee comes OUT of it). In USDC mode the typed number IS
  // the order's USDC amount — the customer pays its fiat equivalent.
  let quote: Quote | null = null;
  if (price && amtNum > 0) {
    if (inputMode === "usdc") {
      const usdcAmount = BigInt(Math.round(amtNum * 1e6));
      const quantity = (usdcAmount + USDC_UNIT / 2n) / USDC_UNIT;
      const snapped = quantity * USDC_UNIT;
      const feeUsdc =
        price.smallOrderThreshold > 0n && snapped > 0n && snapped <= price.smallOrderThreshold
          ? price.smallOrderFixedFee : 0n;
      const creditedUsdc = snapped > feeUsdc ? snapped - feeUsdc : 0n;
      const subtotalFiat = (snapped * price.buyPrice) / 1_000_000n;
      const feeFiat = (feeUsdc * price.buyPrice) / 1_000_000n;
      quote = {
        usdcAmount: snapped, quantity, feeUsdc, creditedUsdc,
        subtotalFiat, totalFiat: subtotalFiat + feeFiat,
        usdc: Number(snapped) / 1e6, credited: Number(creditedUsdc) / 1e6,
        fee: Number(feeUsdc) / 1e6, total: Number(subtotalFiat + feeFiat) / 1e6,
      };
    } else {
      quote = quoteFromFiat(amtNum, price);
    }
  }

  // Per-tx cap keys off the merchant's REGISTERED currency (what the contract
  // enforces in validateOrder), NOT the currency picked in the terminal — else
  // an INR merchant (50 cap) charging in BRL would be shown a 100 cap and the
  // on-chain placeOrder would revert ExceedsPerTxCap.
  // Prefer the LIVE on-chain cap (reflects admin setPerTxCap overrides); fall
  // back to the hardcoded 50/100 mirror only while the read is loading.
  const registeredCode = currencyFromBytes32(info?.[2] as string);
  const capUsdc =
    liveCapRaw != null
      ? Number(liveCapRaw) / 1e6
      : perTxCapUsdc(registeredCode || country?.code || "INR");
  // The on-chain per-tx cap is enforced against the ORDER amount (usdcAmount),
  // not the fee-adjusted credit — mirror that so the warning matches the revert.
  const overCap = quote ? quote.usdc > capUsdc : false;

  function press(k) {
    setError("");
    setAmt((cur) => {
      if (k === "del") return cur.slice(0, -1);
      if (k === ".") return cur.includes(".") ? cur : (cur || "0") + ".";
      // Digit: max 2 decimal places once a "." is present.
      if (cur.includes(".")) {
        const decimals = cur.split(".")[1] ?? "";
        if (decimals.length >= 2) return cur;
      }
      const next = (cur + k).replace(/^0+(?=\d)/, "");
      // Cap total length so the display stays sane (10 chars incl. the dot).
      return next.length > 10 ? cur : next;
    });
  }

  function generate() {
    setError("");
    // Order creation REQUIRES the live on-chain price — never place an order off
    // an indicative rate, or the customer's Order Summary would disagree with
    // what the merchant just accepted.
    if (!price || !quote) {
      return setError(priceErr || "Live price is still loading — one moment.");
    }
    if (amtNum <= 0) return setError(inputMode === "usdc" ? "Enter the amount in USDC." : `Enter the amount in ${country.code}.`);
    if (overCap) {
      return setError(
        `Max ${capUsdc} USDC per sale (≈ ${fmtFiat(country, capUsdc * price.rate)} now).`
      );
    }

    // Snapshot the charge currency NOW so everything downstream agrees on THIS
    // currency even if `country` changes before they run.
    const chargeCountry = country;
    const { usdcAmount, quantity } = quote;
    if (quantity === 0n) return setError("Amount too small.");
    setLastAmt(amt);

    // The customer's fiat is the entered amount (fiat mode) or the quote's
    // fiat-equivalent total (USDC mode). `usdc` = what the merchant KEEPS
    // (credited, i.e. after the fee) so the receipt/resume shows the right figure.
    const fiatCharged = inputMode === "usdc" ? quote.total : amtNum;
    const keptUsdc = quote.credited;

    // Enter the PRE-FLIGHT phase instead of opening checkout directly: the effect
    // below confirms an LP is assignable (the same on-chain check the widget's
    // router runs) and only THEN mounts the widget — so placement can't fail with
    // "no payment partner". We carry the fiat's 6-dec value for the partner check.
    setPayError("");
    setConnecting({
      usdcAmount, quantity, fiat: fiatCharged, usdc: keptUsdc,
      fiat6: BigInt(Math.round(fiatCharged * 1e6)), code: chargeCountry.code,
      country: chargeCountry,
    });
  }

  // Pre-flight poller: while `connecting`, repeatedly ask the chain whether a
  // payment partner (LP) is assignable for this currency+amount+buyer. The moment
  // one is, we promote to the live widget (and persist a resumable session). If
  // none appears, we stay in the calm "connecting" state — no error screen, no
  // blind retries, and the merchant can cancel.
  useEffect(() => {
    if (!connecting || !address) return;
    let alive = true;
    const open = () => {
      setLiveWidget({
        usdcAmount: connecting.usdcAmount, quantity: connecting.quantity,
        fiat: connecting.fiat, usdc: connecting.usdc, country: connecting.country,
      });
      saveSession({
        usdcAmount: connecting.usdcAmount.toString(),
        quantity: connecting.quantity.toString(),
        fiat: connecting.fiat, usdc: connecting.usdc,
        currency: connecting.code, countryId: connecting.country?.id,
      });
      setConnecting(null);
    };
    const check = async () => {
      const ok = await isPaymentPartnerAvailable(
        connecting.code, address, connecting.usdcAmount, connecting.fiat6,
      );
      if (!alive) return;
      if (ok) { open(); return; }
      // Not yet — poll again shortly. Kept snappy (1.5s) since the gap is brief.
      timer = setTimeout(check, 1500);
    };
    let timer: any = setTimeout(check, 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [connecting, address]);

  // Reopen the checkout modal against a previously-placed order (the merchant
  // closed the dialog before it finished) instead of starting a fresh sale.
  function resumePending() {
    if (!pending) return;
    setError("");
    // Same rationale as resumeSession(): restore the currency this order was
    // actually placed in, not whatever `country` currently is.
    const pendingCountry = getCountry(pending.countryId) || country;
    setCountry(pendingCountry);
    setLiveWidget({
      resumeOrderId: pending.orderId,
      usdcAmount: BigInt(Math.round(pending.usdc * 1e6)),
      quantity: 0n, fiat: pending.fiat, usdc: pending.usdc, country: pendingCountry,
    });
  }

  function discardPending() {
    clearPendingOrder();
    setPending(null);
  }

  // Public, no-auth-but-tokened receipt link the CUSTOMER opens to verify
  // their payment. Only holders of this exact link (with its token) can view
  // the receipt — see receiptToken() in lib/history.ts.
  function receiptUrl() {
    if (typeof window === "undefined" || !done || !done.token) return "";
    const q = new URLSearchParams({
      shop: shopLabel || "My Shop",
      fiat: fmtFiat(done.country || country, done.fiat),
      token: done.token,
    });
    return `${window.location.origin}/receipt/${done.orderId}?${q.toString()}`;
  }

  // Render the confirmation card to a PNG and hand it to the OS share sheet
  // (or download it, if sharing files isn't supported) — so the merchant can
  // forward proof of payment as an image instead of just a link.
  async function shareReceipt() {
    if (!captureRef.current || imgBusy || !done) return;
    setImgBusy(true);
    try {
      const { default: html2canvas } = await import("html2canvas");
      const canvas = await html2canvas(captureRef.current, {
        backgroundColor: getComputedStyle(captureRef.current).backgroundColor || "#ffffff",
        scale: Math.min(window.devicePixelRatio || 2, 3),
      });
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) return;
      const file = new File([blob], `payqr-receipt-${done.orderId}.png`, { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "PayQR receipt" });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = file.name;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      }
    } catch {
      // Best-effort — leave the merchant with the on-screen confirmation if it fails.
    } finally {
      setImgBusy(false);
    }
  }

  if (!country) return <><Nav back /><div className="screen"><p className="muted" style={{ textAlign: "center" }}>Loading…</p></div></>;

  const quick = QUICK[country.code] || QUICK.INR;

  return (
    <>
      <Nav back />
      <div className="screen">

        {liveWidget && (
          <>
            <CheckoutWidget
              orderId={liveWidget.resumeOrderId}
              usdcAmount={liveWidget.usdcAmount}
              quantity={liveWidget.quantity}
              productName={shopLabel || "PayQR sale"}
              currencies={[{
                symbol: liveWidget.country.code, flag: liveWidget.country.flag,
                paymentMethod: liveWidget.country.fiat, symbolNative: liveWidget.country.symbol,
              }]}
              onPlaced={(orderId) => {
                savePendingOrder({
                  orderId: String(orderId), fiat: liveWidget.fiat, usdc: liveWidget.usdc,
                  countryId: liveWidget.country.id, shopLabel, savedAt: Date.now(),
                });
              }}
              onComplete={(orderId) => {
                paymentFeedback();
                clearPendingOrder(); setPending(null);
                const id = String(orderId);
                setDone({ orderId: id, usdc: liveWidget.usdc, fiat: liveWidget.fiat, token: "", country: liveWidget.country });
                setLiveWidget(null); setAmt(""); clearSession(); refetchDaily();
                // The receipt link's access token needs this order's real tx hash.
                // The subgraph indexes it moments after settlement, so poll briefly
                // rather than leaving the share link without a token.
                (async () => {
                  for (let i = 0; i < 8; i++) {
                    const o: any = await fetchOrder(id);
                    if (o?.txHash) {
                      setDone((d: any) => (d && d.orderId === id ? { ...d, token: receiptToken(id, o.txHash) } : d));
                      return;
                    }
                    await new Promise((r) => setTimeout(r, 1500));
                  }
                })();
              }}
              onCancel={() => {
                clearPendingOrder(); setPending(null);
                setLiveWidget(null); clearSession(); refetchDaily();
              }}
              // Closing the dialog does NOT discard the session — it stays so the
              // merchant can resume it from the "pending payment" banner below.
              onClose={() => setLiveWidget(null)}
              onError={(m) => {
                // Safety net: if the LP dropped in the split second between our
                // pre-flight OK and the tx landing, the widget reports a routing/
                // "no partner" error. Instead of a dead-end screen, fall back into
                // the connecting-wait so we re-poll and reopen once it's back.
                const routing = /no payment partner|no circleId|no eligible|ROUTING_NO_MERCHANTS|placeOrder\.prepare/i.test(m || "");
                if (routing) {
                  setLiveWidget(null);
                  setConnecting({
                    usdcAmount: liveWidget.usdcAmount, quantity: liveWidget.quantity,
                    fiat: liveWidget.fiat, usdc: liveWidget.usdc,
                    fiat6: BigInt(Math.round(liveWidget.fiat * 1e6)),
                    code: liveWidget.country.code, country: liveWidget.country,
                  });
                  return;
                }
                clearPendingOrder(); setPending(null);
                setPayError(m); setLiveWidget(null);
              }}
            />
          </>
        )}

        {/* Pre-flight: confirming a payment partner (LP) is online before we open
            checkout. On testnet the single LP flickers; rather than open the
            widget and let placement fail, we hold here and poll until a partner
            is assignable, then the effect promotes us to the live widget. The
            merchant can cancel to go back to the keypad. */}
        {connecting && !liveWidget && !done && (
          <div className="panel" style={{ textAlign: "center" }}>
            <h2>Connecting to a payment partner…</h2>
            <p className="muted" style={{ margin: "8px 0 4px" }}>
              Getting {fmtFiat(connecting.country || country, connecting.fiat)} ready — this usually takes a moment.
              Keep this screen open; the QR appears automatically.
            </p>
            <div className="spinner" style={{ margin: "14px auto" }} aria-hidden="true" />
            <button className="btn ghost" style={{ width: "100%" }}
              onClick={() => setConnecting(null)}>
              Cancel
            </button>
          </div>
        )}

        {/* Resume / cancel an unfinished payment that hasn't reached the chain
            yet (dialog was closed or app left before the order was placed).
            Fixes the orphaned-session bug + gives a way out of a stuck order. */}
        {pendingSession && !pending && !liveWidget && !done && !connecting && (
          <div className="panel" style={{ textAlign: "center" }}>
            <h2>Payment in progress</h2>
            <p className="muted" style={{ margin: "6px 0 12px" }}>
              {/* Format with the currency the session was STARTED in, not the
                  current `country` (which may have reverted to the merchant's
                  home currency on a remount) — else a BRL session shows the ₹
                  symbol / INR grouping. Mirrors resumeSession()'s resolution. */}
              You have an unfinished sale of{" "}
              {fmtFiat(
                (pendingSession.countryId != null ? getCountry(pendingSession.countryId) : null) ||
                  COUNTRIES.find((c) => c.code === pendingSession.currency) ||
                  country,
                pendingSession.fiat
              )}{" "}
              {pendingSession.currency}.
              Resume to show the QR again, or cancel to start over.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" style={{ flex: 1 }} onClick={resumeSession}>Resume payment</button>
              <button className="btn ghost" style={{ flex: 1 }} onClick={clearSession}>Cancel</button>
            </div>
          </div>
        )}

        {/* A payment was placed on-chain but the dialog closed before it
            finished — offer to pick it back up instead of losing it. */}
        {pending && !liveWidget && !done && !payError && !connecting && (
          <div className="panel" style={{ textAlign: "center" }}>
            <h2>Unfinished payment</h2>
            <p className="muted" style={{ margin: "8px 0 4px" }}>
              A sale for {fmtFiat(getCountry(pending.countryId), pending.fiat)} is still
              in progress (order #{pending.orderId}).
            </p>
            <div className="recv-actions" style={{ marginTop: 14 }}>
              <button className="btn ghost" onClick={discardPending}>Discard</button>
              <button className="btn" onClick={resumePending}>Resume</button>
            </div>
          </div>
        )}

        {/* Friendly message when the QR can't be created (no LP available) */}
        {payError && !liveWidget && !done && (
          <div className="panel" style={{ textAlign: "center" }}>
            <h2>Couldn’t start this payment</h2>
            <p className="muted" style={{ margin: "8px 0 4px" }}>
              No payment partner is available right now to process this sale. This
              is usually temporary — please try again in a moment.
            </p>
            <p className="tiny" style={{ color: "var(--muted)", marginBottom: 14 }}>{payError}</p>
            <button className="btn" style={{ width: "100%" }}
              onClick={() => { setPayError(""); }}>
              Try again
            </button>
          </div>
        )}

        {/* You received USDC — confirmation */}
        {done && (
          <div className="received">
            <div ref={captureRef}>
              <div className="tick-wrap"><Icon.Check /></div>
              <div className="recv-h">{t("qr.received")}<br />${done.usdc.toFixed(2)} USDC</div>
              <p className="muted recv-sub">
                Settled on-chain · paid by customer ({fmtFiat(done.country || country, done.fiat)}).
                Withdraw to your bank or keep as USDC.
              </p>
              <div className="proofcard">
                <div className="prow"><span className="k">Order</span><span className="v">#{done.orderId}</span></div>
                <div className="prow"><span className="k">Received</span><span className="v">{done.usdc.toFixed(2)} USDC</span></div>
                <div className="prow">
                  <span className="k">Proof</span>
                  <a className="v link" target="_blank" rel="noopener noreferrer"
                     href={`${SCAN}/address/${INTEGRATOR}`}>Basescan ↗</a>
                </div>
              </div>
            </div>
            {done.token ? (
              <a className="recv-receipt-link" href={receiptUrl()} target="_blank" rel="noopener noreferrer">
                <Icon.Receipt width="15" height="15" /> {t("qr.showReceipt")}
              </a>
            ) : (
              <p className="muted tiny" style={{ margin: "6px 0" }}>Preparing receipt link…</p>
            )}
            <div className="recv-actions">
              <button className="btn ghost" onClick={shareReceipt} disabled={imgBusy}>
                <Icon.Share /> {imgBusy ? "Preparing image…" : t("qr.sendReceipt")}
              </button>
              <button className="btn" onClick={() => setDone(null)}><Icon.Plus /> {t("qr.next")}</button>
            </div>
          </div>
        )}

        {limitReached && !liveWidget && !done && !payError && !pendingSession && !pending && !connecting && (
          <div className="panel">
            <h2>Daily limit reached ({String(used)}/{String(limit)})</h2>
            <p className="muted">All transactions used for today. Resets at midnight UTC.</p>
          </div>
        )}

        {/* Number-pad terminal */}
        {!limitReached && !liveWidget && !done && !payError && !pendingSession && !pending && !connecting && (
          <div className="terminal">
            {/* charge-currency picker + fiat/USDC input-mode toggle */}
            <div className="cur-pick-row">
              {/* charge-currency picker — lets a merchant accept in any supported
                  currency, e.g. when travelling. Default = registered country.
                  Locked while a sale is being priced (`busy`). */}
              {payOpts.length > 1 && (
                <div className="cur-pick">
                  <button className={`cur-pick-btn ${pickOpen ? "on" : ""}`} disabled={busy}
                    onClick={() => setPickOpen((o) => !o)}>
                    <span className="cur-pick-label">{t("qr.chargeIn")}</span>
                    <img className="cur-flag" src={`https://flagcdn.com/w40/${({india:"in",brazil:"br",argentina:"ar"})[country.id] || "un"}.png`} alt="" />
                    <b>{country.code}</b><span className="cur-car">▾</span>
                  </button>
                  {pickOpen && (
                    <div className="cur-pick-pop">
                      {payOpts.map((c) => (
                        <button key={c.id} className={`cur-pick-item ${c.id === country.id ? "sel" : ""}`}
                          onClick={() => { setCountry(c); setAmt(""); setError(""); setPickOpen(false); }}>
                          <img className="cur-flag" src={`https://flagcdn.com/w40/${({india:"in",brazil:"br",argentina:"ar"})[c.id] || "un"}.png`} alt="" />
                          <span className="cur-pick-txt">{c.name}<small>{c.fiat} · {c.symbol} {c.code}</small></span>
                          {c.id === country.id && <span className="cur-chk">✓</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {/* fiat / USDC input-mode toggle — switches what the keypad + quick
                  chips are denominated in. */}
              <div className="mode-toggle">
                <button className={`mode-toggle-opt ${inputMode === "fiat" ? "sel" : ""}`} disabled={busy}
                  onClick={() => { setInputMode("fiat"); setAmt(""); setError(""); }}>
                  {country.code}
                </button>
                <button className={`mode-toggle-opt ${inputMode === "usdc" ? "sel" : ""}`} disabled={busy}
                  onClick={() => { setInputMode("usdc"); setAmt(""); setError(""); }}>
                  USDC
                </button>
              </div>
            </div>
            <div className="t-amount">
              <div className="t-shop">{shopLabel || t("qr.newSale")}</div>
              {/* Show the RAW typed string (preserves "10." and decimals while
                  typing) with grouping on the integer part only — passing `amt`
                  through fmtFiat would round away the decimal being entered. */}
              <div className="t-value">
                {inputMode === "usdc" ? `${fmtTyped(amt, country)} USDC` : `${country.symbol}${fmtTyped(amt, country)}`}
              </div>
              <div className="t-sub">
                {amtNum <= 0
                  ? t("qr.enterAmount")
                  : quote
                    ? inputMode === "usdc"
                      ? `≈ ${fmtFiat(country, quote.total)} ${country.code}`
                      : `≈ ${quote.credited.toFixed(2)} USDC ${t("qr.youKeep")}`
                    : priceErr
                      ? priceErr
                      : t("qr.fetchingRate")}
              </div>
              {/* The fee is taken OUT of the entered amount: the customer pays the
                  amount the merchant typed, and the fee is deducted from the
                  merchant's proceeds. Spell that out so there are no surprises. */}
              {quote && quote.fee > 0 && (
                <div className="t-sub" style={{ opacity: 0.8, fontSize: "0.85em" }}>
                  {inputMode === "usdc"
                    ? `Fee ${quote.fee.toFixed(2)} USDC deducted · you keep ${quote.credited.toFixed(2)} USDC`
                    : `Customer pays ${fmtFiat(country, quote.total)} · ${fmtFiat(country, quote.fee * price!.rate)} fee comes out of it`}
                </div>
              )}
              {overCap && price && (
                <div className="t-warn">Max {fmtFiat(country, capUsdc * price.rate)} per sale</div>
              )}
            </div>

            {/* quick amounts + repeat */}
            <div className="quick-amts">
              {(inputMode === "usdc" ? QUICK_USDC : quick).map((q) => (
                <button key={q} className="qa-chip" onClick={() => { setAmt(String(q)); setError(""); }}>
                  {inputMode === "usdc" ? `${q} USDC` : `${country.symbol}${q}`}
                </button>
              ))}
              <button className="qa-chip repeat" disabled={!lastAmt}
                onClick={() => { setAmt(lastAmt); setError(""); }} title="Repeat last amount">
                <Icon.Repeat width="16" height="16" />
              </button>
            </div>

            <div className="keypad">
              {["1","2","3","4","5","6","7","8","9",".","0","del"].map((k) => (
                <button key={k} className="keypad-key" onClick={() => press(k)}>
                  {k === "del" ? "⌫" : k}
                </button>
              ))}
            </div>

            <button className="btn t-charge"
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
              disabled={!ready || !quote || amtNum <= 0 || overCap || busy} onClick={generate}>
              <Icon.Qr /> {busy ? t("qr.fetchingRate") : amtNum > 0 ? `${t("common.acceptPayment")} · ${inputMode === "usdc" ? `${fmtTyped(amt, country)} USDC` : `${country.symbol}${fmtTyped(amt, country)}`}` : t("common.acceptPayment")}
            </button>
            {error && <p className="error" style={{ textAlign: "center" }}>{error}</p>}
            <div className="t-foot">{String(used)} / {String(limit)} sales today</div>
          </div>
        )}
      </div>
    </>
  );
}
