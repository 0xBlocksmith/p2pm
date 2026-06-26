"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icons";

/**
 * "Download the app" button — ALWAYS visible (login + nav). On tap:
 *  • If the browser supports the native PWA install prompt (Chrome/Edge,
 *    desktop + Android) → fire it for one-tap "Add to Home Screen".
 *  • Otherwise (iOS Safari, Firefox, …) → show a small instructions popup
 *    so the user can still add it to their home screen manually.
 *
 * Hidden only when the app is already running as an installed PWA.
 *
 * `variant`: "icon" (nav, black/white pill) or "full" (login, labelled button).
 */
export function InstallButton({ variant = "icon" }: { variant?: "icon" | "full" }) {
  const [deferred, setDeferred] = useState<any>(null);
  const [installed, setInstalled] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const onPrompt = (e: any) => { e.preventDefault(); setDeferred(e); };
    const onInstalled = () => { setInstalled(true); setDeferred(null); setShowHelp(false); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    if (window.matchMedia?.("(display-mode: standalone)").matches) setInstalled(true);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  async function onClick() {
    if (deferred) {
      deferred.prompt();
      try { await deferred.userChoice; } catch {}
      setDeferred(null);
    } else {
      // No native prompt available → show manual instructions.
      setShowHelp(true);
    }
  }

  if (installed) return null;

  const isIOS = typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent);

  return (
    <>
      {variant === "full" ? (
        <button className="install-full" onClick={onClick}>
          <Icon.Download /> Download the app
        </button>
      ) : (
        <button className="install-btn" onClick={onClick} aria-label="Download the app" title="Download the app">
          <Icon.Download />
        </button>
      )}

      {showHelp && (
        <div className="inst-overlay" onClick={() => setShowHelp(false)}>
          <div className="inst-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="inst-icon"><Icon.Download /></div>
            <div className="inst-h">Add PayQR to your phone</div>
            {isIOS ? (
              <p className="inst-p">
                In Safari, tap the <b>Share</b> button <span className="inst-share">⬆️</span>,
                then choose <b>“Add to Home Screen”</b>. PayQR will install like a normal app.
              </p>
            ) : (
              <p className="inst-p">
                Open this page in <b>Chrome</b>, tap the <b>⋮ menu</b>, then
                <b> “Install app”</b> / <b>“Add to Home screen”</b>. It’ll work like a normal app.
              </p>
            )}
            <button className="btn inst-ok" onClick={() => setShowHelp(false)}>Got it</button>
          </div>
        </div>
      )}
    </>
  );
}
