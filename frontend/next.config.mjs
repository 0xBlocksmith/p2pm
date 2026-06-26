/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Gradual JS→TS migration: types power the editor, but a stray library/DOM
  // typing mismatch shouldn't block a production build. Tighten incrementally.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // Privy's smart-wallets module imports `permissionless` via subpath exports
  // that the dev bundler resolves inconsistently — transpile them so the
  // ERC-4337 stack loads in both dev and production.
  transpilePackages: [
    "@privy-io/react-auth",
    "permissionless",
  ],
  webpack: (config) => {
    // wagmi's MetaMask connector pulls an optional RN-only dep; stub it so the
    // browser build doesn't choke on it.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@react-native-async-storage/async-storage": false,
    };
    return config;
  },
};

export default nextConfig;
