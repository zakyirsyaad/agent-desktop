import { useEffect, useState } from "react";
import { cachedPreview, loadPreview } from "../lib/attachment-previews";

/** What an image attachment's thumbnail knows so far. */
export type AttachmentPreview =
  | { status: "loading" }
  | { status: "ready"; src: string }
  | { status: "failed" };

const LOADING: AttachmentPreview = { status: "loading" };
const FAILED: AttachmentPreview = { status: "failed" };

function previewOf(src: string | null | undefined): AttachmentPreview {
  if (src === undefined) return LOADING;
  return src === null ? FAILED : { status: "ready", src };
}

/** The asset URL for an attached image, shared across the window. */
export function useAttachmentPreview(path: string): AttachmentPreview {
  const [preview, setPreview] = useState<AttachmentPreview>(() => previewOf(cachedPreview(path)));

  useEffect(() => {
    let isCancelled = false;
    const cached = cachedPreview(path);
    if (cached !== undefined) {
      setPreview(previewOf(cached));
      return;
    }
    setPreview(LOADING);
    loadPreview(path).then((src) => {
      if (!isCancelled) setPreview(previewOf(src));
    });
    return () => {
      isCancelled = true;
    };
  }, [path]);

  return preview;
}
