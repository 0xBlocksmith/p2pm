"use client";

import { useMemo } from "react";
import { useActiveAccount, useActiveWalletConnectionStatus } from "thirdweb/react";
import { prepareTransaction, sendTransaction as twSendTransaction } from "thirdweb";
import { thirdwebClient, THIRDWEB_CHAIN } from "../lib/thirdweb";

/**
 * The merchant's identity is their thirdweb SMART ACCOUNT (ERC-4337), created
 * from an in-app wallet (email/social) with gas SPONSORED by the thirdweb
 * paymaster — so the merchant transacts with 0 ETH. (This replaces the old Privy
 * smart wallet + Pimlico paymaster; the rest of the app is unchanged because the
 * returned shape is identical.)
 *
 * Returns (SAME shape the app already consumes):
 *   address          smart-account address (the on-chain merchant identity)
 *   ready            true once a smart account is connected and usable
 *   sendTransaction  ({ to, data, value? }) => `0x${hash}` — a sponsored tx
 *
 * `useActiveAccount()` returns the SMART account (not the underlying admin EOA)
 * because the wallet configured in providers.tsx wraps the in-app wallet in a
 * smartAccount({ sponsorGas: true }). So `account.address` IS the smart-account
 * address that gets registered on-chain.
 */
export function useSmartAccount() {
  const account = useActiveAccount();
  const status = useActiveWalletConnectionStatus();

  const address = account?.address as `0x${string}` | undefined;
  const ready = status === "connected" && !!account && !!address;

  const sendTransaction = useMemo(() => {
    if (!account) return null;
    return async ({
      to,
      data,
      value,
    }: {
      to: `0x${string}`;
      data: `0x${string}`;
      value?: bigint | number;
    }): Promise<`0x${string}`> => {
      // Build a raw transaction and send it through the smart account. thirdweb
      // routes it as a sponsored UserOperation (gas paid by the paymaster).
      const tx = prepareTransaction({
        client: thirdwebClient,
        chain: THIRDWEB_CHAIN,
        to,
        data,
        ...(value ? { value: BigInt(value) } : {}),
      });
      const { transactionHash } = await twSendTransaction({ account, transaction: tx });
      return transactionHash as `0x${string}`;
    };
  }, [account]);

  return { address, ready, sendTransaction, account };
}
