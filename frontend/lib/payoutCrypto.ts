import { stringToHex, hexToString, type Hex } from "viem";

/**
 * Client-side encryption for the merchant's PAYOUT HANDLE (UPI / PIX / CBU).
 *
 * WHY: the on-chain contract stores the handle as an opaque `bytes` blob and
 * never sees the plaintext — the raw handle must never be public on-chain (it's
 * real-world financial PII: anyone could map a merchant wallet → their bank id).
 * So we encrypt it IN THE BROWSER before it ever goes on-chain, and decrypt it
 * back in the browser for display. There is no backend — the ciphertext lives on
 * the chain, the key lives in the merchant's own relay identity.
 *
 * KEY: the merchant's own relay identity (see components/useRelayIdentity.ts) —
 * a per-address keypair persisted in localStorage. We encrypt the handle TO the
 * merchant's own relay pubkey (self-recipient), so only they can read it back.
 * The SDK's ECIES (`encryptPaymentAddress`/`decryptPaymentAddress`, secp256k1 +
 * AES-GCM) is the same vetted crypto the SELL/payout flow uses.
 *
 * WIRE FORMAT: `encryptPaymentAddress` yields a compact hex CIPHER STRING
 * (cipherStringify). We store it on-chain as UTF-8 `bytes` (stringToHex) so ANY
 * cipher string round-trips exactly; on read we hexToString back to the cipher
 * string before decrypting. (This is the same cipherStringify text the widget's
 * deliverFiatPayout submits — we just persist a self-encrypted copy for display.)
 *
 * CROSS-DEVICE CAVEAT: the relay identity is per-device localStorage (wiped on
 * logout). On a fresh device the merchant gets a NEW relay key, so a handle
 * encrypted with the OLD key can't be decrypted there — `decryptPayout` returns
 * null and the UI shows a neutral "saved" label instead of garbage. The merchant
 * can always re-enter the handle (updateProfile re-encrypts to the new key). No
 * funds are ever at risk — this value is display/pre-fill convenience only; the
 * actual payout is collected fresh by the Cashout widget at withdraw time.
 */

type RelayIdentity = { address: `0x${string}`; publicKey: string; privateKey: `0x${string}` };

/** Encrypt a plaintext payout handle to the merchant's own relay key → on-chain
 *  `bytes` (0x-hex). Throws only on a genuine crypto failure (caller handles). */
export async function encryptPayout(plain: string, identity: RelayIdentity): Promise<Hex> {
  const { encryptPaymentAddress } = await import("@p2pdotme/sdk/orders");
  const res = await encryptPaymentAddress({
    paymentAddress: plain,
    recipientPublicKey: identity.publicKey, // self-recipient: only the merchant can read it
    senderIdentity: identity,
  });
  // neverthrow ResultAsync — unwrap explicitly.
  if (!res.isOk()) {
    throw new Error("Could not secure your payout ID. Please try again.");
  }
  // Persist the cipher STRING as UTF-8 bytes so it round-trips exactly.
  return stringToHex(res.value);
}

/** Decrypt an on-chain `bytes` payout blob back to plaintext, or null if it
 *  can't be decrypted on this device (different/absent relay key) or is empty.
 *  Never throws — display code treats null as "no readable handle". */
export async function decryptPayout(
  onchain: Hex | string | undefined,
  identity: RelayIdentity | null | undefined
): Promise<string | null> {
  if (!onchain || onchain === "0x" || !identity) return null;
  try {
    const cipherStr = hexToString(onchain as Hex); // bytes → cipher string
    if (!cipherStr) return null;
    const { decryptPaymentAddress } = await import("@p2pdotme/sdk/orders");
    const res = await decryptPaymentAddress({ encrypted: cipherStr, recipientIdentity: identity });
    return res.isOk() ? res.value : null;
  } catch {
    return null;
  }
}
