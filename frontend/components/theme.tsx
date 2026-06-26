"use client";

import { useEffect, useState, createContext, useContext } from "react";

const KEY = "payqr.theme"; // "light" | "dark" | "system"
// Dark is the default look (matches the p2p.me app). A user's explicit
// light/system choice is saved to localStorage and still wins.
const DEFAULT = "dark";

type ThemeValue = {
  theme: string;
  resolved: string;
  setTheme: (t: string) => void;
};
const ThemeCtx = createContext<ThemeValue>({
  theme: DEFAULT,
  resolved: "dark",
  setTheme: () => {},
});

function systemPrefersDark() {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

function apply(resolved) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", resolved);
}

/** Inline script (runs before paint) to set the theme and avoid a flash. */
export const themeInitScript = `
(function(){try{
  var t = localStorage.getItem('${KEY}') || '${DEFAULT}';
  var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}catch(e){}})();
`;

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(DEFAULT);
  const [resolved, setResolved] = useState("dark");

  // Load saved preference on mount.
  useEffect(() => {
    let saved = DEFAULT;
    try { saved = localStorage.getItem(KEY) || DEFAULT; } catch {}
    setThemeState(saved);
  }, []);

  // Resolve + apply whenever theme (or system pref) changes.
  useEffect(() => {
    const compute = () => {
      const r = theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
      setResolved(r);
      apply(r);
    };
    compute();
    if (theme === "system" && window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener?.("change", compute);
      return () => mq.removeEventListener?.("change", compute);
    }
  }, [theme]);

  function setTheme(t) {
    setThemeState(t);
    try { localStorage.setItem(KEY, t); } catch {}
  }

  return (
    <ThemeCtx.Provider value={{ theme, resolved, setTheme }}>
      {children}
    </ThemeCtx.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeCtx);
}
