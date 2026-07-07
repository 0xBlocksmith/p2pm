"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useReadContract } from "wagmi";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI } from "../lib/contract";
import { STATIC_STALE_MS } from "../lib/cache";
import { useSmartAccount } from "./useSmartAccount";
import { useAuth } from "./useAuth";
import { prefsSet } from "../lib/countries";

/**
 * Shared page guard: requires wallet auth (thirdweb) + prefs.
 * Redirects to /login when logged out or when prefs are missing.
 *
 * The merchant's on-chain identity is their thirdweb SMART ACCOUNT (gas
 * sponsored) — so `address` here is the smart-account address.
 */
export function useMerchant({ requireRegistered = true } = {}) {
  const router = useRouter();
  const { ready: authReady, authenticated } = useAuth();
  const { address, ready: saReady, sendTransaction } = useSmartAccount();

  const { data: isRegistered, isLoading: regLoading, refetch } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: INTEGRATOR_ABI,
    functionName: "registered",
    args: [address],
    query: { enabled: !!address, staleTime: STATIC_STALE_MS },
  });

  useEffect(() => {
    if (authReady && !authenticated) router.replace("/login");
  }, [authReady, authenticated, router]);

  // Currency + language are chosen on the login page. If somehow missing
  // (e.g. direct deep-link), bounce back to login. Registration is NOT forced —
  // the dashboard opens for unregistered users; registration is requested
  // lazily when they tap "Accept Payment".
  useEffect(() => {
    if (requireRegistered && authReady && authenticated && !prefsSet()) {
      router.replace("/login");
    }
  }, [requireRegistered, authReady, authenticated, router]);

  // `ready` means "safe to act on address + isRegistered". During thirdweb's
  // multi-second smart-account init the address is briefly undefined; treating
  // that as ready would let pages route on a stale/undefined isRegistered and
  // flicker. So require the smart account AND (once we have an address) that the
  // registration read has actually resolved.
  const ready = authReady && (!authenticated || (saReady && !!address && !regLoading));

  return {
    ready,
    authenticated,
    address,
    isRegistered,
    refetchRegistered: refetch,
    sendTransaction,
  };
}
