"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useReadContract } from "wagmi";
import { Nav } from "../../components/Nav";
import { useMerchant } from "../../components/useMerchant";
import { Icon } from "../../components/Icons";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, perTxCapUsdc, currencyFromBytes32 } from "../../lib/contract";
import { fetchUsdcRate } from "../../lib/rates";
import { loadCountry, fmtFiat, COUNTRIES, getCountry } from "../../lib/countries";
import { loadPendingOrder, savePendingOrder, clearPendingOrder } from "../../lib/p2p";
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

// Format the RAW typed amount for display: group the integer part with the
// country's locale but keep the decimal part EXACTLY as typed (so "10.", "10.1",
// "10.10" all render faithfully while the merchant is entering them). Passing the
// string through a number formatter would round/strip the in-progress decimal.
function fmtTyped(raw: string, country: any): string {
  if (!raw) return "0";
  const [intPart, decPart] = raw.split(".");
  let grouped = "0";
  try {
    grouped = (Number(intPart) || 0).toLocaleString(country?.locale || undefined);
  } catch { grouped = intPart || "0"; }
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
  const [rate, setRate] = useState(null);
  const [error, setError] = useState("");
  const [liveWidget, setLiveWidget] = useState(null);
  const [done, setDone] = useState(null);
  const [payError, setPayError] = useState("");
  const [imgBusy, setImgBusy] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);
  // A payment session that was started but not finished (widget closed / left)
  // BEFORE the order landed on-chain. Persisted so the merchant can RESUME it
  // instead of losing the sale, and can CANCEL a stuck one. Cleared on
  // complete/cancel. (Bug: closing the p2p dialog used to orphan the session
  // forever.)
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
    setLiveWidget({
      usdcAmount: BigInt(pendingSession.usdcAmount),
      quantity: BigInt(pendingSession.quantity),
      fiat: pendingSession.fiat, usdc: pendingSession.usdc,
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
    args: [address], query: { enabled: !!address },
  });
  useEffect(() => {
    if (isRegistered === false) router.replace("/onboarding");
  }, [isRegistered, router]);

  const { data: info } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantInfo",
    args: [address], query: { enabled: !!address },
  });
  const shopLabel = info?.[1] || "";

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

  useEffect(() => {
    if (!country) return;
    let alive = true;
    const load = () => fetchUsdcRate(country).then((r) => alive && setRate(r));
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [country]);

  const amtNum = Number(amt) || 0;
  const usdcEquiv = rate && amtNum > 0 ? amtNum / rate.rate : 0;
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
  const overCap = usdcEquiv > capUsdc;

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
    if (!rate) return;
    if (amtNum <= 0) return setError(`Enter the amount in ${country.code}.`);
    if (overCap) {
      return setError(
        `Max ${capUsdc} USDC per sale (≈ ${fmtFiat(country, capUsdc * rate.rate)} now).`
      );
    }
    const quantity = BigInt(Math.round(usdcEquiv * 100));
    if (quantity === 0n) return setError("Amount too small.");
    setLastAmt(amt);
    // Derive usdcAmount FROM quantity (× 0.01 USDC = 10_000 6-dec units) so the
    // amount shown to the customer in the widget exactly equals the on-chain
    // order total (quantity × unit price). Rounding them independently could
    // diverge by up to half a cent.
    const usdcAmount = quantity * 10_000n;
    setLiveWidget({ usdcAmount, quantity, fiat: amtNum, usdc: usdcEquiv });
    // Persist so the session survives a closed dialog / refresh and can be resumed.
    saveSession({
      usdcAmount: usdcAmount.toString(), quantity: quantity.toString(),
      fiat: amtNum, usdc: usdcEquiv, currency: country.code,
    });
  }

  // Reopen the checkout modal against a previously-placed order (the merchant
  // closed the dialog before it finished) instead of starting a fresh sale.
  function resumePending() {
    if (!pending) return;
    setError("");
    setLiveWidget({
      resumeOrderId: pending.orderId,
      usdcAmount: BigInt(Math.round(pending.usdc * 1e6)),
      quantity: 0n, fiat: pending.fiat, usdc: pending.usdc,
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
      fiat: fmtFiat(country, done.fiat),
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
                symbol: country.code, flag: country.flag,
                paymentMethod: country.fiat, symbolNative: country.symbol,
              }]}
              onPlaced={(orderId) => {
                savePendingOrder({
                  orderId: String(orderId), fiat: liveWidget.fiat, usdc: liveWidget.usdc,
                  countryId: country.id, shopLabel, savedAt: Date.now(),
                });
              }}
              onComplete={(orderId) => {
                paymentFeedback();
                clearPendingOrder(); setPending(null);
                const id = String(orderId);
                setDone({ orderId: id, usdc: liveWidget.usdc, fiat: liveWidget.fiat, token: "" });
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
              onClose={() => setLiveWidget(null)}
              onError={(m) => {
                clearPendingOrder(); setPending(null);
                setPayError(m); setLiveWidget(null);
              }}
            />
          </>
        )}

        {/* Resume / cancel an unfinished payment that hasn't reached the chain
            yet (dialog was closed or app left before the order was placed).
            Fixes the orphaned-session bug + gives a way out of a stuck order. */}
        {pendingSession && !pending && !liveWidget && !done && (
          <div className="panel" style={{ textAlign: "center" }}>
            <h2>Payment in progress</h2>
            <p className="muted" style={{ margin: "6px 0 12px" }}>
              You have an unfinished sale of {fmtFiat(country, pendingSession.fiat)} {pendingSession.currency}.
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
        {pending && !liveWidget && !done && !payError && (
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
                Settled on-chain · paid by customer ({fmtFiat(country, done.fiat)}).
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

        {limitReached && !liveWidget && !done && !payError && !pendingSession && !pending && (
          <div className="panel">
            <h2>Daily limit reached ({String(used)}/{String(limit)})</h2>
            <p className="muted">All transactions used for today. Resets at midnight UTC.</p>
          </div>
        )}

        {/* Number-pad terminal */}
        {!limitReached && !liveWidget && !done && !payError && !pendingSession && !pending && (
          <div className="terminal">
            {/* charge-currency picker — only shows currencies the protocol can
                settle (live circles). Lets a merchant accept in any supported
                currency, e.g. when travelling. Default = registered country. */}
            {payOpts.length > 1 && (
              <div className="cur-pick">
                <button className={`cur-pick-btn ${pickOpen ? "on" : ""}`}
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
            <div className="t-amount">
              <div className="t-shop">{shopLabel || t("qr.newSale")}</div>
              {/* Show the RAW typed string (preserves "10." and decimals while
                  typing) with grouping on the integer part only — passing `amt`
                  through fmtFiat would round away the decimal being entered. */}
              <div className="t-value">{country.symbol}{fmtTyped(amt, country)}</div>
              <div className="t-sub">
                {rate
                  ? amtNum > 0 ? `≈ ${usdcEquiv.toFixed(2)} USDC ${t("qr.youKeep")}` : t("qr.enterAmount")
                  : t("qr.fetchingRate")}
              </div>
              {overCap && rate && (
                <div className="t-warn">Max {fmtFiat(country, capUsdc * rate.rate)} per sale</div>
              )}
            </div>

            {/* quick amounts + repeat */}
            <div className="quick-amts">
              {quick.map((q) => (
                <button key={q} className="qa-chip" onClick={() => { setAmt(String(q)); setError(""); }}>
                  {country.symbol}{q}
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
              disabled={!ready || !rate || amtNum <= 0 || overCap} onClick={generate}>
              <Icon.Qr /> {amtNum > 0 ? `${t("common.acceptPayment")} · ${country.symbol}${fmtTyped(amt, country)}` : t("common.acceptPayment")}
            </button>
            {error && <p className="error" style={{ textAlign: "center" }}>{error}</p>}
            <div className="t-foot">{String(used)} / {String(limit)} sales today</div>
          </div>
        )}
      </div>
    </>
  );
}
