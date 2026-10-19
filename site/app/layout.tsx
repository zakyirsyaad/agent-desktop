import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
// Self-hosted, the same packages the app ships: the page loads nothing from a font CDN.
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/geist-mono";
import "./globals.css";
import { SITE_DESCRIPTION, SITE_NAME, SITE_TITLE, siteUrl } from "../lib/site";

// app/opengraph-image.tsx adds og:image and twitter:image to these.
export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: { canonical: "/" },
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    type: "website",
    siteName: SITE_NAME,
    url: "/",
    locale: "en_US",
  },
  twitter: { card: "summary_large_image", title: SITE_TITLE, description: SITE_DESCRIPTION },
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
