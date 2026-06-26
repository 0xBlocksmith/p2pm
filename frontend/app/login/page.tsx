"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { usePrivy, useLogin } from "@privy-io/react-auth";
import { flagNewUser, clearTourPending, AppTour } from "../../components/AppTour";
import { Logo, Icon } from "../../components/Icons";
import { InstallButton } from "../../components/InstallButton";
import { ThemeButton } from "../../components/ThemeButton";
import { useT } from "../../lib/i18n";
import {
  COUNTRIES, LANGUAGES, loadCountry,
  saveCountry, markPrefsSet, getCountry,
} from "../../lib/countries";

export default function Login() {
  const router = useRouter();
  const { ready, authenticated } = usePrivy();
  const { t, lang, setLang } = useT();
  const [showTour, setShowTour] = useState(false);
  const [country, setCountry] = useState(COUNTRIES[0]);
  const [openMenu, setOpenMenu] = useState<null | "country" | "lang">(null);
  const langLabel = LANGUAGES.find((l) => l.code === lang)?.label || "English";

  // ISO-2 code per country for real flag images (emoji flags don't render on Windows).
  const CC: Record<string, string> = { india: "in", brazil: "br", argentina: "ar" };
  const flagUrl = (id: string) => `https://flagcdn.com/w40/${CC[id] || "un"}.png`;

  // currency + language chosen here are saved before Privy login, so there's
  // no separate /select step — login lands straight on the dashboard.
  const { login } = useLogin({
    onComplete: ({ isNewUser }) => {
      if (isNewUser) flagNewUser();
      else clearTourPending();
      router.replace("/");
    },
  });

  useEffect(() => {
    if (ready && authenticated) router.replace("/");
  }, [ready, authenticated, router]);

  useEffect(() => {
    setCountry(loadCountry());
  }, []);

  // Always show the "how it works" tour when someone lands on the login page —
  // every visit, for every visitor (new or returning), not just first run. Only
  // skip it for an already-authenticated session (they're being redirected to /).
  useEffect(() => {
    if (ready && !authenticated) setShowTour(true);
  }, [ready, authenticated]);

  function onLogin() {
    // persist the picks so the rest of the app is country-aware immediately
    saveCountry(country.id);
    markPrefsSet();
    login();
  }

  return (
    <div className="login-screen">
      <AppTour force={showTour} onClose={() => setShowTour(false)} />

      <div className="login-card">
        {/* top bar: product name + download / theme symbols on the right */}
        <div className="login-bar">
          <div className="login-name">PayQR</div>
          <div className="login-bar-actions">
            <InstallButton variant="icon" />
            <ThemeButton />
          </div>
        </div>
        <h1 className="login-headline">{t("login.headline")}</h1>

        {/* PayQR logo orbited by country pills travelling ON a circle */}
        <div className="orbit-illu">
          {/* the dashed orbit circle */}
          <svg className="orbit-svg" viewBox="0 0 240 240" fill="none" aria-hidden="true">
            <circle className="orbit-arc" cx="120" cy="120" r="92" />
          </svg>

          {/* PayQR logo in the center (no glow) */}
          <div className="orbit-logo">
            <Logo size={84} />
          </div>

          {/* country pills ride ON the circle, evenly spaced, staying upright */}
          {COUNTRIES.map((c, i) => (
            <span key={c.id} className="pmpill"
              style={{ animationDelay: `${-(12 / COUNTRIES.length) * i}s` }}>
              <img className="pm-flag" src={flagUrl(c.id)} alt="" />
              <span className="pm-name">{c.fiat}</span>
            </span>
          ))}
        </div>

        <div className="login-sub">{t("login.selectPrefs")}</div>
        <div className="login-drops">
          {/* currency — custom dropdown */}
          <div className="picker">
            <button className={`picker-btn ${openMenu === "country" ? "on" : ""}`}
              onClick={() => setOpenMenu(openMenu === "country" ? null : "country")}>
              <img className="pk-flag-img" src={flagUrl(country.id)} alt="" />
              <span className="pk-text">{country.symbol} {country.code}</span>
              <span className="pk-car">▾</span>
            </button>
            {openMenu === "country" && (
              <div className="picker-pop">
                {COUNTRIES.map((c) => (
                  <button key={c.id} className={`picker-item ${c.id === country.id ? "sel" : ""}`}
                    onClick={() => { setCountry(c); saveCountry(c.id); setOpenMenu(null); }}>
                    <img className="pk-flag-img" src={flagUrl(c.id)} alt="" />
                    <span className="pk-item-txt">{c.name}<small>{c.fiat} · {c.symbol} {c.code}</small></span>
                    {c.id === country.id && <span className="pk-chk">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* language — custom dropdown */}
          <div className="picker">
            <button className={`picker-btn ${openMenu === "lang" ? "on" : ""}`}
              onClick={() => setOpenMenu(openMenu === "lang" ? null : "lang")}>
              <span className="pk-globe">🌐</span>
              <span className="pk-text">{langLabel}</span>
              <span className="pk-car">▾</span>
            </button>
            {openMenu === "lang" && (
              <div className="picker-pop">
                {LANGUAGES.map((l) => (
                  <button key={l.code} className={`picker-item ${l.code === lang ? "sel" : ""}`}
                    onClick={() => { setLang(l.code as any); setOpenMenu(null); }}>
                    <span className="pk-item-txt">{l.label}</span>
                    {l.code === lang && <span className="pk-chk">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <p className="login-terms">{t("login.terms")} <a>{t("login.termsLink")}</a></p>

        <button className="btn login-btn" disabled={!ready} onClick={onLogin}>
          {ready ? t("login.login") : t("login.loading")}
        </button>
        <button className="login-howto" onClick={() => setShowTour(true)}>
          <Icon.Compass width="15" height="15" /> {t("login.howto")}
        </button>
      </div>
    </div>
  );
}
