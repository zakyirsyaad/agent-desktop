import { useEffect, useState } from "react";
import { cachedPreview, loadPreview } from "../lib/attachment-previews";

/** What an image attachment's thumbnail knows so far. */
export type AttachmentPreview =
  | { status: "loading" }
  | { status: "ready"; src: string }
  | { status: "failed" };

const FAILED: AttachmentPreview = { status: "failed" };

/** The data URL for an attached image, cached across the window. */
export function useAttachmentPreview(path: string): AttachmentPreview {
  const [preview, setPreview] = useState<AttachmentPreview>(() => {
    const cached = cachedPreview(path);
    if (!cached.found) return { status: "loading" };
    return cached.src ? { status: "ready", src: cached.src } : FAILED;
  });

  useEffect(() => {
    let isCancelled = false;
    const cached = cachedPreview(path);
    if (cached.found) {
      setPreview(cached.src ? { status: "ready", src: cached.src } : FAILED);
      return;
    }
    setPreview({ status: "loading" });
    loadPreview(path).then((src) => {
      if (isCancelled) return;
      setPreview(src ? { status: "ready", src } : FAILED);
    });
    return () => {
      isCancelled = true;
    };
  }, [path]);

  return preview;
}