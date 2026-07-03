import { base, baseSepolia } from "viem/chains";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL;

// Chain selection honors NEXT_PUBLIC_CHAIN ("base" | "baseSepolia") so a mainnet
// cutover is an env change, not a code change. Anything else (or unset) falls
// back to Base Sepolia — the p2p.me protocol's testnet, where this app runs today.
export const ACTIVE_CHAIN =
  process.env.NEXT_PUBLIC_CHAIN === "base" ? base : baseSepolia;
