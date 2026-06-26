"use client";

import { useMemo } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets";

/**
 * The merchant's identity is their Privy SMART WALLET (Kernel ERC-4337), not
 * the embedded EOA. Gas is sponsored by the Pimlico paymaster configured in the
 * Privy dashboard, so the merchant transacts with 0 ETH.
 *
 * Returns:
 *   address          smart wallet address (the on-chain merchant identity)
 *   ready            true once Privy is ready, authenticated, and the smart
 *                    wallet + client exist
 *   sendTransaction  ({ to, data, value? }) => `0x${hash}` — a sponsored tx
 *                    (UserOperation) sent through the smart wallet
 *
 * `sendTransaction` returns the tx hash string directly (matches what callers
 * pass to publicClient.waitForTransactionReceipt({ hash })).
 */
export function useSmartAccount() {
  const { ready: privyReady, authenticated, user } = usePrivy();
  const { client } = useSmartWallets();

  // Resolve the smart-wallet address from every place Privy may expose it, so
  // the UI shows it as soon as it exists (client, linkedAccounts, or the
  // top-level user.smartWallet shortcut). Smart-wallet only — never the EOA.
  const linkedSmart: any = user?.linkedAccounts?.find((a: any) => a.type === "smart_wallet");
  const address: `0x${string}` | undefined =
    client?.account?.address ||
    linkedSmart?.address ||
    (user as any)?.smartWallet?.address ||
    undefined;

  const ready = !!(privyReady && authenticated && client && address);

  const sendTransaction = useMemo(() => {
    if (!client) return null;
    return async ({ to, data, value }: { to: `0x${string}`; data: `0x${string}`; value?: bigint | number }) => {
      // Privy's smart-wallet client routes this through the bundler + paymaster.
      // showWalletUIs:false suppresses the per-tx confirmation modal — gas is
      // sponsored, so no approval is needed. Because the p2p widget's pay/cancel
      // txs also flow through this signer, this covers the whole flow (place →
      // pay → cancel) with zero popups.
      const hash = await client.sendTransaction(
        {
          to,
          data,
          ...(value ? { value: BigInt(value) } : {}),
        } as any,
        { uiOptions: { showWalletUIs: false } }
      );
      return hash;
    };
  }, [client]);

  return { address, ready, sendTransaction, client };
}
