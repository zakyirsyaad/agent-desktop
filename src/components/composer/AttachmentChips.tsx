import { FileText, Image as ImageIcon, X } from "lucide-react";
import { fileNameOf, isImagePath } from "../../lib/attachments";

export interface AttachmentChipsProps {
  paths: readonly string[];
  /** Shows a remove button on each chip when given. */
  onRemove?: (path: string) => void;
}

/** Files attached to a message, by name, with an image or file icon. */
export function AttachmentChips({ paths, onRemove }: AttachmentChipsProps) {
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
      {paths.map((path) => {
        const name = fileNameOf(path);
        const Icon = isImagePath(path) ? ImageIcon : FileText;
        return (
          <li
            key={path}
            title={path}
            className="flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-fg-secondary"
          >
            <Icon size={11} className="text-fg-subtle" />
            <span className="max-w-48 truncate">{name}</span>
            {onRemove && (
              <button
                type="button"
                aria-label={`Remove ${name}`}
                onClick={() => onRemove(path)}
                className="ml-0.5 rounded text-fg-subtle hover:text-fg"
              >
                <X size={11} />
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
