"use client";

/**
 * Lazily creates + persists the p2p relay identity (the user pubkey used to
 * encrypt UPI details) per browser, via @p2pdotme/sdk/orders. Returns a
 * getIdentity() that the placeOrder callback calls to obtain { publicKey }.
 */
export function useRelayIdentity() {
  async function getIdentity() {
    const { createLocalStorageRelayStore, createRelayIdentity } = await import(
      "@p2pdotme/sdk/orders"
    );
    const store = createLocalStorageRelayStore();
    let identity = await store.get();
    if (!identity) {
      identity = createRelayIdentity();
      await store.set(identity);
    }
    return identity;
  }

  return { getIdentity };
}
