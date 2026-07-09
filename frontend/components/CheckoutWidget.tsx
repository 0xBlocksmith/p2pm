"use client";

import { useState, useEffect } from "react";
import { Checkout } from "@p2pdotme/widgets/checkout";
import { useCheckoutSigner } from "./useCheckoutSigner";
import { useRelayIdentity } from "./useRelayIdentity";
import { makePlaceOrder, SUBGRAPH_URL, USDC_ADDRESS, DIAMOND_ADDRESS, CURRENCIES } from "../lib/p2p";
import { ACTIVE_CHAIN } from "../lib/chain";
import { Icon } from "./Icons";

/**
 * Live UPI checkout via the official p2p.me widget. The widget generates the
 * relay identity (user pubkey), auto-resolves the INR circle through the
 * subgraph, and drives the place → accept → pay → complete flow. We supply the
 * placeOrder callback that calls OUR integrator's userPlaceOrder.
 *
 * The caller (qr page) only mounts this AFTER confirming an LP is assignable
 * (isPaymentPartnerAvailable), so placement won't fail with "no payment partner".
 *
 * Props:
 *   orderId     string — when set, the widget skips placeOrder and tracks an
 *               already-placed order instead (resuming a payment the merchant
 *               reopened this dialog for)
 *   usdcAmount  bigint (6-dec) — the GROSS order amount the customer's fiat buys.
 *               Drives the on-chain order + the widget's fiat breakdown, so the
 *               customer pays exactly the merchant's entered fiat.
 *   creditedUsdc bigint (6-dec, optional) — the NET USDC that lands in the
 *               merchant's wallet after the small-order fee. Shown as the headline
 *               "X USDC" so both the Accept page and the widget display what the
 *               merchant KEEPS. Falls back to usdcAmount when not supplied.
 *   quantity    bigint — product-2 units (6-dec USDC units) for our userPlaceOrder
 *   productName string
 *   onComplete  (orderId) => void
 *   onClose     () => void
 */
type CheckoutWidgetProps = {
  orderId?: string;
  usdcAmount: bigint;
  creditedUsdc?: bigint;
  quantity: bigint;
  productName?: string;
  currencies?: any[];
  onPlaced?: (orderId: any, txHash?: any) => void;
  onComplete?: (orderId: any) => void;
  onCancel?: (orderId?: any) => void;
  onClose?: () => void;
  onError?: (msg: string) => void;
};

export function CheckoutWidget({ orderId, usdcAmount, creditedUsdc, quantity, productName, currencies, onPlaced, onComplete, onCancel, onClose, onError }: CheckoutWidgetProps) {
  const { signer, publicClient, ready } = useCheckoutSigner();
  const { getIdentity, syncToSdkStore } = useRelayIdentity();
  const [err, setErr] = useState("");
  // The widget DECRYPTS the LP's payout handle with the SDK's global relay-identity
  // slot, but we PLACE the order with our per-address key. Mirror ours into the
  // global slot BEFORE the widget mounts so both sides use the same key — otherwise
  // decryption fails and the widget shows "Session changed" in the PIX/UPI field.
  // Gate the render on this so the widget's first decrypt reads the synced key.
  const [identityReady, setIdentityReady] = useState(false);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    syncToSdkStore()
      .then(() => { if (alive) setIdentityReady(true); })
      .catch(() => { if (alive) setIdentityReady(true); }); // don't block checkout on a sync hiccup
    return () => { alive = false; };
  }, [ready, syncToSdkStore]);

  if (!ready || !identityReady) {
    return <p className="muted">Preparing wallet…</p>;
  }

  const placeOrder = makePlaceOrder({ signer, publicClient, quantity, getIdentity });

  return (
    <div className="checkout-fullscreen">
      {onClose && (
        <button className="checkout-fullscreen-close" onClick={onClose} aria-label="Close">
          <Icon.Close />
        </button>
      )}
      {err && <p className="error">{err}</p>}
      <Checkout
        mode="inline"
        orderId={orderId}
        signer={signer}
        chainId={ACTIVE_CHAIN.id}
        diamondAddress={(DIAMOND_ADDRESS || undefined) as `0x${string}` | undefined}
        currencies={currencies && currencies.length ? currencies : CURRENCIES}
        productName={productName}
        // Headline shows the NET amount that lands in the merchant's wallet (after
        // the small-order fee), matching the Accept page's "you keep" figure. The
        // on-chain order + fiat breakdown still use the GROSS usdcAmount below, so
        // the customer pays exactly the entered fiat.
        amount={`${(Number(creditedUsdc ?? usdcAmount) / 1e6).toFixed(2)} USDC`}
        subgraphUrl={SUBGRAPH_URL}
        usdcAddress={(USDC_ADDRESS || undefined) as `0x${string}` | undefined}
        usdcAmount={usdcAmount}
        placeOrder={placeOrder}
        onOrderPlaced={(orderId, txHash) => onPlaced?.(orderId, txHash)}
        onComplete={(orderId) => onComplete?.(orderId)}
        onCancel={(orderId) => onCancel?.(orderId)}
        onError={(e) => { const m = e?.message || String(e); setErr(m); onError?.(m); }}
        onClose={() => onClose?.()}
      />
    </div>
  );
}
