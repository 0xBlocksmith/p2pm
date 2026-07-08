"use client";

/**
 * Global "update available" toast. Renders nothing until a new service worker
 * is waiting (see AppUpdate.tsx); then slides up a small bar on ANY screen
 * offering to refresh onto the new version. Dismissible for the session (the
 * banner reappears on the next check if it's still pending) — the update also
 * applies on its own at the next cold start, so dismissing only defers it.
 */
import { useState } from "react";
import { useAppUpdate } from "./AppUpdate";
import { Icon } from "./Icons";
import { useT } from "../lib/i18n";

export function UpdateBanner() {
  const { updateReady, applyUpdate } = useAppUpdate();
  const { t } = useT();
  const [dismissed, setDismissed] = useState(false);
  const [applying, setApplying] = useState(false);

  if (!updateReady || dismissed) return null;

  return (
    <div className="ota-banner" role="status" aria-live="polite">
      <span className="ota-ico"><Icon.Repeat width="18" height="18" /></span>
      <span className="ota-txt">{t("ota.available")}</span>
      <button
        className="ota-refresh"
        disabled={applying}
        onClick={() => { setApplying(true); applyUpdate(); }}
      >
        {applying ? t("ota.updating") : t("ota.refresh")}
      </button>
      <button className="ota-close" aria-label={t("ota.later")} onClick={() => setDismissed(true)}>
        <Icon.Close />
      </button>
    </div>
  );
}
