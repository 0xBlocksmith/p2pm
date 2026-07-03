/**
 * Branded full-screen splash shown while the app initializes (thirdweb wallet
 * init, prefs read, first route). Replaces the bare "Loading…" text so the wait looks
 * intentional and on-brand — important on iOS where a blank flash reads as slow.
 *
 * Pure markup + CSS (logo image), no JS/state, so it paints as early as
 * possible. The theme-init inline script in layout has already set the
 * background color before this renders, so there's no white flash either.
 */
export function Splash() {
  return (
    <div className="splash" role="status" aria-label="Loading PayQR">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="splash-logo" src="/logo-mark.png" alt="PayQR" width={130} height={130} />
      <div className="splash-dots"><i /><i /><i /></div>
    </div>
  );
}
