"use client";

import { ThirdwebProvider, AutoConnect } from "thirdweb/react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ACTIVE_CHAIN, RPC_URL } from "../lib/chain";
import { thirdwebClient } from "../lib/thirdweb";
import { appWallets } from "../components/useAuth";
import { ThemeProvider } from "../components/theme";
import { AppUpdateProvider } from "../components/AppUpdate";
import { UpdateBanner } from "../components/UpdateBanner";

/**
 * thirdweb owns WALLET + AUTH + gasless smart account (see lib/thirdweb.ts,
 * useAuth, useSmartAccount). wagmi is kept purely as the READ layer — every
 * useReadContract in the app reads through it, no wallet connector needed.
 */

// One throttled/batched transport applied to whichever chain is active. Both
// Base ids are keyed so the transports record satisfies wagmi's chain-union type
// (ACTIVE_CHAIN is env-selected: base | baseSepolia); only the active one is used.
const rpc = http(RPC_URL, { batch: { wait: 200 }, retryCount: 2, retryDelay: 1500 });

const wagmiConfig = createConfig({
  chains: [ACTIVE_CHAIN],
  transports: {
    [base.id]: rpc,
    [baseSepolia.id]: rpc,
  },
  batch: { multicall: true },
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Don't retry-storm on rate limits; serve cached data while refetching.
      retry: 1,
      retryDelay: 2000,
      staleTime: 10_000,
    },
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={wagmiConfig}>
          <ThirdwebProvider>
            {/* CRITICAL: without AutoConnect, the connection status is stuck at
                "unknown" forever — the login button never enables and a logged-in
                session is never restored on reload. AutoConnect drives the status
                machine on first load AND reconnects the persisted in-app wallet,
                reconstructing the SAME smart account (appWallets carries the
                EIP-4337 + sponsorGas config). */}
            <AutoConnect client={thirdwebClient} wallets={appWallets} />
            {/* Registers the service worker and drives OTA update detection;
                UpdateBanner shows the global "update ready · refresh" toast. */}
            <AppUpdateProvider>
              {children}
              <UpdateBanner />
            </AppUpdateProvider>
          </ThirdwebProvider>
        </WagmiProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
