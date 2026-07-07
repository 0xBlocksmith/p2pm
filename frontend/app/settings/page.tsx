"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../components/useAuth";
import { useReadContract, usePublicClient } from "wagmi";
import { encodeFunctionData } from "viem";
import { Nav } from "../../components/Nav";
import { useMerchant } from "../../components/useMerchant";
import { useSmartAccount } from "../../components/useSmartAccount";
import { useRelayIdentity } from "../../components/useRelayIdentity";
import { Icon } from "../../components/Icons";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI } from "../../lib/contract";
import { encryptPayout, decryptPayout } from "../../lib/payoutCrypto";
import {
  COUNTRIES, LANGUAGES, loadCountry, loadLang, saveCountry, saveLang, clearLocalUserData,
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
  const { logout, email } = useAuth();
  useMerchant(); // page guard (auth + prefs)
  const { address, sendTransaction } = useSmartAccount(); // same source the account menu uses
  const { getIdentity } = useRelayIdentity();
  const publicClient = usePublicClient();
  const { theme, setTheme } = useTheme();
  const { t, lang, setLang } = useT();
  const [country, setCountry] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => { setCountry(loadCountry()); }, []);

  const { data: info, refetch: refetchInfo } = useReadContract({
    address: CONTRACT_ADDRESS, abi: INTEGRATOR_ABI, functionName: "getMerchantInfo",
    args: [address], query: { enabled: !!address },
  });
  const encPayout = info?.[0] || "";   // on-chain ciphertext blob (bytes)
  const shopName = info?.[1] || "";

  // Decrypt the payout handle for display (client-side, with the merchant's own
  // relay key). null when it can't be decrypted on this device (a different relay
  // key, e.g. after logout/new device) — we then show a neutral "saved" label.
  const [payoutId, setPayoutId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!encPayout || encPayout === "0x") { if (alive) setPayoutId(null); return; }
      try {
        const id = await getIdentity();
        const plain = await decryptPayout(encPayout as string, id);
        if (alive) setPayoutId(plain);
      } catch { if (alive) setPayoutId(null); }
    })();
    return () => { alive = false; };
  }, [encPayout, getIdentity]);

  // ── Edit profile (shop name + payout handle) via updateProfile ──
  const [editing, setEditing] = useState(false);
  const [edShop, setEdShop] = useState("");
  const [edPayout, setEdPayout] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileMsg, setProfileMsg] = useState("");

  function startEdit() {
    setEdShop(shopName); setEdPayout(payoutId || ""); setProfileMsg(""); setEditing(true);
  }
  async function saveProfile() {
    setProfileMsg("");
    if (!edShop.trim()) return setProfileMsg("Enter a shop name.");
    if (!edPayout.trim()) return setProfileMsg(`Enter your ${country.payoutLabel}.`);
    if (country.validatePayout && !country.validatePayout(edPayout.trim())) {
      return setProfileMsg(`Enter a valid ${country.payoutLabel} (like ${country.payoutPlaceholder}).`);
    }
    if (!sendTransaction) return setProfileMsg("Wallet still connecting — try again in a moment.");
    setSavingProfile(true);
    try {
      // Encrypt the new handle client-side before it goes on-chain (PII).
      const identity = await getIdentity();
      const encNew = await encryptPayout(edPayout.trim(), identity);
      const data = encodeFunctionData({
        abi: INTEGRATOR_ABI, functionName: "updateProfile",
        args: [encNew, edShop.trim()],
      });
      const hash = await sendTransaction({ to: CONTRACT_ADDRESS, data });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "reverted") throw new Error("Couldn't save — the change was rejected on-chain.");
      setProfileMsg("Saved ✓"); setEditing(false); refetchInfo();
    } catch (err) {
      setProfileMsg(err?.shortMessage || err?.message || "Couldn't save. Try again.");
    } finally { setSavingProfile(false); }
  }

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

        {/* shop details (on-chain) — editable */}
        <div className="set-group">
          <div className="set-glabel" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{t("set.shop")}</span>
            {!editing && (
              <button className="set-link" style={{ padding: 0 }} onClick={startEdit}>Edit</button>
            )}
          </div>

          {editing ? (
            <>
              <label className="set-k" style={{ display: "block", marginTop: 6 }}>{t("set.shopName")}</label>
              <input className="input" value={edShop} onChange={(e) => setEdShop(e.target.value)}
                placeholder="Your shop name" />
              <label className="set-k" style={{ display: "block", marginTop: 10 }}>{country.payoutLabel}</label>
              <input className="input" value={edPayout} onChange={(e) => setEdPayout(e.target.value)}
                placeholder={country.payoutPlaceholder} />
              <p className="tiny" style={{ color: "var(--muted)", margin: "8px 0 0" }}>
                Currency ({country.code}) can't be changed after registration.
              </p>
              {profileMsg && <p className={profileMsg.includes("✓") ? "success" : "error"} style={{ marginTop: 6 }}>{profileMsg}</p>}
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <button className="btn" style={{ flex: 1 }} disabled={savingProfile} onClick={saveProfile}>
                  {savingProfile ? "Saving…" : "Save"}
                </button>
                <button className="btn ghost" style={{ flex: 1 }} disabled={savingProfile}
                  onClick={() => { setEditing(false); setProfileMsg(""); }}>Cancel</button>
              </div>
            </>
          ) : (
            <>
          <div className="set-item">
            <span className="set-k">{t("set.shopName")}</span>
            <span className="set-v">{shopName || "—"}</span>
          </div>
          <div className="set-item">
            <span className="set-k">{country.payoutLabel}</span>
            {/* payoutId is decrypted client-side. null + a saved blob = "on file"
                but not decryptable on this device (different relay key); null + no
                blob = none set. */}
            <span className="set-v">
              {payoutId || (encPayout && encPayout !== "0x" ? "•••• (saved)" : "—")}
            </span>
          </div>
            </>
          )}

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

        <button
          className="btn ghost set-logout"
          onClick={() => {
            // Wipe per-merchant local state BEFORE leaving so nothing leaks to the
            // next account on a shared device (relay key, pending sale, prefs).
            clearLocalUserData();
            logout().finally(() => router.replace("/login"));
          }}
        >
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
