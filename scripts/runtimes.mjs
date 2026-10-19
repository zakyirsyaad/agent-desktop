// Pure helpers for scripts/runtimes-update.mjs, kept apart so Vitest can test them.

const WAIT_MS = 7 * 24 * 60 * 60 * 1000;

/** True when a release dated `dateIso` is at least seven days older than `nowMs`. */
export const isOldEnough = (dateIso, nowMs) => {
  const ms = Date.parse(dateIso);
  return Number.isFinite(ms) && nowMs - ms >= WAIT_MS;
};

const newestFirst = (a, b) => Date.parse(b.date) - Date.parse(a.date);

const major = (version) => Number.parseInt(version.replace(/^v/, ""), 10);

/**
 * Newest release of the highest LTS line that has one at least seven days old, as
 * {version, released}. An older line's later patch release does not win by date alone.
 */
export const pickNodeRelease = (indexJson, nowMs) => {
  const eligible = indexJson.filter((r) => r.lts !== false && isOldEnough(r.date, nowMs));
  const topLine = Math.max(...eligible.map((r) => major(r.version)));
  const chosen = eligible.filter((r) => major(r.version) === topLine).sort(newestFirst)[0];
  return chosen ? { version: chosen.version.replace(/^v/, ""), released: chosen.date.slice(0, 10) } : null;
};

/** Newest published, non-pre uv release from the GitHub API that is old enough, as {version, released}. */
export const pickUvRelease = (releasesJson, nowMs) => {
  const chosen = releasesJson
    .filter((r) => !r.draft && !r.prerelease && isOldEnough(r.published_at, nowMs))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  return chosen ? { version: chosen.tag_name.replace(/^v/, ""), released: chosen.published_at.slice(0, 10) } : null;
};

/** The hash for `filename` in a SHASUMS256.txt body ("<hash>  <name>" lines), or null. */
export const parseShasums = (text, filename) => {
  for (const line of text.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === filename && /^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase();
  }
  return null;
};
