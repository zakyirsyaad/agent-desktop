import appPackage from "../../package.json";
import { LINKS } from "./links";

export const SITE_NAME = "Zorvo";
export const SITE_TITLE = "Zorvo — every coding agent, one desktop";
export const SITE_DESCRIPTION =
  "Claude Code, Codex, Qwen and Aider in one native app. Bring the agent you already use. No lock-in, no API keys.";

const LOCAL_URL = "http://localhost:3100/";

// A trailing slash keeps a sub-path (https://example.github.io/zorvo/) when relative URLs resolve against it.
const withTrailingSlash = (href: string) => (href.endsWith("/") ? href : `${href}/`);

/**
 * The address the site is served from, for canonical links, the sitemap and
 * Open Graph URLs. SITE_URL wins; on Vercel the production domain is used, so
 * adding a custom domain there moves these with it. A production build with
 * neither fails rather than publish localhost links; dev and tests use the
 * local preview port.
 */
export function siteUrl(env: Record<string, string | undefined> = process.env): URL {
  if (env.SITE_URL) return new URL(withTrailingSlash(env.SITE_URL));
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return new URL(`https://${env.VERCEL_PROJECT_PRODUCTION_URL}/`);
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Set SITE_URL to the address the site is served from, e.g. SITE_URL=https://zorvo.xyz (on Vercel it comes from the production domain).",
    );
  }
  return new URL(LOCAL_URL);
}

/** schema.org data for search engines: a free macOS developer app. */
export function softwareApplication(url: URL = siteUrl()) {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    description: SITE_DESCRIPTION,
    url: url.href,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS",
    softwareVersion: appPackage.version,
    downloadUrl: LINKS.releases,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };
}
