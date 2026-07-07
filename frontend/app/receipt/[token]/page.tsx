"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { createPublicClient, http } from "viem";
import { fetchOrder, receiptToken } from "../../../lib/history";
import { fmtUsdc, CONTRACT_ADDRESS, INTEGRATOR_ABI } from "../../../lib/contract";
import { ACTIVE_CHAIN, RPC_URL } from "../../../lib/chain";
import { Icon, Logo } from "../../../components/Icons";

// Read-only chain client (public receipt has no wallet — just reads). Use the
// CONFIGURED RPC, not the default public endpoint (which the app documents as
// 429-prone) — otherwise routine rate-limiting trips the ownership check's
// fail-open path and strips the "✓ verified" badge from legit receipts.
const reader = createPublicClient({ chain: ACTIVE_CHAIN, transport: http(RPC_URL) });

/** True for a DEFINITIVE contract-shape error (missing ABI function, decode
 *  mismatch, revert, or zero-data) — as opposed to a transient network/RPC error.
 *  A definitive error means our read is genuinely wrong/rejected, so the ownership
 *  check must fail CLOSED (treat as NOT ours). Transient errors fail OPEN so a
 *  flaky RPC doesn't block a real customer.
 *
 *  IMPORTANT: viem's readContract wraps EVERY failure — including a plain HTTP 429
 *  or timeout — in an outer ContractFunctionExecutionError, so classifying on the
 *  OUTER error name would mark every transient failure as "definitive" and fail
 *  closed on a flaky RPC. We instead WALK to the root cause (BaseError.walk) and
 *  use a positive allow-list of TRANSIENT roots; anything else (abi/revert/
 *  zero-data) is definitive. Default to transient (fail open) when unsure. */
function isDefinitiveError(e: any): boolean {
  // Unwrap viem's error chain to the innermost cause, if available.
  let root = e;
  if (e && typeof e.walk === "function") {
    root = e.walk() || e;
  }
  const rootName = String(root?.name || "");
  const outerName = String(e?.name || "");
  const msg = String(e?.shortMessage || e?.message || e || "");

  // Transient (network / RPC) → NOT definitive → fail open.
  if (
    /HttpRequestError|TimeoutError|RpcRequestError|RpcError|WebSocketRequestError|HttpRequest|Timeout/i.test(rootName) ||
    /HTTP request failed|took too long|timed out|rate limit|429|network|fetch failed|Failed to fetch/i.test(msg)
  ) {
    return false;
  }

  // Definitive contract-shape roots → fail closed.
  return (
    /AbiFunctionNotFound|AbiDecoding|AbiEncoding|ContractFunctionRevert|ContractFunctionZeroData|AbiErrorSignatureNotFound|InvalidAddress/i.test(rootName) ||
    /AbiFunctionNotFound|AbiDecoding|ContractFunctionRevert|ContractFunctionZeroData/i.test(outerName) ||
    /reverted|not found on ABI|does not exist|cannot decode|returned no data|zero data/i.test(msg)
  );
}

/** getMerchantInfo(addr) → { registered, shopName }. Returns registered=false on
 *  a definitive not-registered/contract error (fail CLOSED), or null ONLY on a
 *  transient RPC error (caller may fail open for a real customer on a flaky RPC). */
async function readMerchant(
  addr: string
): Promise<{ registered: boolean; shopName: string } | null> {
  try {
    // getMerchantInfo(address) returns
    //   (string payoutId, string shopName, bytes32 currency, bool isRegistered, bool isFrozen)
    const info: any = await reader.readContract({
      address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI,
      functionName: "getMerchantInfo", args: [addr as `0x${string}`],
    } as any);
    return { registered: info?.[3] === true, shopName: (info?.[1] as string) || "" };
  } catch (e) {
    // Definitive contract error → treat as NOT registered (fail closed).
    if (isDefinitiveError(e)) return { registered: false, shopName: "" };
    return null; // transient only
  }
}

// Result of the ownership check. Three states so the page never renders a
// foreign order as a valid "successful payment" on a fail-open:
//   "verified"   — chain-confirmed to belong to a registered PayQR merchant
//   "notOurs"    — definitively NOT a PayQR order (random/foreign) → "not found"
//   "unverified" — couldn't check (transient RPC) → "couldn't verify, refresh"
type OwnerCheck = { state: "verified" | "notOurs" | "unverified"; shopName: string };

/** Verify on-chain that an order belongs to one of OUR OWN registered PayQR
 *  merchants. Handles BUY (placer = merchant EOA) and SELL (placer = proxy).
 *  SECURITY: on a transient RPC failure we return "unverified" (NOT a pass) so a
 *  foreign order can never be shown as a valid receipt by inducing an RPC error;
 *  the customer just refreshes. Only a chain-confirmed registered merchant yields
 *  "verified"; a definitive non-match yields "notOurs". */
async function verifyOrderOwner(placer: string): Promise<OwnerCheck> {
  // 1) BUY case: the placer itself is the merchant EOA.
  const direct = await readMerchant(placer);
  if (direct === null) return { state: "unverified", shopName: "" }; // transient
  if (direct.registered) return { state: "verified", shopName: direct.shopName };

  // 2) SELL case: the placer is a per-merchant proxy → resolve to the merchant.
  let merchant: string;
  try {
    merchant = (await reader.readContract({
      address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI,
      functionName: "proxyMerchant", args: [placer as `0x${string}`],
    } as any)) as string;
  } catch (e) {
    // Definitive contract error → definitively not ours; transient → unverified.
    if (isDefinitiveError(e)) return { state: "notOurs", shopName: "" };
    return { state: "unverified", shopName: "" };
  }
  // Not a registered EOA AND not one of our proxies → definitively not ours.
  if (!merchant || /^0x0+$/i.test(merchant)) return { state: "notOurs", shopName: "" };

  const viaProxy = await readMerchant(merchant);
  if (viaProxy === null) return { state: "unverified", shopName: "" }; // transient
  return { state: viaProxy.registered ? "verified" : "notOurs", shopName: viaProxy.shopName };
}

const SCAN = "https://sepolia.basescan.org";

/**
 * PUBLIC customer receipt — no login. The merchant shares this link (or shows
 * the on-screen QR after a sale) so the person who just paid can verify the
 * transaction on-chain. The order itself is read from the subgraph; the shop
 * name + fiat amount the customer paid come from the link query (the chain only
 * records the USDC leg), and the order id / status / proof are trustless.
 */
export default function Receipt() {
  const { orderId } = useParams();
  const params = useSearchParams();
  // Only accept a NUMERIC order id from the URL (on-chain ids are integers).
  // Rejecting anything else prevents a crafted id from reaching the subgraph
  // query as arbitrary text.
  const rawId = Array.isArray(orderId) ? orderId[0] : orderId;
  const safeId = typeof rawId === "string" && /^\d+$/.test(rawId) ? rawId : "";
  // shop/fiat come from the link query — UNVERIFIED display hints only. The
  // trustworthy figures (USDC amount, status, order id) come from the chain
  // below; we never let the URL override those. Sanitize to plain text and cap
  // length so a crafted link can't inject markup or absurd strings.
  const clean = (s: string) => s.replace(/[<>]/g, "").slice(0, 40);
  const shop = clean(params.get("shop") || "");
  const fiat = clean(params.get("fiat") || "");   // display hint, e.g. "₹820"
  // Only accept a well-formed 32-byte tx hash from the URL — otherwise a crafted
  // ?tx= could point the "Confirmation → View" link at an unrelated basescan
  // path and lend a real pending receipt forged credibility.
  const txRaw = params.get("tx") || "";
  const txParam = /^0x[0-9a-fA-F]{64}$/.test(txRaw) ? txRaw : "";
  // Access token: proves the visitor holds the exact link the merchant shared
  // (derived from orderId + the real tx hash, unguessable before the payment
  // settles) rather than one who is just enumerating sequential order ids.
  const accessToken = params.get("token") || "";

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [verifiedShop, setVerifiedShop] = useState(""); // real shop name from chain
  const [imgBusy, setImgBusy] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);
  // Ownership gate: null = still checking; then "verified" (chain-confirmed ours),
  // "notOurs" (foreign/random → not found), or "unverified" (couldn't check →
  // refresh). We only render a valid receipt on "verified" — never fail open.
  const [ownerState, setOwnerState] = useState<null | "verified" | "notOurs" | "unverified">(null);
  // Bumping this re-runs the on-chain verification WITHOUT a full page reload
  // (the "Refresh" button on the unverified state). Keeps the PWA feel — no
  // white flash, no wallet/provider re-boot.
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let on = true;
    setLoading(true); setOwnerState(null);
    if (!safeId || !accessToken) { setLoading(false); setOwnerState("notOurs"); return; }
    fetchOrder(safeId).then((o: any) => {
      if (!on) return;
      setOrder(o); setLoading(false);
      if (!o) { setOwnerState("notOurs"); return; }
      // The token can only be recomputed once the order has a real on-chain
      // tx hash. No hash yet (still matching) → can't confirm the visitor
      // holds a valid link; ask them to wait rather than fail open.
      if (!o.txHash) { setOwnerState("unverified"); return; }
      if (receiptToken(safeId, o.txHash) !== accessToken) { setOwnerState("notOurs"); return; }
      if (!o.userAddress) { setOwnerState("unverified"); return; }
      // Verify on-chain that this order belongs to one of OUR registered
      // merchants BEFORE showing it as a valid receipt.
      verifyOrderOwner(o.userAddress).then((r) => {
        if (!on) return;
        setOwnerState(r.state);
        setVerifiedShop(r.shopName);
      });
    });
    return () => { on = false; };
  }, [safeId, accessToken, retry]);

  // The trustworthy shop name comes ONLY from the chain (verifiedShop). The URL
  // ?shop= hint is shown just as a fallback label AND only on a verified receipt —
  // never on the unverified/foreign path (that's the fail-open forgery vector).
  const shopVerified = !!verifiedShop;
  const shopName = shopVerified ? verifiedShop : shop;
  // Only "verified" renders the real receipt. Everything else shows a safe state.
  const verifying = !!order && ownerState === null; // fetched, still checking
  const notOurs = ownerState === "notOurs";         // definitively not a PayQR order
  const unverified = ownerState === "unverified";   // couldn't confirm (refresh)

  const settled = order?.status === "settled";
  const cancelled = order?.status === "cancelled";
  const txHash = order?.txHash || txParam;

  // Render the receipt card to a PNG and hand it to the OS share sheet (or
  // download it, if sharing files isn't supported) — so the customer can save
  // or forward proof of payment as an image instead of just a link.
  async function shareAsImage() {
    if (!captureRef.current || imgBusy) return;
    setImgBusy(true);
    try {
      const { default: html2canvas } = await import("html2canvas");
      const canvas = await html2canvas(captureRef.current, {
        backgroundColor: getComputedStyle(captureRef.current).backgroundColor || "#ffffff",
        scale: Math.min(window.devicePixelRatio || 2, 3),
      });
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) return;
      const file = new File([blob], `payqr-receipt-${order.orderId}.png`, { type: "image/png" });
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
      // Best-effort — leave the customer with the on-screen receipt if it fails.
    } finally {
      setImgBusy(false);
    }
  }

  return (
    <div className="rcpt-screen">
      <div className="rcpt-card" ref={captureRef}>
        <div className="brand rcpt-brand">
          <Logo size={24} className="brand-mark" /> PayQR
        </div>

        {loading || verifying ? (
          <p className="muted" style={{ textAlign: "center", padding: "30px 0" }}>
            {verifying ? "Verifying receipt…" : "Loading receipt…"}
          </p>
        ) : !order ? (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <h2>Receipt not ready yet</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              If you just paid, please wait a moment and refresh this page.
            </p>
          </div>
        ) : notOurs ? (
          // The order exists on-chain but was NOT placed through this PayQR
          // contract by a registered merchant — a random or foreign id. Never
          // render it as a valid receipt.
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <h2>Receipt not found</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              This receipt link isn’t valid. Please check the link from your
              payment, or ask the merchant to share it again.
            </p>
          </div>
        ) : unverified ? (
          // Couldn't confirm the order on-chain (network hiccup). We do NOT show
          // the order as a valid receipt here — that fail-open would let a forged
          // link display a foreign order as "paid". Ask the customer to refresh.
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <h2>Couldn’t verify yet</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              We couldn’t confirm this receipt on-chain right now. Please refresh
              in a moment.
            </p>
            <button className="btn" style={{ marginTop: 14 }}
              onClick={() => setRetry((n) => n + 1)}>
              Refresh
            </button>
          </div>
        ) : (
          <>
            <div className={`rcpt-tick ${cancelled ? "bad" : settled ? "ok" : "wait"}`}>
              {cancelled ? "✕" : <Icon.Check />}
            </div>
            <div className="rcpt-status">
              {cancelled ? "Payment cancelled" : settled ? "Payment successful" : "Payment going through"}
            </div>
            {shopName && (
              <div className="rcpt-shop">
                Paid to {shopName}
                {shopVerified && <span className="rcpt-verified" title="Shop name verified on-chain"> ✓ verified</span>}
              </div>
            )}

            {/* The on-chain USDC amount is the trustworthy figure (read from the
                subgraph). The fiat is a display hint from the link and shown as
                secondary — a receipt can't be forged into a different USDC amount. */}
            <div className="rcpt-amount">
              {fmtUsdc(order.amount)} USDC
            </div>
            {fiat && <div className="rcpt-amount-fiat">{fiat}</div>}
            <div className="rcpt-amount-sub">
              {cancelled
                ? "This payment did not go through"
                : settled
                  ? "Your payment is complete"
                  : "Your payment is being confirmed — this only takes a moment"}
            </div>

            <div className="rcpt-rows">
              <div className="rcpt-row"><span>Receipt no.</span><b>#{order.orderId}</b></div>
              <div className="rcpt-row">
                <span>Status</span>
                <b className={settled ? "g" : cancelled ? "r" : "w"}>
                  {settled ? "Completed" : cancelled ? "Cancelled" : "In progress"}
                </b>
              </div>
              {txHash && (
                <div className="rcpt-row">
                  <span>Confirmation</span>
                  <a className="link" target="_blank" rel="noopener noreferrer"
                     href={`${SCAN}/tx/${txHash}`}>View ↗</a>
                </div>
              )}
            </div>

            <p className="rcpt-foot">
              Save this receipt as proof of your payment.
            </p>
          </>
        )}
      </div>
      {order && !notOurs && !unverified && !loading && !verifying && (
        <button className="btn ghost rcpt-share-img" onClick={shareAsImage} disabled={imgBusy}>
          <Icon.Share width="15" height="15" /> {imgBusy ? "Preparing image…" : "Share as image"}
        </button>
      )}
    </div>
  );
}
