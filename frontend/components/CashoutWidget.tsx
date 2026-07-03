"use client";

import { useState, useCallback, useMemo } from "react";
import { Cashout } from "@p2pdotme/widgets/cashout";
import { encodeFunctionData, decodeEventLog } from "viem";
import { useCheckoutSigner } from "./useCheckoutSigner";
import { SUBGRAPH_URL, USDC_ADDRESS, DIAMOND_ADDRESS, resolveCircleId, codeToHex } from "../lib/p2p";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI, friendlyError } from "../lib/contract";
import { ACTIVE_CHAIN } from "../lib/chain";

/**
 * Fiat cash-out via the official p2p.me Cashout widget. The widget owns the full
 * offramp lifecycle — routing, status polling, and (critically) ENCRYPTING the
 * merchant's payout handle against the accepted merchant's on-chain pubkey at the
 * ACCEPTED handoff. Our integrator only supplies the on-chain txs via callbacks:
 *   placeCashout → withdrawFiat / withdrawFiatIn (SELL placement, carries the
 *                  relay pubKey; the payout is NOT sent here)
 *   deliverUpi   → deliverFiatPayout (submits the widget's already-ENCRYPTED blob)
 *   reconcile    → reconcileWithdrawal (recover a cancelled SELL)
 *
 * This mirrors how CheckoutWidget uses <Checkout> for the buy flow. Doing the
 * encrypt/deliver ourselves would be error-prone; the widget does it correctly.
 *
 * Props:
 *   defaultAmountUsdc  bigint (6-dec) — pre-fill
 *   currency           { code, flag, fiat, symbol } — the currency to cash out in
 *   isHome             true if withdrawing in the merchant's REGISTERED currency
 */
type CashoutWidgetProps = {
  defaultAmountUsdc?: bigint;
  currency: { code: string; flag?: string; fiat?: string; symbol?: string };
  isHome: boolean;
  onComplete?: (orderId: string) => void;
  onCancelled?: (orderId: string) => void;
  onClose?: () => void;
  onError?: (msg: string) => void;
};

export function CashoutWidget({
  defaultAmountUsdc, currency, isHome, onComplete, onCancelled, onClose, onError,
}: CashoutWidgetProps) {
  const { signer, publicClient, ready } = useCheckoutSigner();
  const [err, setErr] = useState("");

  // placeCashout: place the SELL through our integrator. ctx.usdcAmount is the
  // principal; ctx.userPubKey is the relay pubkey the assigned merchant encrypts
  // to; ctx.feeUsdc is the small-order fee (the contract tops it up at delivery).
  // Memoized: the parent (withdraw page) re-renders on a 1s ticker; an unmemoized
  // callback here would change identity every render and reset the widget's
  // status-poll interval before it could fire — so the widget would never see
  // ACCEPTED and never deliver the payout.
  const placeCashout = useCallback(async (ctx: any): Promise<{ orderId: string; txHash: string }> => {
    // Prefer the circleId the widget already resolved+validated (active circle
    // WITH merchants); fall back to our own lookup only if absent.
    const circleId = ctx?.currency?.circleId ?? (await resolveCircleId(currency.code));
    if (circleId == null) throw new Error(`No live circle for ${currency.code} yet.`);

    const data = isHome
      ? encodeFunctionData({
          abi: INTEGRATOR_ABI, functionName: "withdrawFiat",
          args: [ctx.usdcAmount as bigint, circleId, ctx.userPubKey as string, ""],
        })
      : encodeFunctionData({
          abi: INTEGRATOR_ABI, functionName: "withdrawFiatIn",
          args: [ctx.usdcAmount as bigint, circleId, codeToHex(currency.code) as `0x${string}`, ctx.userPubKey as string],
        });

    const { hash } = await signer!.sendTransaction({ to: CONTRACT_ADDRESS, data });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") throw new Error("Withdrawal placement reverted");

    // Parse the orderId from our WithdrawalFiat event.
    let orderId: string | null = null;
    for (const log of receipt.logs) {
      try {
        const ev: any = decodeEventLog({ abi: INTEGRATOR_ABI, data: (log as any).data, topics: (log as any).topics });
        if (ev.eventName === "WithdrawalFiat") { orderId = ev.args.orderId.toString(); break; }
      } catch { /* not our event */ }
    }
    if (!orderId) throw new Error("Couldn't read the withdrawal order id.");
    return { orderId, txHash: hash };
  }, [signer, publicClient, isHome, currency.code]);

  // deliverUpi: the widget already ENCRYPTED the payout to the merchant's pubkey;
  // we just submit it via deliverFiatPayout.
  const deliverUpi = useCallback(async (ctx: any): Promise<{ txHash: string }> => {
    // Validate the widget-supplied inputs. IMPORTANT: encPayout is a Solidity
    // `string` (the SDK's cipherStringify output), NOT 0x-hex — so only check it
    // is a non-empty string. (An earlier 0x-hex regex here WRONGLY rejected every
    // real payload → "Invalid payout payload". deliverFiatPayout is also gated
    // on-chain to merchant/owner/relayer, so the contract is the real guard.)
    const oid = BigInt(ctx.orderId);
    if (oid <= 0n) throw new Error("Invalid withdrawal order id.");
    const enc = ctx.encryptedUpi;
    if (typeof enc !== "string" || enc.length === 0) throw new Error("Missing payout payload.");
    const data = encodeFunctionData({
      abi: INTEGRATOR_ABI, functionName: "deliverFiatPayout",
      args: [oid, enc],
    });
    const { hash } = await signer!.sendTransaction({ to: CONTRACT_ADDRESS, data });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") throw new Error("Payout delivery reverted");
    return { txHash: hash };
  }, [signer, publicClient]);

  // reconcile: the widget calls this on BOTH terminal statuses — COMPLETED (3)
  // and CANCELLED (4). They need DIFFERENT contract calls:
  //   • COMPLETED → finalizeWithdrawal (frees the in-flight slot after a real payout)
  //   • CANCELLED → reconcileWithdrawal (sweep the refund back, re-credit)
  //
  // SECURITY/ROBUSTNESS: do NOT blindly trust the widget-supplied ctx.status to
  // choose. If it's wrong (spoofed/malformed), calling the wrong function reverts
  // (e.g. reconcileWithdrawal on a COMPLETED order → WithdrawalNotCancellable) and
  // leaves inFlightWithdrawals stuck at 1, permanently bricking the merchant's
  // future fiat withdrawals. So: pick the likely call from ctx.status, but if it
  // reverts, AUTOMATICALLY fall back to the other one. Exactly one is valid for a
  // given terminal on-chain state, so this self-corrects regardless of ctx.status.
  const callReconcile = useCallback(async (fn: "finalizeWithdrawal" | "reconcileWithdrawal", orderId: any) => {
    const data = encodeFunctionData({ abi: INTEGRATOR_ABI, functionName: fn, args: [BigInt(orderId)] });
    const { hash } = await signer!.sendTransaction({ to: CONTRACT_ADDRESS, data });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") throw new Error(fn + " reverted");
    return hash;
  }, [signer, publicClient]);

  const reconcile = useCallback(async (ctx: any): Promise<{ txHash: string }> => {
    const primary = Number(ctx?.status) === 3 ? "finalizeWithdrawal" : "reconcileWithdrawal";
    const fallback = primary === "finalizeWithdrawal" ? "reconcileWithdrawal" : "finalizeWithdrawal";
    try {
      return { txHash: await callReconcile(primary as any, ctx.orderId) };
    } catch {
      // ctx.status was wrong (or the order was in the other terminal state) — the
      // only other valid closer must succeed. If it also reverts, the order was
      // already settled (idempotent) — surface that.
      return { txHash: await callReconcile(fallback as any, ctx.orderId) };
    }
  }, [callReconcile]);

  const fetchAvailableOfframp = useCallback(async (user: `0x${string}`) => {
    const bal: any = await publicClient.readContract({
      address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI,
      functionName: "getMerchantBalance", args: [user],
    } as any);
    return bal[1] as bigint; // available (unlocked, 6-dec)
  }, [publicClient]);

  // Stable prop objects so the widget's effects don't re-fire on every parent tick.
  const currencies = useMemo(() => ([{
    symbol: currency.code, flag: currency.flag,
    paymentMethod: currency.fiat, symbolNative: currency.symbol,
  }]), [currency.code, currency.flag, currency.fiat, currency.symbol]);

  if (!ready || !signer) return <p className="muted">Preparing wallet…</p>;

  return (
    <>
      {err && <p className="error">{err}</p>}
      <Cashout
        mode="modal"
        open={true}
        signer={signer as any}
        chainId={ACTIVE_CHAIN.id}
        diamondAddress={(DIAMOND_ADDRESS || undefined) as `0x${string}`}
        usdcAddress={(USDC_ADDRESS || undefined) as `0x${string}`}
        subgraphUrl={SUBGRAPH_URL}
        currencies={currencies as any}
        defaultAmountUsdc={defaultAmountUsdc}
        /* The merchant's withdrawable funds live INSIDE the integrator
           (getMerchantBalance.available), NOT in their smart-wallet USDC balance
           (which is ~0 for a gasless merchant). Without this, the widget's
           "available"/Max/insufficient-balance would read the empty wallet and
           block legit cash-outs. Point it at the integrator's unlocked balance. */
        fetchAvailableOfframp={fetchAvailableOfframp}
        placeCashout={placeCashout}
        deliverUpi={deliverUpi}
        reconcile={reconcile}
        onComplete={(orderId: string) => onComplete?.(orderId)}
        onCancelled={(orderId: string) => onCancelled?.(orderId)}
        onError={(e: any) => { const m = e?.userMessage || friendlyError(e, e?.message || "Something went wrong."); setErr(m); onError?.(m); }}
        onClose={() => onClose?.()}
      />
    </>
  );
}
