import { Check, Copy, RotateCcw } from "lucide-react";

export interface UserMessageBarProps {
  timeLabel: string;
  copied: boolean;
  onCopy: () => void;
  /** Starts again from before this message; offered only when the host can. */
  onRewind?: () => void;
}

const ICON_BUTTON =
  "rounded p-0.5 text-neutral-500 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-700";

/** The time, Copy and Rewind under one of your messages. */
export function UserMessageBar({ timeLabel, copied, onCopy, onRewind }: UserMessageBarProps) {
  return (
    <div className="mt-1.5 flex items-center gap-2 px-1 text-xs text-neutral-500">
      <span>{timeLabel}</span>
      <button type="button" onClick={onCopy} aria-label="Copy message" title="Copy" className={ICON_BUTTON}>
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {onRewind && (
        <button
          type="button"
          onClick={onRewind}
          aria-label="Rewind to here"
          title="Start again from before this message, with it ready to edit (this session is kept)"
          className={ICON_BUTTON}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
