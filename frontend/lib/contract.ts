import { parseAbi } from "viem";

export const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS as `0x${string}`;
export const CLIENT_ADDRESS = process.env.NEXT_PUBLIC_CLIENT_ADDRESS as `0x${string}`;

// ABI of the NEW multi-currency MerchantTerminalIntegrator (the contract being
// whitelisted). Signatures match the audited contract exactly:
//   • registerMerchant takes the currency CODE as a 3rd arg
//   • getMerchantInfo returns 5 values (currency included)
//   • fiat withdrawal is withdrawFiat / withdrawFiatIn (no INR-pinned names)
//   • deliverFiatPayout is the second-step poke (was deliverInrUpi)
// IMPORTANT: deploy the new contract and point NEXT_PUBLIC_CONTRACT_ADDRESS at
// it BEFORE shipping this frontend — these signatures will revert on the old
// INR-only contract.
export const INTEGRATOR_ABI = parseAbi([
  "function registerMerchant(string payoutId, string shopName, string currencyCode)",
  "function registerMerchantRaw(string payoutId, string shopName, bytes32 currency)",
  "function updateProfile(string payoutId, string shopName)",
  "function registered(address) view returns (bool)",
  "function userPlaceOrder(address client, uint256 productId, uint256 quantity, bytes32 currency, uint256 circleId, string pubKey) returns (uint256)",
  "function withdrawFiat(uint256 amount, uint256 circleId, string pubKey, string payoutOverride) returns (uint256)",
  "function withdrawFiatIn(uint256 amount, uint256 circleId, bytes32 currency, string pubKey) returns (uint256)",
  "function deliverFiatPayout(uint256 orderId, string encPayout)",
  "function reconcileWithdrawal(uint256 orderId)",
  "function withdrawUSDC(uint256 amount)",
  "function getMerchantBalance(address merchant) view returns (uint256 pending, uint256 available, uint256 totalDeposited, bool isFrozen)",
  "function getMerchantInfo(address merchant) view returns (string payoutId, string shopName, bytes32 currency, bool isRegistered, bool isFrozen)",
  "function getMerchantBuckets(address merchant) view returns ((uint256 amount, uint256 unlockTimestamp)[])",
  "function getDailyTxInfo(address merchant) view returns (uint256 usedToday, uint256 limit)",
  "function getMerchantCurrency(address merchant) view returns (string)",
  "function perTxCap(bytes32 currency) view returns (uint256)",
  "function setPerTxCap(bytes32 currency, uint256 cap)",
  "function dailyLimit() view returns (uint256)",
  "function setDailyLimit(uint256 newLimit)",
  "function freezeMerchant(address merchant)",
  "function unfreezeMerchant(address merchant)",
  "function owner() view returns (address)",
  "function admins(address) view returns (bool)",
  "function isAdmin(address who) view returns (bool)",
  // Role-based access control, 5 HIERARCHICAL tiers (0=NONE, 1=VIEWER, 2=SUPPORT,
  // 3=MANAGER, 4=FINANCE): VIEWER=read-only, SUPPORT=+freeze/unfreeze,
  // MANAGER=+caps/limits/relayer, FINANCE=+recover stuck withdrawals. Owner is
  // above all (reads as 4) and is the ONLY one who can assign roles / transfer
  // ownership — gate owner-only UI on owner()==addr, NOT roleOf==4.
  "function adminRole(address) view returns (uint8)",
  "function roleOf(address who) view returns (uint8)",
  "function isManager(address who) view returns (bool)",
  "function isFinance(address who) view returns (bool)",
  "function setRole(address who, uint8 role)",
  "function addAdmin(address who)",
  "function removeAdmin(address who)",
  "function transferOwnership(address newOwner)",
  "function setTrustedRelayer(address relayer)",
  "function adminAbortWithdrawal(uint256 orderId)",
  "function adminForceSettle(uint256 orderId)",
  // Frees the in-flight slot after a SUCCESSFUL (COMPLETED) fiat withdrawal.
  // Distinct from reconcileWithdrawal (which is for CANCELLED orders) — the
  // Cashout widget's reconcile callback must branch on the order status.
  "function finalizeWithdrawal(uint256 orderId)",
  "function proxyAddress(address user) view returns (address)",
  // Public `merchants` struct getter — the dynamic buckets array is omitted, so
  // this returns the scalar fields in order; index 8 is inFlightWithdrawals (the
  // count of unsettled SELL withdrawals — a new fiat withdraw reverts
  // WithdrawalInFlight while this is > 0). Used to warn + offer recovery.
  "function merchants(address) view returns (address merchantAddr, string payoutId, string shopName, bytes32 currency, uint256 totalDeposited, bool isFrozen, uint256 dailyTxCount, uint256 lastTxDate, uint256 inFlightWithdrawals)",
  // proxy => the merchant EOA it was deployed for. Used by the public receipt to
  // resolve a SELL/withdrawal order's placer (a per-merchant proxy) back to the
  // registered merchant. MUST be present or the receipt ownership check throws
  // and fails open for every proxy-placed order.
  "function proxyMerchant(address proxy) view returns (address)",
  "event OrderPlaced(uint256 indexed orderId, address indexed user, uint256 amount)",
  // CRITICAL: CashoutWidget parses the SELL orderId from this event after
  // withdrawFiat — without it in the ABI, decodeEventLog can never match it and
  // every fiat cash-out dies AFTER the funds were committed on-chain.
  "event WithdrawalFiat(address indexed merchant, uint256 indexed orderId, bytes32 currency, uint256 amount)",
  "event WithdrawalUSDC(address indexed merchant, uint256 amount)",
  "event WithdrawalReconciled(address indexed merchant, uint256 indexed orderId, uint256 amount)",
  // Custom ERRORS — every one the contract can revert with. Without these in the
  // ABI, viem can't decode a revert and shows a raw hex signature (e.g. the
  // "0x10cbb591 not found on ABI" = WithdrawalInFlight the user hit). With them,
  // errorName() below maps each to a clear, human message.
  "error AlreadyRegistered()",
  "error DailyLimitReached()",
  "error ExceedsPerTxCap()",
  "error FiatAlreadyDelivered()",
  "error InsufficientAvailableBalance()",
  "error InvalidAddress()",
  "error InvalidCircle()",
  "error InvalidCurrency()",
  "error InvalidQuantity()",
  "error MerchantIsFrozen()",
  "error NotAuthorized(uint8 required, uint8 actual)",
  "error NotRegistered()",
  "error NothingToWithdraw()",
  "error OfframpFeeNotReady()",
  "error OfframpInsufficientPool()",
  "error OnlyDiamond()",
  "error OnlyOwner()",
  "error ProductNotFound()",
  "error Reentrancy()",
  "error TooManyBuckets()",
  "error UnknownWithdrawal()",
  "error WithdrawalAlreadySettled()",
  "error WithdrawalInFlight()",
  "error WithdrawalNotCancellable()",
  "error WithdrawalNotFound()",
]);

// Map a contract revert to a clear, human message. Pass any error thrown by a
// sendTransaction / readContract. Walks viem's error chain to find the decoded
// custom-error name (now that all errors are in the ABI above) and returns a
// friendly sentence — so the merchant never sees a raw "0x… not found on ABI".
const ERROR_MESSAGES: Record<string, string> = {
  WithdrawalInFlight: "You already have a withdrawal in progress. Finish or cancel it before starting a new one.",
  OfframpFeeNotReady: "The payment partner is still finalizing — try again in a moment.",
  OfframpInsufficientPool: "The offramp can't cover the fee right now. Please try again shortly.",
  InsufficientAvailableBalance: "Not enough available balance for this amount (some funds may still be settling).",
  NothingToWithdraw: "There's nothing available to withdraw yet.",
  ExceedsPerTxCap: "That amount is over the per-transaction limit for your currency.",
  DailyLimitReached: "You've reached today's transaction limit. Try again tomorrow.",
  MerchantIsFrozen: "This account is temporarily frozen. Contact support.",
  NotRegistered: "This shop isn't registered yet. Please complete setup first.",
  AlreadyRegistered: "This shop is already registered.",
  InvalidAddress: "A required field (like your payout ID) is missing or invalid.",
  InvalidCurrency: "That currency isn't supported.",
  InvalidCircle: "No live payment route for that currency right now.",
  InvalidQuantity: "Enter a valid amount.",
  ProductNotFound: "Pricing isn't configured — please contact support.",
  FiatAlreadyDelivered: "This payout was already delivered.",
  WithdrawalAlreadySettled: "This withdrawal was already completed.",
  WithdrawalNotCancellable: "This withdrawal can't be cancelled in its current state.",
  WithdrawalNotFound: "That withdrawal wasn't found.",
  UnknownWithdrawal: "That withdrawal wasn't found.",
  NotAuthorized: "You don't have permission to do that.",
  OnlyOwner: "Only the owner can do that.",
  OnlyDiamond: "That action isn't allowed here.",
  TooManyBuckets: "Too many pending settlements — withdraw some funds first.",
  Reentrancy: "Please wait for the previous action to finish.",
};

/** Extract the friendly message for a contract revert, or a sensible fallback. */
export function friendlyError(e: any, fallback = "Something went wrong. Please try again."): string {
  // viem exposes the decoded error name in a few places depending on version.
  let name = "";
  try {
    const walked = typeof e?.walk === "function" ? e.walk() : e;
    name = walked?.data?.errorName || walked?.name || "";
    // shortMessage sometimes contains: reverted with custom error 'X()'
    const msg = String(e?.shortMessage || e?.message || "");
    if (!ERROR_MESSAGES[name]) {
      const m = msg.match(/custom error ['"]?([A-Za-z]+)/);
      if (m) name = m[1];
    }
  } catch { /* ignore */ }
  return ERROR_MESSAGES[name] || fallback;
}

// Fine-grained pricing product: id 2 @ 0.01 USDC/unit, so any INR amount
// maps to a quantity of cents (quantity = usdc * 100).
export const PRODUCT_ID = 2n;
export const UNIT_PRICE_USDC = 0.01;
// Per-transaction cap defaults: India (INR) 50 USDC, every other market 100 USDC.
// NOTE: these are only a LOADING-STATE FALLBACK. The qr terminal reads the LIVE
// perTxCap(currency) from the contract so it always reflects the real cap —
// including any admin setPerTxCap override — without a redeploy. Keep these in
// sync with the contract's PER_TX_CAP_INR / PER_TX_CAP_DEFAULT constants.
export const PER_TX_CAP_USDC = 50;              // kept for compatibility (= INR cap)
export const PER_TX_CAP_INR = 50;
export const PER_TX_CAP_DEFAULT = 100;
export function perTxCapUsdc(currencyCode: string): number {
  return currencyCode === "INR" ? PER_TX_CAP_INR : PER_TX_CAP_DEFAULT;
}
// Default daily order limit — also just a pre-load fallback; the qr page reads the
// live limit via getDailyTxInfo (admin-settable on-chain via setDailyLimit).
export const DAILY_TX_LIMIT = 25;

// ── Admin role tiers (mirror the contract's 5-tier Role enum) ──
// HIERARCHICAL: a higher tier includes every lower tier's powers. The admin panel
// uses these to render/assign roles. Owner is a separate, higher capability that
// roleOf() reports as FINANCE (4, the top tier) for uniform display.
export const ROLE = {
  NONE: 0,
  VIEWER: 1,
  SUPPORT: 2,
  MANAGER: 3,
  FINANCE: 4,
} as const;
export type RoleValue = (typeof ROLE)[keyof typeof ROLE];
export const ROLE_LABEL: Record<number, string> = {
  0: "None",
  1: "Viewer",    // read-only, all views
  2: "Support",   // + freeze / unfreeze
  3: "Manager",   // + caps, daily limit, trusted relayer
  4: "Finance",   // + recover stuck withdrawals (move money)
};
/** What each tier is allowed to do — for the admin panel's role picker. */
export const ROLE_DESC: Record<number, string> = {
  0: "No access",
  1: "Read-only — can view all merchant activity, no changes",
  2: "Everything Viewer can do, plus freeze / unfreeze merchants",
  3: "Everything Support can do, plus set caps, daily limit, and the trusted relayer",
  4: "Everything Manager can do, plus recover stuck withdrawals (adminAbort / adminForceSettle)",
};

// bytes32("INR")
export const INR_BYTES32 =
  "0x494e520000000000000000000000000000000000000000000000000000000000";

export const fmtUsdc = (raw) => (Number(raw) / 1e6).toFixed(2);

// Decode a bytes32 currency (as returned by getMerchantInfo()[2]) back to its
// ISO code string ("INR", "BRL", …). Stops at the first NUL byte. Returns "" for
// empty/zero. Used so the UI can key caps / home-currency off the merchant's
// REGISTERED currency (the value the contract enforces), not a UI selection.
export function currencyFromBytes32(b?: string): string {
  if (!b || typeof b !== "string" || !b.startsWith("0x")) return "";
  let out = "";
  for (let i = 2; i + 1 < b.length; i += 2) {
    const byte = b.slice(i, i + 2);
    if (byte === "00") break;
    out += String.fromCharCode(parseInt(byte, 16));
  }
  return out;
}
