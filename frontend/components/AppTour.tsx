"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icons";

/**
 * First-run guided tour. A dimmed overlay with an illustrated card per step —
 * each step shows a small preview of that part of the app, not just text.
 * Auto-runs once (localStorage flag); reopened via the "How it works" pill.
 */

// ── Per-step mini illustrations (small, real-looking app previews) ──
function ArtWelcome() {
  return (
    <div className="tour-art welcome">
      <div className="ta-mark">P</div>
      <div className="ta-coin"><Icon.Wallet width="22" height="22" /></div>
      <div className="ta-ping" />
    </div>
  );
}
function ArtAccept() {
  return (
    <div className="tour-art">
      <div className="ta-amount">₹250</div>
      <div className="ta-keys">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => <span key={k}>{k}</span>)}
      </div>
      <div className="ta-cta"><Icon.Qr width="14" height="14" /> Accept Payment</div>
    </div>
  );
}
function ArtMoney() {
  return (
    <div className="tour-art">
      <div className="ta-pill">Today’s earnings · ₹4,250</div>
      <div className="ta-bal-label">You received (USDC)</div>
      <div className="ta-bal">$1,240</div>
      <div className="ta-row"><span className="ta-dot in" /> + $24.50 <span className="ta-ago">2 min</span></div>
    </div>
  );
}
function ArtActivity() {
  return (
    <div className="tour-art">
      <div className="ta-filters"><span className="on">All</span><span>Sales</span><span>Settled</span></div>
      {[["+$24.50", "settled", "in"], ["+$50.00", "settling", "in"], ["−$100", "to bank", "out"]].map(([a, s, d], i) => (
        <div className="ta-row" key={i}>
          <span className={`ta-dot ${d}`} /> {a}
          <span className="ta-badge">{s}</span>
        </div>
      ))}
    </div>
  );
}
function ArtWithdraw() {
  return (
    <div className="tour-art">
      <div className="ta-bal-label">Ready to withdraw</div>
      <div className="ta-bal">$1,116</div>
      <div className="ta-opt sel"><Icon.Bank width="16" height="16" /> My bank <span className="ta-chk">✓</span></div>
      <div className="ta-opt"><Icon.Wallet width="16" height="16" /> Keep as USDC</div>
    </div>
  );
}

const STEPS = [
  { art: ArtWelcome, title: "Welcome to PayQR", text: "Take payments from anyone and get paid in USDC. Here's how it works — 4 quick steps." },
  { art: ArtAccept, title: "Accept a payment", text: "Tap Accept Payment, type the amount, and show the QR. The customer pays — you receive USDC instantly." },
  { art: ArtMoney, title: "See your money", text: "Your balance shows what you've received. “Today's earnings” tracks the day, and recent payments show below." },
  { art: ArtActivity, title: "Track activity", text: "Every payment is on-chain. Filter, search, and export your full history anytime." },
  { art: ArtWithdraw, title: "Withdraw anytime", text: "Cash out to your bank in your local currency, or keep it as USDC. That's it — you're ready!" },
];

const KEY = "payqr.tourDone";
const NEW_KEY = "payqr.tourPending"; // set at login for a first-time device

export function tourSeen() {
  if (typeof window === "undefined") return true;
  try { return localStorage.getItem(KEY) === "1"; } catch { return true; }
}

/** Called from login for a first-time device — force the tour to show
 *  again even if this device saw it before (it's a different person). */
export function flagNewUser() {
  try { localStorage.setItem(NEW_KEY, "1"); localStorage.removeItem(KEY); } catch {}
}
/** Returning user: don't force a re-show, but if they never finished the
 *  tour on this device it can still appear. */
export function clearTourPending() {
  try { localStorage.setItem(NEW_KEY, "0"); } catch {}
}

export function AppTour({ force = false, onClose }) {
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);

  useEffect(() => {
    if (force) { setOpen(true); setI(0); return; }
    // Auto-open for anyone who hasn't completed the tour yet on this device —
    // this covers first-time users (flagged at login) and any fresh login
    // where the tour was never finished. Once finished, it won't show again.
    if (!tourSeen()) { setOpen(true); setI(0); }
  }, [force]);

  function finish() {
    try {
      localStorage.setItem(KEY, "1");
      localStorage.setItem(NEW_KEY, "0"); // consume the pending flag
    } catch {}
    setOpen(false);
    onClose?.();
  }

  if (!open) return null;
  const step = STEPS[i];
  const Art = step.art;
  const last = i === STEPS.length - 1;

  return (
    <div className="tour-overlay" role="dialog" aria-modal="true">
      <div className="tour-card">
        <button className="tour-x" onClick={finish} aria-label="Close">✕</button>

        {/* illustrated preview */}
        <div className="tour-stage" key={i}>
          <Art />
        </div>

        <div className="tour-body">
          <div className="tour-num">{i === 0 ? "GET STARTED" : `STEP ${i} / ${STEPS.length - 1}`}</div>
          <div className="tour-title">{step.title}</div>
          <div className="tour-text">{step.text}</div>
        </div>

        <div className="tour-foot">
          <div className="tour-dots">
            {STEPS.map((_, k) => <i key={k} className={k === i ? "on" : ""} />)}
          </div>
          <div className="tour-btns">
            {i > 0 && <button className="tour-skip" onClick={() => setI(i - 1)}>Back</button>}
            <button className="tour-next" onClick={() => (last ? finish() : setI(i + 1))}>
              {last ? "Get started" : "Next ›"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
