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
  "function registered(address) view returns (bool)",
  "function userPlaceOrder(address client, uint256 productId, uint256 quantity, bytes32 currency, uint256 circleId, string pubKey) returns (uint256)",
  "function withdrawFiat(uint256 amount, uint256 circleId, string payoutOverride) returns (uint256)",
  "function withdrawFiatIn(uint256 amount, uint256 circleId, bytes32 currency, string payoutHandle) returns (uint256)",
  "function deliverFiatPayout(uint256 orderId, string encPayout)",
  "function withdrawUSDC(uint256 amount)",
  "function getMerchantBalance(address merchant) view returns (uint256 pending, uint256 available, uint256 totalDeposited, bool isFrozen)",
  "function getMerchantInfo(address merchant) view returns (string payoutId, string shopName, bytes32 currency, bool isRegistered, bool isFrozen)",
  "function getMerchantBuckets(address merchant) view returns ((uint256 amount, uint256 unlockTimestamp)[])",
  "function getDailyTxInfo(address merchant) view returns (uint256 usedToday, uint256 limit)",
  "function getMerchantCurrency(address merchant) view returns (string)",
  "function proxyAddress(address user) view returns (address)",
  "event OrderPlaced(uint256 indexed orderId, address indexed user, uint256 amount)",
]);

// Fine-grained pricing product: id 2 @ 0.01 USDC/unit, so any INR amount
// maps to a quantity of cents (quantity = usdc * 100).
export const PRODUCT_ID = 2n;
export const UNIT_PRICE_USDC = 0.01;
export const PER_TX_CAP_USDC = 50;

// bytes32("INR")
export const INR_BYTES32 =
  "0x494e520000000000000000000000000000000000000000000000000000000000";

export const fmtUsdc = (raw) => (Number(raw) / 1e6).toFixed(2);
