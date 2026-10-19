// Pure helpers for the bundled registry history (src-tauri/resources/registry-history.json).

/**
 * Returns a new history with each entry's (id, version) added. A version already
 * in the history keeps its date; a new one is dated by its publish time when that
 * is earlier than `now`, otherwise `now`. Dates are unix seconds.
 */
export function mergeObserved(history, entries, now, publishedAt) {
  const agents = structuredClone(history.agents ?? {});
  for (const entry of entries) {
    const versions = (agents[entry.id] ??= {});
    if (versions[entry.version]) continue;
    const published = publishedAt(entry);
    versions[entry.version] = {
      first_seen: Math.min(now, published ?? now),
      entry,
    };
  }
  return { agents };
}

/** Sorts ids and versions so the written file diffs cleanly. */
export function sortHistory(history) {
  const byKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
  const agents = {};
  for (const [id, versions] of Object.entries(history.agents).sort(byKey)) {
    agents[id] = Object.fromEntries(Object.entries(versions).sort(byKey));
  }
  return { agents };
}

/** True when the entry has the fields the app's parser requires: one distribution key, complete binary targets. */
export function isUsableEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const { id, name, version, distribution } = entry;
  if (![id, name, version].every((v) => typeof v === "string" && v)) return false;
  if (!distribution || typeof distribution !== "object") return false;
  if (["npx", "uvx", "binary"].filter((k) => distribution[k] != null).length !== 1) return false;
  if (distribution.binary == null) return true;
  return Object.values(distribution.binary).every(
    (target) => target && ["archive", "cmd", "sha256"].every((k) => typeof target[k] === "string"),
  );
}
