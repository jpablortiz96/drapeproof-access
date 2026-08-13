import type { Metadata, Viewport } from "next";
import { AppShell } from "../src/components/product/ui";
import "./globals.css";
import "./product.css";
import { betaModeEnabled } from "@drapeproof/product/production/config";
import { PublicTelemetry } from "../src/components/product/telemetry";

// AppShell supplies the "Skip to main content" link and aria-label="Primary navigation" landmark.

export const metadata: Metadata = {
  metadataBase: new URL(process.env.DRAPEPROOF_PUBLIC_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000")),
  applicationName: "DrapeProof",
  title: { default: "DrapeProof — Careful AI virtual try-on", template: "%s · DrapeProof" },
  description: "Try clothes and accessories with AI, then check the visual changes that matter to you.",
  openGraph: {
    type: "website", siteName: "DrapeProof", title: "DrapeProof — Careful AI virtual try-on",
    description: "Try clothes and accessories with AI, protect the visual details that matter, and review what changed.",
  },
  icons: { icon: "/icon.svg", shortcut: "/icon.svg", apple: "/icon.svg" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, maximumScale: 5, themeColor: "#090B0E" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><AppShell betaMode={betaModeEnabled()}>{children}</AppShell><PublicTelemetry/></body></html>;
}
