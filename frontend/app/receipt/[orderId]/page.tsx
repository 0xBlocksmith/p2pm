"use client";

import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { fetchOrder } from "../../../lib/history";
import { fmtUsdc } from "../../../lib/contract";
import { Icon, Logo } from "../../../components/Icons";

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
  const shop = params.get("shop") || "";
  const fiat = params.get("fiat") || "";        // pre-formatted, e.g. "₹820"
  const txParam = params.get("tx") || "";

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let on = true;
    fetchOrder(orderId).then((o) => { if (on) { setOrder(o); setLoading(false); } });
    return () => { on = false; };
  }, [orderId]);

  const settled = order?.status === "settled";
  const cancelled = order?.status === "cancelled";
  const txHash = order?.txHash || txParam;

  return (
    <div className="rcpt-screen">
      <div className="rcpt-card">
        <div className="brand rcpt-brand">
          <Logo size={24} className="brand-mark" /> PayQR
        </div>

        {loading ? (
          <p className="muted" style={{ textAlign: "center", padding: "30px 0" }}>
            Loading receipt…
          </p>
        ) : !order ? (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <h2>Receipt not ready yet</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              If you just paid, please wait a moment and refresh this page.
            </p>
          </div>
        ) : (
          <>
            <div className={`rcpt-tick ${cancelled ? "bad" : settled ? "ok" : "wait"}`}>
              {cancelled ? "✕" : <Icon.Check />}
            </div>
            <div className="rcpt-status">
              {cancelled ? "Payment cancelled" : settled ? "Payment successful" : "Payment going through"}
            </div>
            {shop && <div className="rcpt-shop">Paid to {shop}</div>}

            <div className="rcpt-amount">
              {fiat ? fiat : `${fmtUsdc(order.amount)} USDC`}
            </div>
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
    </div>
  );
}
