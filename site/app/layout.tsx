import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
// Self-hosted, the same packages the app ships: the page loads nothing from a font CDN.
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/geist-mono";
import "./globals.css";

const TITLE = "Zorvo — every coding agent, one desktop";
const DESCRIPTION =
  "Claude Code, Codex, Qwen and every agent in the ACP registry in one native app. Bring the agent you already use. No lock-in, no API keys.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: "website", siteName: "Zorvo" },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0b" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col">{children}</body>
    </html>
  );
}
