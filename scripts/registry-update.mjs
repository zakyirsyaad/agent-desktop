// Refreshes src-tauri/resources/registry-history.json from the live ACP registry.
//
//   pnpm registry:update
//   pnpm registry:update --include @agentclientprotocol/claude-agent-acp@0.92.0
//
// A new version is dated by when it was really published (npm, PyPI or the GitHub
// release) so the app's seven-day wait does not restart for versions that are old.
// Needs network, plus `npm` and `gh` on PATH. A lookup that fails is skipped and
// that version is dated today.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isUsableEntry, mergeObserved, sortHistory } from "./registry-history.mjs";

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const HISTORY_PATH = fileURLToPath(new URL("../src-tauri/resources/registry-history.json", import.meta.url));

const toSeconds = (iso) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};

/** "@scope/name@1.2.3" -> "@scope/name"; "name==1.2.3" -> "name". */
const packageName = (spec) => {
  const eq = spec.indexOf("==");
  if (eq > 0) return spec.slice(0, eq);
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
};

const npmTimes = new Map();
const npmPublishTimes = (name) => {
  if (!npmTimes.has(name)) {
    const out = run("npm", ["view", name, "time", "--json"]);
    npmTimes.set(name, out ? JSON.parse(out) : {});
  }
  return npmTimes.get(name);
};

const npmPublishedAt = (name, version) => {
  const iso = npmPublishTimes(name)[version];
  return iso ? toSeconds(iso) : null;
};

const pypiPublishedAt = (name, version) => {
  const out = run("curl", ["-fsS", "--max-time", "20", `https://pypi.org/pypi/${name}/${version}/json`]);
  if (!out) return null;
  const iso = JSON.parse(out).urls?.[0]?.upload_time_iso_8601;
  return iso ? toSeconds(iso) : null;
};

const githubPublishedAt = (binary) => {
  const archive = Object.values(binary)[0]?.archive ?? "";
  const match = archive.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\//);
  if (!match) return null;
  const [, owner, repo, tag] = match;
  const out = run("gh", ["api", `repos/${owner}/${repo}/releases/tags/${tag}`, "--jq", ".published_at"]);
  return out ? toSeconds(out.trim()) : null;
};

const publishedAt = (entry) => {
  const { npx, uvx, binary } = entry.distribution;
  if (npx) return npmPublishedAt(packageName(npx.package), entry.version);
  if (uvx) return pypiPublishedAt(packageName(uvx.package), entry.version);
  return binary ? githubPublishedAt(binary) : null;
};

/** The older-version entry for `--include pkg@version`, copied from the agent that uses pkg. */
const includedEntry = (spec, registryEntries) => {
  const name = packageName(spec);
  const version = spec.slice(name.length + 1);
  const current = registryEntries.find((e) => e.distribution.npx && packageName(e.distribution.npx.package) === name);
  if (!current || !version) throw new Error(`No registry agent uses the npm package ${name}`);
  return {
    ...current,
    version,
    distribution: { npx: { ...current.distribution.npx, package: `${name}@${version}` } },
  };
};

const includes = process.argv.flatMap((arg, i, all) => (all[i - 1] === "--include" ? [arg] : []));

const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(20_000) });
if (!response.ok) throw new Error(`Registry request failed: ${response.status}`);
const registryEntries = (await response.json()).agents.filter(isUsableEntry);

const existing = existsSync(HISTORY_PATH) ? JSON.parse(readFileSync(HISTORY_PATH, "utf8")) : { agents: {} };
const entries = [...registryEntries, ...includes.map((spec) => includedEntry(spec, registryEntries))];
const merged = sortHistory(mergeObserved(existing, entries, Math.floor(Date.now() / 1000), publishedAt));

writeFileSync(HISTORY_PATH, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`Wrote ${Object.keys(merged.agents).length} agents to ${HISTORY_PATH}`);
