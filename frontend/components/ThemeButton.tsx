"use client";

import { useTheme } from "./theme";
import { Icon } from "./Icons";

/** Icon-only theme toggle (sun/moon) for the top bar. */
export function ThemeButton() {
  const { resolved, setTheme } = useTheme();
  const dark = resolved === "dark";
  return (
    <button
      className="theme-btn"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light mode" : "Dark mode"}
    >
      {dark ? <Icon.Sun /> : <Icon.Moon />}
    </button>
  );
}
