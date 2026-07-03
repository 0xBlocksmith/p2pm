"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../components/useAuth";
import { prefsSet } from "../lib/countries";
import { Splash } from "../components/Splash";

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
  const { ready, authenticated } = useAuth();

  useEffect(() => {
    if (!ready) return;
    if (!authenticated) { router.replace("/login"); return; }
    if (!prefsSet()) { router.replace("/login"); return; }
    router.replace("/dashboard");
  }, [ready, authenticated, router]);

  return <Splash />;
}
