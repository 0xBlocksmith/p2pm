"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePrivy } from "@privy-io/react-auth";
import { useReadContract } from "wagmi";
import { Nav } from "../../components/Nav";
import { useMerchant } from "../../components/useMerchant";
import { useSmartAccount } from "../../components/useSmartAccount";
import { Icon } from "../../components/Icons";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI } from "../../lib/contract";
import {
  COUNTRIES, LANGUAGES, loadCountry, loadLang, saveCountry, saveLang,
} from "../../lib/countries";
import { useTheme } from "../../components/theme";
import { useT } from "../../lib/i18n";

const THEMES = [
  { id: "light", labelKey: "set.light", Ico: Icon.Sun },
  { id: "dark", labelKey: "set.dark", Ico: Icon.Moon },
  { id: "system", labelKey: "set.system", Ico: Icon.Help },
];

const SCAN = "https://sepolia.basescan.org";

export default function Settings() {
  const router = useRouter();
  const { user, logout } = usePrivy();
  useMerchant(); // page guard (auth + prefs)
  const { address } = useSmartAccount(); // same source the account menu uses
  const { theme, setTheme } = useTheme();
  const { t, lang, setLang } = useT();
  const [country, setCountry] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => { setCountry(loadCountry()); }, []);

  const { data: info } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantInfo",
    args: [address], query: { enabled: !!address },
  });
  const payoutId = info?.[0] || "";
  const shopName = info?.[1] || "";
  const email = user?.email?.address || user?.google?.email || "";

  function pickCountry(c) { setCountry(c); saveCountry(c.id); }
  function pickLang(code) { setLang(code); }
  function copyAddr() {
    if (!address) return;
    navigator.clipboard?.writeText(address);
    setCopied(true); setTimeout(() => setCopied(false), 1400);
  }

  if (!country) return <><Nav back /><div className="screen"><p className="muted" style={{ textAlign: "center" }}>{t("common.loading")}</p></div></>;

  return (
    <>
      <Nav back />
      <div className="screen">
        <h1 style={{ textAlign: "center", marginBottom: 14 }}>{t("set.title")}</h1>

        {/* profile card */}
        <div className="set-card">
          <div className="set-avatar">{(shopName || email || "M").slice(0, 1).toUpperCase()}</div>
          <div className="set-id">
            <div className="set-shop">{shopName || "Your shop"}</div>
            {email && <div className="set-email">{email}</div>}
          </div>
        </div>

        {/* shop details (on-chain) */}
        <div className="set-group">
          <div className="set-glabel">{t("set.shop")}</div>
          <div className="set-item">
            <span className="set-k">{t("set.shopName")}</span>
            <span className="set-v">{shopName || "—"}</span>
          </div>
          <div className="set-item">
            <span className="set-k">{country.payoutLabel}</span>
            <span className="set-v">{payoutId || "—"}</span>
          </div>
          <div className="set-item">
            <span className="set-k">{t("set.wallet")}</span>
            {address ? (
              <button className="set-addr" onClick={copyAddr}>
                {`${address.slice(0, 6)}…${address.slice(-4)}`}
                <span className="set-copy">{copied ? "copied ✓" : "⧉"}</span>
              </button>
            ) : (
              <span className="set-v" style={{ color: "var(--muted)" }}>connecting…</span>
            )}
          </div>
          {address && (
            <a className="set-link" href={`${SCAN}/address/${address}`} target="_blank" rel="noopener noreferrer">
              View on Basescan ↗
            </a>
          )}
        </div>

        {/* country */}
        <div className="set-group">
          <div className="set-glabel">{t("set.country")}</div>
          {COUNTRIES.map((c) => (
            <button key={c.id} className={`set-row ${country.id === c.id ? "sel" : ""}`} onClick={() => pickCountry(c)}>
              <span className="set-flag">{c.flag}</span>
              <span className="set-rt">{c.name}<small>{c.fiat} · {c.symbol} {c.code}</small></span>
              {country.id === c.id && <span className="set-chk">✓</span>}
            </button>
          ))}
        </div>

        {/* language */}
        <div className="set-group">
          <div className="set-glabel">{t("set.language")}</div>
          <div className="lang-row">
            {LANGUAGES.map((l) => (
              <button key={l.code} className={`lang-chip ${lang === l.code ? "sel" : ""}`} onClick={() => pickLang(l.code)}>
                {l.label}
              </button>
            ))}
          </div>
        </div>

        {/* appearance / theme */}
        <div className="set-group">
          <div className="set-glabel">{t("set.appearance")}</div>
          <div className="theme-row" style={{ padding: "4px 0 12px" }}>
            {THEMES.map((opt) => {
              const Ico = opt.Ico;
              return (
                <button key={opt.id} className={`theme-opt ${theme === opt.id ? "sel" : ""}`} onClick={() => setTheme(opt.id)}>
                  <span className="ti"><Ico width="20" height="20" /></span>
                  {t(opt.labelKey)}
                </button>
              );
            })}
          </div>
        </div>

        <button className="btn ghost set-logout" onClick={() => logout().then(() => router.replace("/login"))}>
          {t("set.logout")}
        </button>
        <p className="tiny" style={{ textAlign: "center", color: "var(--muted)", margin: "12px 0 0" }}>
          PayQR v1.0 · Gas-free · Settles in USDC
        </p>
      </div>

      <div className="bottombar">
        <a className="btn" href="/dashboard" style={{ flex: 1, textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
          <Icon.Plus /> {t("common.back")}
        </a>
      </div>
    </>
  );
}
