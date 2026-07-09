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
 *   usdcAmount  bigint (6-dec) — what the merchant is charging
 *   quantity    bigint — product-2 units (USDC cents) for our userPlaceOrder
 *   productName string
 *   onComplete  (orderId) => void
 *   onClose     () => void
 */
type CheckoutWidgetProps = {
  orderId?: string;
  usdcAmount: bigint;
  quantity: bigint;
  productName?: string;
  currencies?: any[];
  onPlaced?: (orderId: any, txHash?: any) => void;
  onComplete?: (orderId: any) => void;
  onCancel?: (orderId?: any) => void;
  onClose?: () => void;
  onError?: (msg: string) => void;
};

export function CheckoutWidget({ orderId, usdcAmount, quantity, productName, currencies, onPlaced, onComplete, onCancel, onClose, onError }: CheckoutWidgetProps) {
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
        amount={`${(Number(usdcAmount) / 1e6).toFixed(2)} USDC`}
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
