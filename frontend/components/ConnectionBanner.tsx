"use client";

import { useEffect, useState } from "react";
import { SUBGRAPH_URL } from "../lib/p2p";

/**
 * Shows a slim banner when the device is offline or the subgraph (which powers
 * history + live rate) is unreachable — so the app never silently looks broken.
 */
export function ConnectionBanner() {
  const [offline, setOffline] = useState(false);
  const [subDown, setSubDown] = useState(false);

  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    if (typeof navigator !== "undefined") setOffline(!navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  useEffect(() => {
    let alive = true;
    async function check() {
      try {
        const res = await fetch(SUBGRAPH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: "{ _meta { block { number } } }" }),
        });
        const j = await res.json();
        if (alive) setSubDown(!j?.data?._meta);
      } catch {
        if (alive) setSubDown(true);
      }
    }
    check();
    const t = setInterval(check, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!offline && !subDown) return null;

  return (
    <div className="conn-banner">
      {offline
        ? "You're offline — changes will sync when you reconnect."
        : "Live data is delayed — reconnecting to the network…"}
    </div>
  );
}
