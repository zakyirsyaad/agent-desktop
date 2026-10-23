import { invoke } from "@tauri-apps/api/core";

/**
 * How many previews stay in memory. Each is a data URL of up to ~13 MB, so
 * the oldest one read makes room once the cache is full.
 */
export const MAX_CACHED_PREVIEWS = 24;

/** Preview data URLs by path, oldest read first. */
const previews = new Map<string, string>();

export interface CachedPreview {
  /** False until the path's preview has been asked for. */
  found: boolean;
  src: string | null;
}

/** The preview already read for `path`, if any. */
export function cachedPreview(path: string): CachedPreview {
  const src = previews.get(path);
  return src === undefined ? { found: false, src: null } : { found: true, src };
}

/**
 * Reads an attached image as a data URL, once per path for the whole window:
 * the composer's thumbnail and the sent message's thumbnail share one read.
 * A failure is not remembered: a screenshot still being written, or a drive
 * not yet mounted, can be read the next time it is shown.
 */
export function loadPreview(path: string): Promise<string | null> {
  const cached = previews.get(path);
  if (cached !== undefined) {
    // Read again, so it is the newest entry and the last to be dropped.
    previews.delete(path);
    previews.set(path, cached);
    return Promise.resolve(cached);
  }
  return invoke<string>("attachment_preview", { path }).then(
    (src) => {
      previews.set(path, src);
      const oldest = previews.keys().next().value;
      if (previews.size > MAX_CACHED_PREVIEWS && oldest !== undefined) previews.delete(oldest);
      return src;
    },
    () => null,
  );
}

/** Drops every cached preview; tests start from an empty cache. */
export function clearAttachmentPreviews(): void {
  previews.clear();
}