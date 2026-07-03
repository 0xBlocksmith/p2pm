/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The app now typechecks clean (npm run typecheck passes), so let the build
  // ENFORCE types — a future bad thirdweb/viem API call fails the build instead
  // of silently shipping. ESLint is still skipped (no lint config wired up).
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },
  // Tree-shake barrel imports from the heavy wallet/UI deps so a page only pulls
  // the icons/helpers it actually uses instead of the whole package — cuts the
  // dev cold-compile module count and shrinks the production first-load bundle.
  experimental: {
    optimizePackageImports: [
      "thirdweb",
      "wagmi",
      "viem",
      "@tanstack/react-query",
      "qrcode.react",
    ],
  },
  webpack: (config) => {
    // Stub optional deps that transitive wallet libs (wagmi/walletconnect/pino)
    // reference only in code paths this app never hits — so the browser build
    // doesn't emit "Module not found" noise for them.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@react-native-async-storage/async-storage": false,
      // pino (via walletconnect, pulled in by thirdweb) optionally requires
      // pino-pretty for pretty-printing; it's dev-only logging we never use.
      "pino-pretty": false,
    };
    return config;
  },
};

export default nextConfig;
