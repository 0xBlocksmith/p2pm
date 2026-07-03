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

      // The sponsored-tx path calls thirdweb's bundler/paymaster (gas price,
      // sponsorship, submit). Those endpoints occasionally return a TRANSIENT
      // infra error — Cloudflare 522/504, a timeout, or a non-JSON body that
      // surfaces as "Unexpected token 'e'…". Auto-retry a few times with backoff
      // before failing, so a momentary blip doesn't break registration/withdraw.
      let lastErr: any;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const { transactionHash } = await twSendTransaction({ account, transaction: tx });
          return transactionHash as `0x${string}`;
        } catch (e: any) {
          lastErr = e;
          const msg = String(e?.message || e || "");
          const transient =
            /5\d\d|522|504|503|429|timed out|timeout|Unexpected token|not valid JSON|fetch failed|Failed to fetch|network|ECONN|socket hang up/i.test(msg);
          // A user rejection or a real revert is NOT retryable — bail immediately.
          if (!transient || /reject|revert|denied|insufficient/i.test(msg)) throw e;
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        }
      }
      throw lastErr;
    };
  }, [account]);

  return { address, ready, sendTransaction, account };
}
