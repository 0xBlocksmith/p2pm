// Shared domain types for the PayQR frontend.

export interface Country {
  id: string;
  flag: string;
  name: string;
  code: string;          // ISO-4217-style currency code, e.g. "INR"
  symbol: string;
  fiat: string;          // payout rail label, e.g. "UPI"
  payoutLabel: string;
  payoutPlaceholder: string;
  validatePayout: (v: string) => boolean;
  locale: string;
}

export interface Language {
  code: string;
  label: string;
}

export type ThemeChoice = "light" | "dark" | "system";

export interface UsdcRate {
  rate: number;
  source: string;
  at: number;
}

// A normalized transaction row (from the subgraph).
export interface HistoryRow {
  orderId: string;
  amount: string;        // raw 6-decimal USDC
  status: "matching" | "settled" | "cancelled";
  txHash: string | null;
  createdAt: string;     // ISO
  placedAt: number;
  completedAt: number | null;
}
