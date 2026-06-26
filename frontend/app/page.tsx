"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { prefsSet } from "../lib/countries";

/**
 * Routing gate:
 *   not authenticated   -> /login
 *   no prefs yet        -> /login (currency+language are chosen there)
 *   else                -> /dashboard
 *
 * Currency + language are picked on the login page itself, so there's no
 * separate /select step. Registration is requested lazily on "Accept Payment".
 */
export default function Home() {
  const router = useRouter();
  const { ready: privyReady, authenticated } = usePrivy();

  useEffect(() => {
    if (!privyReady) return;
    if (!authenticated) { router.replace("/login"); return; }
    if (!prefsSet()) { router.replace("/login"); return; }
    router.replace("/dashboard");
  }, [privyReady, authenticated, router]);

  return (
    <div className="center">
      <p className="muted">Loading…</p>
    </div>
  );
}
