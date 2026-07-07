"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useReadContract } from "wagmi";
import { useActiveWallet } from "thirdweb/react";
import { QRCodeSVG } from "qrcode.react";
import { encodeFunctionData, parseUnits } from "viem";
import { Icon } from "./Icons";
import { useT } from "../lib/i18n";
import { useSmartAccount } from "./useSmartAccount";
import { useAuth } from "./useAuth";

// Heavy @walletconnect deps — only pulled in when the merchant opens the panel.
const WalletConnectPanel = dynamic(
  () => import("./WalletConnectPanel").then((m) => m.WalletConnectPanel),
  { ssr: false, loading: () => <p className="muted" style={{ textAlign: "center", padding: "24px 0" }}>Loading…</p> }
);
import { CONTRACT_ADDRESS, fmtUsdc } from "../lib/contract";
import { STATIC_STALE_MS } from "../lib/cache";
import { fmtFiat, clearLocalUserData } from "../lib/countries";
import { ACTIVE_CHAIN } from "../lib/chain";

const SCAN = "https://sepolia.basescan.org";
const USDC = (process.env.NEXT_PUBLIC_USDC_ADDRESS || "") as `0x${string}`;
const ERC20_TRANSFER = [{
  type: "function", name: "transfer", stateMutability: "nonpayable",
  inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
  outputs: [{ type: "bool" }],
}] as const;

// Matches the NEW multi-currency contract: getMerchantInfo returns 5 values
// (payoutId, shopName, currency, isRegistered, isFrozen). Indices 0/1 (payout,
// shop) are unchanged from the old 4-return shape, so the reads below still hold.
const INFO_ABI = [{
  type: "function", name: "getMerchantInfo", stateMutability: "view",
  inputs: [{ name: "merchant", type: "address" }],
  outputs: [
    { name: "payoutId", type: "string" }, { name: "shopName", type: "string" },
    { name: "currency", type: "bytes32" },
    { name: "isRegistered", type: "bool" }, { name: "isFrozen", type: "bool" },
  ],
}] as const;
const BAL_ABI = [{
  type: "function", name: "getMerchantBalance", stateMutability: "view",
  inputs: [{ name: "merchant", type: "address" }],
  outputs: [
    { name: "pending", type: "uint256" }, { name: "available", type: "uint256" },
    { name: "totalDeposited", type: "uint256" }, { name: "isFrozen", type: "bool" },
  ],
}] as const;

/**
 * Full wallet bottom-sheet (slides up from the dashboard Wallet tile). A real
 * crypto-wallet UI on the thirdweb smart account:
 *   • Receive — the smart-account address + a scannable QR (we render it)
 *   • Send    — a form → routed through the smart account (gasless)
 *   • Buy     — opens thirdweb Pay (fiat→USDC) to fund the account with a card
 * Plus the merchant's on-chain profile (shop, payout, currency) and balance.
 */
export function WalletSheet({
  open, onClose, address, country, rate,
}: {
  open: boolean; onClose: () => void; address?: string; country: any; rate: any;
}) {
  const { t } = useT();
  const router = useRouter();
  const { sendTransaction } = useSmartAccount();
  const { logout } = useAuth();
  const activeWallet = useActiveWallet();
  const [tab, setTab] = useState<"home" | "receive" | "send" | "walletconnect">("home");
  const [copied, setCopied] = useState(false);
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const { data: info } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INFO_ABI, functionName: "getMerchantInfo",
    args: [address as `0x${string}`], query: { enabled: !!address && open, staleTime: STATIC_STALE_MS },
  });
  const { data: balance } = useReadContract({
    address: CONTRACT_ADDRESS, abi: BAL_ABI, functionName: "getMerchantBalance",
    args: [address as `0x${string}`], query: { enabled: !!address && open, refetchInterval: 20000 },
  });

  const payoutId = info?.[0] || "";
  const shopName = info?.[1] || "";
  const pending = balance?.[0] ?? 0n;
  const available = balance?.[1] ?? 0n;
  const availUsdc = Number(available) / 1e6;
  const availFiat = rate && country ? availUsdc * rate.rate : null;

  function copyAddr() {
    if (!address) return;
    navigator.clipboard?.writeText(address);
    setCopied(true); setTimeout(() => setCopied(false), 1400);
  }

  function buy() {
    if (!address) return;
    // On-ramp: point at thirdweb Pay (fiat→USDC) prefilled to fund THIS smart
    // account on the active chain. Opens in a new tab; the team can later swap
    // this for an in-app <PayEmbed> if they want a fully embedded flow.
    const chainId = ACTIVE_CHAIN.id;
    const url =
      `https://thirdweb.com/pay` +
      `?chainId=${chainId}` +
      (USDC ? `&tokenAddress=${USDC}` : "") +
      `&recipientAddress=${address}`;
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function send() {
    setMsg("");
    if (!to.startsWith("0x") || to.length !== 42) return setMsg("Enter a valid wallet address.");
    const n = Number(amt);
    if (!(n > 0)) return setMsg("Enter an amount.");
    if (!USDC) return setMsg("USDC address not configured.");
    if (!sendTransaction) return setMsg("Wallet still connecting…");
    setBusy(true);
    try {
      const data = encodeFunctionData({
        abi: ERC20_TRANSFER, functionName: "transfer",
        args: [to as `0x${string}`, parseUnits(amt, 6)],
      });
      await sendTransaction({ to: USDC, data });
      setMsg("✓ Sent");
      setTo(""); setAmt("");
      setTimeout(() => { setTab("home"); setMsg(""); }, 1200);
    } catch (e: any) {
      setMsg(e?.shortMessage || e?.message || "Send failed");
    } finally { setBusy(false); }
  }

  if (!open) return null;
  return (
    <div className="sheet-overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />

        {/* header — avatar + address + "Smart Account" (wallet-app style) */}
        <div className="wsheet-head">
          <div className="wsheet-avatar">{(shopName || "M").slice(0, 1).toUpperCase()}</div>
          <div className="wsheet-id">
            <button className="wsheet-addr" onClick={copyAddr}>
              {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "…"}
              <span className="wsheet-copy">{copied ? "✓" : <Icon.Share width="13" height="13" />}</span>
            </button>
            <div className="wsheet-type">Smart Account</div>
          </div>
          <button className="sheet-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* HOME tab */}
        {tab === "home" && (
          <>
            {/* balance pill */}
            <div className="wsheet-bal">
              <span className="wsheet-bal-amt">${availUsdc.toFixed(2)}</span>
              <span className="wsheet-bal-sub">
                {availFiat != null ? `≈ ${fmtFiat(country, availFiat)}` : ""}
                {Number(pending) > 0 ? ` · ${fmtUsdc(pending)} ${t("tx.locked")}` : ""}
              </span>
            </div>

            {/* Send · Receive · Buy — outlined buttons like the sample */}
            <div className="wsheet-actions">
              <button className="wact" onClick={() => setTab("send")}>
                <Icon.Up width="18" height="18" /><span>{t("wallet.send")}</span>
              </button>
              <button className="wact primary" onClick={() => setTab("receive")}>
                <Icon.Down width="18" height="18" /><span>{t("wallet.receive")}</span>
              </button>
              <button className="wact" onClick={buy}>
                <Icon.Plus width="18" height="18" /><span>{t("wallet.buy")}</span>
              </button>
            </div>

            {/* network row */}
            <div className="wsheet-net">
              <span className="wnet-dot" />
              <span className="wnet-name">Base</span>
              <span className="wnet-bar" />
            </div>

            {/* menu list */}
            <nav className="wsheet-menu">
              <button className="wmenu-row" onClick={() => { onClose(); router.push("/transactions"); }}>
                <span className="wmenu-ico"><Icon.Repeat width="18" height="18" /></span>
                <span>{t("nav.transactions")}</span><span className="wmenu-car">›</span>
              </button>
              {address && (
                <a className="wmenu-row" href={`${SCAN}/address/${address}`} target="_blank" rel="noopener noreferrer">
                  <span className="wmenu-ico"><Icon.Wallet width="18" height="18" /></span>
                  <span>{t("wallet.viewAssets")}</span><span className="wmenu-car">↗</span>
                </a>
              )}
              <button className="wmenu-row" onClick={() => setTab("walletconnect")}>
                <span className="wmenu-ico"><Icon.Link width="18" height="18" /></span>
                <span>{t("wallet.connectDapp")}</span><span className="wmenu-car">›</span>
              </button>
              <button className="wmenu-row" onClick={() => { onClose(); router.push("/settings"); }}>
                <span className="wmenu-ico"><Icon.Gear width="18" height="18" /></span>
                <span>{t("wallet.manage")}</span><span className="wmenu-car">›</span>
              </button>
              <button className="wmenu-row danger" onClick={() => { onClose(); clearLocalUserData(); logout().finally(() => router.replace("/login")); }}>
                <span className="wmenu-ico"><Icon.Back width="18" height="18" /></span>
                <span>{t("wallet.disconnect")}</span>
              </button>
            </nav>
          </>
        )}

        {/* RECEIVE tab */}
        {tab === "receive" && (
          <div className="wallet-pane">
            <button className="wallet-back" onClick={() => setTab("home")}><Icon.Back width="16" height="16" /> {t("wallet.receive")}</button>
            <div className="wallet-qr">
              {address && <QRCodeSVG value={address} size={172} bgColor="#ffffff" fgColor="#16151f" level="M" />}
            </div>
            <p className="wallet-hint">{t("wallet.receiveHint")}</p>
            <button className="wallet-addr-box" onClick={copyAddr}>
              {address}
              <span className="wa-copy">{copied ? "✓ " + t("wallet.copied") : t("wallet.copy")}</span>
            </button>
          </div>
        )}

        {/* SEND tab */}
        {tab === "send" && (
          <div className="wallet-pane">
            <button className="wallet-back" onClick={() => setTab("home")}><Icon.Back width="16" height="16" /> {t("wallet.send")} USDC</button>
            <label className="wallet-label">{t("wallet.toAddress")}</label>
            <input className="input" placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value.trim())} />
            <label className="wallet-label" style={{ marginTop: 12 }}>{t("wallet.amount")} (USDC)</label>
            <input className="input" type="number" min="0" step="0.01" placeholder="0.00"
              value={amt} onChange={(e) => setAmt(e.target.value)} />
            {msg && <p className={msg.startsWith("✓") ? "success" : "error"} style={{ textAlign: "center" }}>{msg}</p>}
            <button className="btn" style={{ width: "100%", marginTop: 14 }} disabled={busy} onClick={send}>
              {busy ? t("wd.working") : `${t("wallet.send")} USDC`}
            </button>
          </div>
        )}

        {/* CONNECT TO A DAPP tab (WalletConnect) */}
        {tab === "walletconnect" && (
          <WalletConnectPanel wallet={activeWallet} onBack={() => setTab("home")} />
        )}
      </div>
    </div>
  );
}
