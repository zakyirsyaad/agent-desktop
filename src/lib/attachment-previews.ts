import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/** Asset URLs of pictures the backend has allowed, by path. */
const previews = new Map<string, string>();
/** Reads still in flight, so thumbnails that mount together share one. */
const pending = new Map<string, Promise<string | null>>();

/** The preview URL already allowed for `path`, if any. */
export function cachedPreview(path: string): string | undefined {
  return previews.get(path);
}

/**
 * Asks the backend to check an attached image and let the webview load it
 * through the asset protocol, once per path for the whole window: the
 * composer's thumbnail, the sent message's thumbnail and the larger view share
 * one call, even when they mount at once. The URL is a short string, so they
 * are kept. A failure is not remembered: a screenshot still being written, or a
 * drive not yet mounted, can be read the next time it is shown.
 */
export function loadPreview(path: string): Promise<string | null> {
  const cached = previews.get(path);
  if (cached !== undefined) return Promise.resolve(cached);
  const inFlight = pending.get(path);
  if (inFlight) return inFlight;
  const read = invoke("attachment_preview", { path })
    .then(
      () => {
        const src = convertFileSrc(path);
        previews.set(path, src);
        return src;
      },
      () => null,
    )
    .finally(() => pending.delete(path));
  pending.set(path, read);
  return read;
}

/** Drops every cached preview; tests start from an empty cache. */
export function clearAttachmentPreviews(): void {
  previews.clear();
  pending.clear();
}
