import { baseSepolia } from "viem/chains";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL;

// The merchant terminal runs live on Base Sepolia (the p2p.me protocol's testnet).
export const ACTIVE_CHAIN = baseSepolia;
