"use client";

/**
 * PWA over-the-air update manager.
 *
 * Registers /sw.js, then watches for a NEW service worker becoming available
 * (a code push). The new worker installs into the "waiting" state (sw.js no
 * longer calls skipWaiting on install), so the app can surface an "update
 * ready" prompt instead of the update landing silently on the next cold start.
 *
 * When the merchant accepts, we post SKIP_WAITING to the waiting worker; it
 * activates and fires `controllerchange`, on which we reload once onto the new
 * version. We also poll for updates periodically and whenever the app regains
 * focus/visibility, so a long-lived POS tab picks up releases without a manual
 * restart.
 *
 * Exposes `useAppUpdate()` → { updateReady, checking, checkNow, applyUpdate }.
 * Consumed by <UpdateBanner> (global toast) and the Settings "check for
 * updates" row.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

type UpdateCtx = {
  updateReady: boolean;   // a new worker is installed & waiting to take over
  checking: boolean;      // a manual/auto update check is in flight
  checkNow: () => void;   // ask the browser to re-fetch the SW now
  applyUpdate: () => void; // activate the waiting worker + reload
};

const Ctx = createContext<UpdateCtx>({
  updateReady: false,
  checking: false,
  checkNow: () => {},
  applyUpdate: () => {},
});

// How often a running tab re-checks for a new service worker (ms). POS tabs can
// stay open all day; 30 min keeps them current without hammering the network.
const POLL_MS = 30 * 60 * 1000;

export function AppUpdateProvider({ children }: { children: React.ReactNode }) {
  const [updateReady, setUpdateReady] = useState(false);
  const [checking, setChecking] = useState(false);
  const regRef = useRef<ServiceWorkerRegistration | null>(null);
  // Guards the one-time reload after the new worker takes control, so we never
  // loop-reload (controllerchange can fire more than once).
  const reloadingRef = useRef(false);

  // Mark "update ready" when a worker is sitting in `waiting` for THIS page.
  // Only treat it as an update if the page is already controlled by a worker —
  // on the very first install there's a waiting worker but no old version to
  // replace, so prompting "update available" then would be wrong.
  const noteWaiting = useCallback((reg: ServiceWorkerRegistration) => {
    if (reg.waiting && navigator.serviceWorker.controller) setUpdateReady(true);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    let cancelled = false;

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        if (cancelled) return;
        regRef.current = reg;

        // Already a worker waiting from a prior visit?
        noteWaiting(reg);

        // A new worker started installing — watch it reach "installed" (waiting).
        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener("statechange", () => {
            if (nw.state === "installed") noteWaiting(reg);
          });
        });
      } catch {
        // SW unsupported / blocked (e.g. private mode) — app still works online.
      }
    };

    // Reload exactly once when the new worker takes control of the page.
    const onControllerChange = () => {
      if (reloadingRef.current) return;
      reloadingRef.current = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    // Register after load so it never competes with first paint.
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });

    // Periodic + on-focus update checks.
    const poll = setInterval(() => { regRef.current?.update().catch(() => {}); }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") regRef.current?.update().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, [noteWaiting]);

  // Manual "check for updates": ask the browser to re-fetch the SW. If a new
  // one is found it flows through updatefound → statechange → updateReady.
  const checkNow = useCallback(() => {
    const reg = regRef.current;
    if (!reg) return;
    setChecking(true);
    reg.update()
      .then(() => noteWaiting(reg))
      .catch(() => {})
      .finally(() => setChecking(false));
  }, [noteWaiting]);

  // Apply: tell the waiting worker to activate; controllerchange then reloads.
  // Fallback: if there's no waiting worker (edge case), just reload.
  const applyUpdate = useCallback(() => {
    const reg = regRef.current;
    if (reg?.waiting) {
      reg.waiting.postMessage({ type: "SKIP_WAITING" });
    } else {
      window.location.reload();
    }
  }, []);

  return (
    <Ctx.Provider value={{ updateReady, checking, checkNow, applyUpdate }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAppUpdate() {
  return useContext(Ctx);
}
