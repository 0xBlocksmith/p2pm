"use client";

import { useCallback, useEffect, useMemo } from "react";
import {
  useActiveAccount,
  useActiveWallet,
  useActiveWalletConnectionStatus,
  useConnectModal,
  useDisconnect,
  useProfiles,
} from "thirdweb/react";
import { inAppWallet } from "thirdweb/wallets";
import { thirdwebClient, THIRDWEB_CHAIN } from "../lib/thirdweb";

// The p2p Cashout WIDGET keeps its OWN relay identity in a single GLOBAL
// localStorage slot (@P2PME:RELAY_IDENTITY) that we cannot override via props.
// To stop a shared device from reusing merchant A's key for merchant B's fiat
// payout (B's UPI would encrypt to A's key), we wipe that global key — and the
// stale per-session data — whenever the CONNECTED ADDRESS CHANGES, not only on
// logout. This closes the account-switch leak even if A never pressed logout.
const LAST_ADDR_KEY = "payqr.lastAddr";
// On an account SWITCH, purge state that would otherwise leak from the previous
// merchant: the WIDGET's global un-scoped relay key, any other account's scoped
// relay keys, and the in-progress session/dismiss lists. The now-current
// address's OWN scoped relay key (payqr.relay:<current>) is preserved.
function purgeCrossAccountState(currentAddr: string) {
  const cur = "payqr.relay:" + currentAddr.toLowerCase();
  try {
    ["@P2PME:RELAY_IDENTITY", "payqr.pendingSession", "payqr.dismissedStuck"].forEach(
      (k) => localStorage.removeItem(k)
    );
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("payqr.relay:") && k !== cur) toRemove.push(k);
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}

/**
 * ALL in-app login options thirdweb offers. Whichever of these you ENABLE in the
 * thirdweb dashboard (Connect → In-App Wallets → Auth) will appear in the modal;
 * listing one here that isn't enabled in the dashboard just won't show. See the
 * team checklist in the migration notes for which to switch on.
 */
const AUTH_OPTIONS = [
  "email",
  "google",
  // Only email + Google are offered. Phone and the other social providers
  // (apple/facebook/discord/x/telegram/farcaster) are intentionally omitted to
  // keep the login simple, and "passkey"/"guest" are excluded too (guest lets
  // anyone spin up throwaway identities — a fraud-account vector).
] as const;

/**
 * The wallet the merchant connects: an in-app wallet (email/social) wrapped in a
 * gas-SPONSORED smart account. `useActiveAccount()` then returns the SMART
 * account, so the on-chain identity is the smart-account address.
 *
 * Exported so providers.tsx can pass the SAME instance to ConnectEmbed/modal and
 * so auto-connect restores the same wallet shape on reload.
 */
export function makeAppWallet() {
  return inAppWallet({
    auth: { options: AUTH_OPTIONS as unknown as any[] },
    // Convert the in-app EOA into an ERC-4337 SMART ACCOUNT with SPONSORED gas.
    // Uses the current `executionMode` API (the older top-level `smartAccount`
    // field is deprecated). With this, useActiveAccount() returns the SMART
    // account — so account.address is the smart-account address that gets
    // registered on-chain, and gas is paid by the thirdweb paymaster (0 ETH).
    executionMode: {
      mode: "EIP4337",
      smartAccount: {
        chain: THIRDWEB_CHAIN,
        sponsorGas: true,
      },
    },
  });
}

// The single wallet the app connects with (in-app + sponsored smart account).
export const appWallets = [makeAppWallet()];

/**
 * Auth facade that mirrors the shape the app used from Privy's usePrivy():
 *   { ready, authenticated, email, login, logout }
 * so pages don't need to know about thirdweb.
 */
export function useAuth() {
  const status = useActiveWalletConnectionStatus(); // 'connecting'|'connected'|'disconnected'|'unknown'
  const account = useActiveAccount();
  const wallet = useActiveWallet();
  const { connect } = useConnectModal();
  const { disconnect } = useDisconnect();
  // In-app wallet profiles expose the login identifier (email / social handle).
  const { data: profiles } = useProfiles({ client: thirdwebClient });

  const ready = status !== "connecting" && status !== "unknown";
  const authenticated = status === "connected" && !!account;

  // Account-switch guard: when a DIFFERENT address connects than we last saw,
  // purge cross-account state (the widget's global relay key etc.) so no key or
  // session leaks from the previous merchant on a shared device.
  const activeAddr = account?.address?.toLowerCase();
  useEffect(() => {
    if (!activeAddr) return;
    let last: string | null = null;
    try { last = localStorage.getItem(LAST_ADDR_KEY); } catch {}
    if (last && last !== activeAddr) purgeCrossAccountState(activeAddr);
    try { localStorage.setItem(LAST_ADDR_KEY, activeAddr); } catch {}
  }, [activeAddr]);

  const email = useMemo(() => {
    const p: any = profiles?.[0];
    return (
      p?.details?.email ||
      p?.details?.phone ||
      p?.details?.address ||
      ""
    );
  }, [profiles]);

  // Opens the thirdweb Connect modal with our in-app (email/social) wallet +
  // sponsored smart account. Resolves once connected.
  const login = useCallback(async () => {
    await connect({
      client: thirdwebClient,
      chain: THIRDWEB_CHAIN,
      wallets: [makeAppWallet()],
      // One wallet → skip the wallet-list and go straight to the login options.
      showThirdwebBranding: false,
      size: "compact",
    });
  }, [connect]);

  const logout = useCallback(async () => {
    if (wallet) await disconnect(wallet);
  }, [wallet, disconnect]);

  return { ready, authenticated, email, login, logout };
}
