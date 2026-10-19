// Refreshes src-tauri/resources/runtimes.json: the Node.js and uv builds Zorvo downloads.
//
//   pnpm runtimes:update
//
// Picks the newest Node.js LTS and uv release that are at least seven days old, takes
// each archive's SHA-256 from the publisher's checksum file, then downloads the archive
// and checks it against that hash. Exits non-zero on any mismatch or missing file.
// Needs network (nodejs.org, api.github.com, github.com).
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseShasums, pickNodeRelease, pickUvRelease } from "./runtimes.mjs";

const OUT_PATH = fileURLToPath(new URL("../src-tauri/resources/runtimes.json", import.meta.url));
const TIMEOUT_MS = 10 * 60_000;

const get = async (url, headers = {}) => {
  const response = await fetch(url, { headers: { "user-agent": "zorvo-runtimes-update", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response;
};

/** Downloads `url`, throws unless its SHA-256 is `expected`, returns its size in bytes. */
const verifiedSize = async (url, expected) => {
  const bytes = Buffer.from(await (await get(url)).arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${url}: expected ${expected}, got ${actual}`);
  return bytes.length;
};

const NODE_ARCHS = { "darwin-aarch64": "arm64", "darwin-x86_64": "x64" };
const UV_ARCHS = { "darwin-aarch64": "aarch64", "darwin-x86_64": "x86_64" };

const nodeTarget = async (release, shasums, arch) => {
  const dir = `node-v${release.version}-darwin-${arch}`;
  const file = `${dir}.tar.gz`;
  const sha256 = parseShasums(shasums, file);
  if (!sha256) throw new Error(`SHASUMS256.txt has no entry for ${file}`);
  const url = `https://nodejs.org/dist/v${release.version}/${file}`;
  return { url, sha256, size: await verifiedSize(url, sha256), bin: `${dir}/bin` };
};

const uvTarget = async (release, arch) => {
  const dir = `uv-${arch}-apple-darwin`;
  const url = `https://github.com/astral-sh/uv/releases/download/${release.version}/${dir}.tar.gz`;
  const sha256 = parseShasums(`${(await (await get(`${url}.sha256`)).text()).trim().split(/\s+/)[0]}  ${dir}.tar.gz`, `${dir}.tar.gz`);
  if (!sha256) throw new Error(`${url}.sha256 holds no SHA-256`);
  return { url, sha256, size: await verifiedSize(url, sha256), bin: dir };
};

const targetsFor = async (archs, make) => {
  const entries = await Promise.all(Object.entries(archs).map(async ([key, arch]) => [key, await make(arch)]));
  return Object.fromEntries(entries);
};

const now = Date.now();

const nodeRelease = pickNodeRelease(await (await get("https://nodejs.org/dist/index.json")).json(), now);
if (!nodeRelease) throw new Error("No Node.js LTS release is at least seven days old");
const shasums = await (await get(`https://nodejs.org/dist/v${nodeRelease.version}/SHASUMS256.txt`)).text();

const uvRelease = pickUvRelease(await (await get("https://api.github.com/repos/astral-sh/uv/releases?per_page=30", { accept: "application/vnd.github+json" })).json(), now);
if (!uvRelease) throw new Error("No uv release is at least seven days old");

const manifest = {
  node: { ...nodeRelease, targets: await targetsFor(NODE_ARCHS, (arch) => nodeTarget(nodeRelease, shasums, arch)) },
  uv: { ...uvRelease, targets: await targetsFor(UV_ARCHS, (arch) => uvTarget(uvRelease, arch)) },
};

writeFileSync(OUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote Node.js ${nodeRelease.version} and uv ${uvRelease.version} to ${OUT_PATH}`);
