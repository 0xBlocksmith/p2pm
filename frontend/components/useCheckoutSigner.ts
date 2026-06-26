"use client";

import { useMemo } from "react";
import { usePublicClient } from "wagmi";
import { useSmartAccount } from "./useSmartAccount";

/**
 * Adapts the merchant's Privy SMART WALLET to the @p2pdotme/widgets
 * `CheckoutSigner` interface:
 *   { address, sendTransaction({ to, data, gasLimit }) => { hash } }
 *
 * Transactions are sent as sponsored UserOperations through the smart wallet
 * (gas paid by the Pimlico paymaster), so the merchant needs 0 ETH.
 *
 * Returns { signer, publicClient, ready }.
 */
export function useCheckoutSigner() {
  const { address, ready, sendTransaction } = useSmartAccount();
  const publicClient = usePublicClient();

  const signer = useMemo(() => {
    if (!ready || !address || !sendTransaction) return null;
    return {
      address,
      signerAddress: address,
      sendTransaction: async ({ to, data }) => {
        // gasLimit is ignored — the bundler/paymaster handles gas estimation.
        const hash = await sendTransaction({ to, data });
        return { hash };
      },
    };
  }, [ready, address, sendTransaction]);

  return { signer, publicClient, ready: !!signer && !!publicClient };
}
