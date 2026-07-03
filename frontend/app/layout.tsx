import "./globals.css";
import { Plus_Jakarta_Sans } from "next/font/google";
import { Providers } from "./providers";
import { themeInitScript } from "../components/theme";

// Self-hosted via next/font — no external request, no flash. Exposed as a CSS
// variable consumed by `body` in globals.css.
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata = {
  title: "PayQR — Merchant Terminal",
  description: "Accept payments, settle in USDC, get paid in your currency",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "PayQR" },
  icons: { icon: "/icon-192.png", apple: "/icon-192.png" },
  // Modern replacement for the deprecated apple-mobile-web-app-capable meta.
  other: { "mobile-web-app-capable": "yes" },
};

export const viewport = {
  themeColor: "#5b4cf0",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={jakarta.variable} suppressHydrationWarning>
      <head>
        {/* Preload the splash logo so it paints with zero fetch gap, and warm
            the thirdweb/Alchemy connections so wallet init starts sooner. */}
        <link rel="preload" as="image" href="/logo-mark.png" />
        <link rel="preconnect" href="https://c.thirdweb.com" crossOrigin="" />
        <link rel="dns-prefetch" href="https://c.thirdweb.com" />
        <link rel="preconnect" href="https://embedded-wallet.thirdweb.com" crossOrigin="" />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {/* Register the service worker so the app is installable (PWA). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/sw.js').catch(function(){})})}`,
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
