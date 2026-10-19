import appPackage from "../../package.json";
import { LINKS } from "./links";

export const SITE_NAME = "Zorvo";
export const SITE_TITLE = "Zorvo — every coding agent, one desktop";
export const SITE_DESCRIPTION =
  "Claude Code, Codex, Qwen and Aider in one native app. Bring the agent you already use. No lock-in, no API keys.";

/**
 * The address the site is served from, for canonical links, the sitemap and
 * Open Graph URLs. SITE_URL wins; on Vercel the production domain is used, so
 * adding a custom domain there moves these with it; locally, the preview port.
 */
export function siteUrl(env: Record<string, string | undefined> = process.env): URL {
  if (env.SITE_URL) return new URL(env.SITE_URL);
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return new URL(`https://${env.VERCEL_PROJECT_PRODUCTION_URL}`);
  return new URL("http://localhost:3100");
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
