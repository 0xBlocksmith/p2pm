"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "./useAuth";
import { clearLocalUserData } from "../lib/countries";
import { Logo, Icon } from "./Icons";
import { useT } from "../lib/i18n";

/**
 * p2p.me-style slide-out side menu, opened by the nav hamburger. Lists the
 * merchant's app sections + account info + version, mirroring the reference
 * app's left drawer.
 */
export function SideMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { logout, email } = useAuth();
  const { t } = useT();

  const items = [
    { href: "/transactions", label: t("nav.transactions"), Ico: Icon.Repeat },
    { href: "/withdraw", label: t("nav.withdraw"), Ico: Icon.Up },
    { href: "mailto:support@payqr.app", label: t("nav.help"), Ico: Icon.Headset, ext: true },
    { href: "/settings", label: t("nav.settings"), Ico: Icon.Gear },
  ];

  if (!open) return null;
  return (
    <div className="sm-overlay" onClick={onClose}>
      <aside className="sm-panel" onClick={(e) => e.stopPropagation()}>
        <div className="sm-head">
          <div className="brand"><Logo size={26} className="brand-mark" /> PayQR</div>
          <button className="sm-close" onClick={onClose} aria-label="Close"><Icon.Back /></button>
        </div>

        <nav className="sm-list">
          {items.map((it) =>
            it.ext ? (
              <a key={it.label} className="sm-row" href={it.href} onClick={onClose}>
                <span className="sm-ico"><it.Ico /></span><span>{it.label}</span>
                <span className="sm-arrow">›</span>
              </a>
            ) : (
              <Link key={it.label} className="sm-row" href={it.href} onClick={onClose}>
                <span className="sm-ico"><it.Ico /></span><span>{it.label}</span>
                <span className="sm-arrow">›</span>
              </Link>
            )
          )}
        </nav>

        {email && (
          <div className="sm-account">
            <span className="sm-acct-avatar">{email.slice(0, 1).toUpperCase()}</span>
            <div className="sm-acct-txt">
              <div className="sm-acct-label">{t("nav.loggedInAs")}</div>
              <div className="sm-acct-email">{email}</div>
            </div>
          </div>
        )}

        <button className="sm-logout" onClick={() => { onClose(); clearLocalUserData(); logout().finally(() => router.replace("/login")); }}>
          <Icon.Back /> {t("nav.logout")}
        </button>

        <div className="sm-foot">PayQR v1.0 · Settles in USDC</div>
      </aside>
    </div>
  );
}
