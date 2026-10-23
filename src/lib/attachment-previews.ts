import { invoke } from "@tauri-apps/api/core";

/** Preview data URLs by path; null marks a file that could not be read. */
const previews = new Map<string, string | null>();

export interface CachedPreview {
  /** False until the path's preview has been asked for. */
  found: boolean;
  src: string | null;
}

/** The preview already read for `path`, if any. */
export function cachedPreview(path: string): CachedPreview {
  return previews.has(path) ? { found: true, src: previews.get(path) ?? null } : { found: false, src: null };
}

/**
 * Reads an attached image as a data URL, once per path for the whole window:
 * the composer's thumbnail and the sent message's thumbnail share one read.
 * A failure is remembered too, so a missing file is not asked for again.
 */
export function loadPreview(path: string): Promise<string | null> {
  const cached = previews.get(path);
  if (cached !== undefined) return Promise.resolve(cached);
  return invoke<string>("attachment_preview", { path }).then(
    (src) => {
      previews.set(path, src);
      return src;
    },
    () => {
      previews.set(path, null);
      return null;
    },
  );
}

/** Drops every cached preview; tests start from an empty cache. */
export function clearAttachmentPreviews(): void {
  previews.clear();
}