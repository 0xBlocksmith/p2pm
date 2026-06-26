/**
 * Country / currency config — the single source of truth for multi-country UI.
 *
 * Adding a new country later = add one entry here (and make sure its circle has
 * a p2p seller). The contract already accepts any currency as a parameter on the
 * order side; the withdraw side reads `code` once the `withdrawFiat` change ships.
 */
import type { Country, Language } from "./types";

export const COUNTRIES: Country[] = [
  {
    id: "india",
    flag: "🇮🇳",
    name: "India",
    code: "INR",
    symbol: "₹",
    fiat: "UPI",
    payoutLabel: "UPI ID",
    payoutPlaceholder: "name@upi",
    validatePayout: (v) => v.includes("@"),
    locale: "en-IN",
  },
  {
    id: "brazil",
    flag: "🇧🇷",
    name: "Brazil",
    code: "BRL",
    symbol: "R$",
    fiat: "PIX",
    payoutLabel: "PIX key",
    payoutPlaceholder: "pix@key.br / CPF / phone",
    validatePayout: (v) => v.trim().length >= 3,
    locale: "pt-BR",
  },
  {
    id: "argentina",
    flag: "🇦🇷",
    name: "Argentina",
    code: "ARS",
    symbol: "$",
    fiat: "Transfers 3.0",
    payoutLabel: "CBU / alias",
    payoutPlaceholder: "alias.mp / CBU",
    validatePayout: (v) => v.trim().length >= 3,
    locale: "es-AR",
  },
];

export const DEFAULT_COUNTRY: Country = COUNTRIES[0];

export function getCountry(id: string | null | undefined): Country {
  return COUNTRIES.find((c) => c.id === id) || DEFAULT_COUNTRY;
}

const KEY = "payqr.country";
const LANG_KEY = "payqr.lang";
const DONE_KEY = "payqr.prefsSet";

export const LANGUAGES: Language[] = [
  { code: "en", label: "English" },
  { code: "hi", label: "हिन्दी" },
  { code: "pt", label: "Português" },
  { code: "es", label: "Español" },
];

/** Read the merchant's chosen country (UI preference, localStorage). */
export function loadCountry(): Country {
  if (typeof window === "undefined") return DEFAULT_COUNTRY;
  try {
    return getCountry(localStorage.getItem(KEY));
  } catch {
    return DEFAULT_COUNTRY;
  }
}

export function saveCountry(id: string): void {
  try { localStorage.setItem(KEY, id); } catch {}
}

export function loadLang(): string {
  if (typeof window === "undefined") return "en";
  try {
    return localStorage.getItem(LANG_KEY) || "en";
  } catch {
    return "en";
  }
}
export function saveLang(code: string): void {
  try { localStorage.setItem(LANG_KEY, code); } catch {}
}

/** Has the merchant completed the country+language step? */
export function prefsSet(): boolean {
  if (typeof window === "undefined") return false;
  try { return localStorage.getItem(DONE_KEY) === "1"; } catch { return false; }
}
export function markPrefsSet(): void {
  try { localStorage.setItem(DONE_KEY, "1"); } catch {}
}

/** Format a fiat amount with the country's symbol + locale grouping. */
export function fmtFiat(
  country: Country,
  amount: number | string,
  opts: { decimals?: number } = {}
): string {
  const { decimals = 0 } = opts;
  const n = Number(amount) || 0;
  const grouped = n.toLocaleString(country.locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${country.symbol}${grouped}`;
}
