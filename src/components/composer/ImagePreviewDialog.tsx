import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { useAttachmentPreview } from "../../hooks/useAttachmentPreview";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { fileNameOf } from "../../lib/attachments";
import { IconButton } from "../ui/IconButton";

export interface ImagePreviewDialogProps {
  path: string;
  onClose: () => void;
}

/** An attached image at full size, over the app, until it is closed. */
export function ImagePreviewDialog({ path, onClose }: ImagePreviewDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const preview = useAttachmentPreview(path);
  const name = fileNameOf(path);
  useFocusTrap(dialogRef);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay px-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col gap-3 rounded-xl border border-border bg-surface-1 p-4 text-fg-secondary shadow-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="truncate text-sm font-medium text-fg" title={path}>
            {name}
          </h2>
          <IconButton ref={closeRef} label="Close preview" onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </IconButton>
        </header>

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-border bg-bg">
          {preview.status === "ready" ? (
            <img src={preview.src} alt={name} className="max-h-[70vh] max-w-full object-contain" />
          ) : (
            <p className="px-4 py-10 text-xs text-fg-subtle">
              {preview.status === "failed" ? "Image not found" : "Loading…"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}