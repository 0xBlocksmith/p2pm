"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icons";
import { thirdwebClient, THIRDWEB_CHAIN } from "../lib/thirdweb";

/**
 * "Connect to a dApp" — lets the merchant's in-app wallet act as a signer for an
 * external dApp via WalletConnect. The merchant pastes the WC URI shown by the
 * dApp ("wc:..."), we pair, and the dApp can then request signatures/txs which
 * thirdweb's default request handlers route through this wallet.
 *
 * The @walletconnect deps are heavy, so everything is imported dynamically the
 * first time the panel opens (this component is itself lazy-loaded by the sheet).
 * `wallet` is the connected thirdweb Wallet (from useActiveWallet()).
 */
export function WalletConnectPanel({ wallet, onBack }: { wallet: any; onBack: () => void }) {
  const [wcClient, setWcClient] = useState<any>(null);
  const [uri, setUri] = useState("");
  const [sessions, setSessions] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // Lazily build the WalletConnect client for this wallet and load any sessions
  // that are already active (e.g. from a previous visit).
  useEffect(() => {
    let alive = true;
    if (!wallet) return;
    (async () => {
      try {
        const { createWalletConnectClient, getActiveWalletConnectSessions } = await import(
          "thirdweb/wallets"
        );
        const c = await createWalletConnectClient({
          client: thirdwebClient,
          wallet,
          chains: [THIRDWEB_CHAIN],
          appMetadata: {
            name: "PayQR",
            url: typeof window !== "undefined" ? window.location.origin : "https://payqr.pro",
            description: "PayQR merchant wallet",
            logoUrl: typeof window !== "undefined" ? `${window.location.origin}/logo-mark.png` : "",
          },
          onConnect: () => { refreshSessions(); setMsg("Connected."); },
          onDisconnect: () => { refreshSessions(); },
          onError: (e: Error) => setMsg(e?.message || "WalletConnect error"),
        });
        if (!alive) return;
        setWcClient(c);
        const active = await getActiveWalletConnectSessions();
        if (alive) setSessions(active);
      } catch (e: any) {
        if (alive) setMsg(e?.message || "Couldn't start WalletConnect.");
      }
    })();
    return () => { alive = false; };
  }, [wallet]);

  async function refreshSessions() {
    try {
      const { getActiveWalletConnectSessions } = await import("thirdweb/wallets");
      setSessions(await getActiveWalletConnectSessions());
    } catch { /* ignore */ }
  }

  async function connect() {
    setMsg("");
    const trimmed = uri.trim();
    if (!trimmed.startsWith("wc:")) return setMsg("Paste the WalletConnect link (starts with wc:).");
    if (!wcClient) return setMsg("Still preparing — try again in a moment.");
    setBusy(true);
    try {
      const { createWalletConnectSession } = await import("thirdweb/wallets");
      createWalletConnectSession({ walletConnectClient: wcClient, uri: trimmed });
      setUri("");
      setMsg("Pairing… approve the request in the dApp.");
      // The onConnect callback refreshes the session list once pairing lands.
    } catch (e: any) {
      setMsg(e?.message || "Couldn't connect to that dApp.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(session: any) {
    if (!wcClient) return;
    setBusy(true);
    try {
      const { disconnectWalletConnectSession } = await import("thirdweb/wallets");
      await disconnectWalletConnectSession({ session, walletConnectClient: wcClient });
      await refreshSessions();
    } catch (e: any) {
      setMsg(e?.message || "Couldn't disconnect.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wallet-pane">
      <button className="wallet-back" onClick={onBack}>
        <Icon.Back width="16" height="16" /> Connect to a dApp
      </button>

      <label className="wallet-label">Paste WalletConnect link</label>
      <input
        className="input"
        placeholder="wc:…"
        value={uri}
        onChange={(e) => setUri(e.target.value.trim())}
      />
      <p className="wallet-hint" style={{ marginTop: 6 }}>
        On the website you want to connect, choose WalletConnect and copy its link, then paste it here.
      </p>
      <button className="btn" style={{ width: "100%", marginTop: 12 }} disabled={busy || !wcClient} onClick={connect}>
        {busy ? "Working…" : !wcClient ? "Preparing…" : "Connect"}
      </button>
      {msg && <p className={msg.startsWith("Connected") ? "success" : "muted"} style={{ textAlign: "center", marginTop: 8, fontSize: 13 }}>{msg}</p>}

      {sessions.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="wallet-label" style={{ marginBottom: 8 }}>Connected apps</div>
          {sessions.map((s) => (
            <div key={s.topic} className="wc-session">
              <span className="wc-session-name">{s.origin || "Connected dApp"}</span>
              <button className="btn ghost small" disabled={busy} onClick={() => disconnect(s)}>Disconnect</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
