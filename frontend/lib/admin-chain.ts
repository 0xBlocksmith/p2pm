import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ACTIVE_CHAIN, RPC_URL } from "./chain";
import { CONTRACT_ADDRESS, INTEGRATOR_ABI } from "./contract";
import { isAdminMockEnabled, mockFreezeAction } from "./admin-mock";

export function getAdminWalletClient() {
  const key = process.env.ADMIN_PRIVATE_KEY;
  if (!key) throw new Error("ADMIN_PRIVATE_KEY not configured");
  const account = privateKeyToAccount(
    (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`
  );
  return createWalletClient({
    account,
    chain: ACTIVE_CHAIN,
    transport: http(RPC_URL),
  }).extend(publicActions);
}

export async function adminFreezeAction(
  merchant: `0x${string}`,
  action: "freeze" | "unfreeze"
) {
  if (isAdminMockEnabled()) return mockFreezeAction(merchant, action);

  const fn = action === "freeze" ? "freezeMerchant" : "unfreezeMerchant";
  const client = getAdminWalletClient();
  const hash = await client.writeContract({
    account: client.account!,
    address: CONTRACT_ADDRESS,
    abi: INTEGRATOR_ABI,
    functionName: fn,
    args: [merchant],
    chain: ACTIVE_CHAIN,
  });
  await client.waitForTransactionReceipt({ hash });
  return hash;
}
