import { useState } from "react";
import { FileText, Image as ImageIcon, X } from "lucide-react";
import { fileNameOf, isImagePath } from "../../lib/attachments";
import { useAttachmentPreview } from "../../hooks/useAttachmentPreview";
import { ImagePreviewDialog } from "./ImagePreviewDialog";

export interface AttachmentChipsProps {
  paths: readonly string[];
  /** Shows a remove button on each attachment when given. */
  onRemove?: (path: string) => void;
}

/** The remove button shared by a thumbnail and a chip. */
function RemoveButton({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      aria-label={`Remove ${name}`}
      onClick={onRemove}
      className="rounded-full bg-surface-3 text-fg-subtle hover:text-fg focus-ring"
    >
      <X size={12} />
    </button>
  );
}

/** An image attachment: its picture when it can be read, a chip when it cannot. */
function ImageAttachment({
  path,
  onRemove,
  onOpen,
}: {
  path: string;
  onRemove?: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const preview = useAttachmentPreview(path);
  const name = fileNameOf(path);

  if (preview.status === "ready") {
    return (
      <li title={path} className="relative">
        <button
          type="button"
          aria-label={`Open ${name}`}
          aria-haspopup="dialog"
          onClick={() => onOpen(path)}
          className="block overflow-hidden rounded-lg border border-border focus-ring"
        >
          <img src={preview.src} alt={name} className="h-16 w-16 object-cover" />
        </button>
        {onRemove && (
          <span className="absolute -right-1.5 -top-1.5">
            <RemoveButton name={name} onRemove={() => onRemove(path)} />
          </span>
        )}
      </li>
    );
  }

  return (
    <li
      title={path}
      aria-busy={preview.status === "loading"}
      className="flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-fg-secondary"
    >
      <ImageIcon size={11} className="text-fg-subtle" />
      <span className="max-w-48 truncate">{name}</span>
      {preview.status === "failed" && <span className="text-fg-subtle">Image not found</span>}
      {onRemove && <RemoveButton name={name} onRemove={() => onRemove(path)} />}
    </li>
  );
}

/** Files attached to a message, by name: images as thumbnails, other files as chips. */
export function AttachmentChips({ paths, onRemove }: AttachmentChipsProps) {
  const [openPath, setOpenPath] = useState<string | null>(null);

  return (
    <>
      <ul aria-label="Attachments" className="flex flex-wrap items-center gap-1.5">
        {paths.map((path) => {
          if (isImagePath(path)) {
            return <ImageAttachment key={path} path={path} onRemove={onRemove} onOpen={setOpenPath} />;
          }
          const name = fileNameOf(path);
          return (
            <li
              key={path}
              title={path}
              className="flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-fg-secondary"
            >
              <FileText size={11} className="text-fg-subtle" />
              <span className="max-w-48 truncate">{name}</span>
              {onRemove && <RemoveButton name={name} onRemove={() => onRemove(path)} />}
            </li>
          );
        })}
      </ul>
      {openPath && <ImagePreviewDialog path={openPath} onClose={() => setOpenPath(null)} />}
    </>
  );
}