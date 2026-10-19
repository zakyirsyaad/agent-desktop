import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The repository root: the site imports the agent logos from the app's src/assets.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const nextConfig: NextConfig = {
  // A static site: `next build` writes plain HTML, CSS and assets to out/.
  output: "export",
  images: { unoptimized: true },
  reactStrictMode: true,
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
