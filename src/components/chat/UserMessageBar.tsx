import { useEffect, useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";

export interface UserMessageBarProps {
  timeLabel: string;
  copied: boolean;
  onCopy: () => void;
  /** Takes the conversation back to before this message; offered only when the host can. */
  onRewind?: () => void;
}

const ICON_BUTTON =
  "rounded p-0.5 text-neutral-500 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-700";

/** How long Rewind waits for its confirming second click. */
const CONFIRM_REWIND_MS = 4000;

/**
 * Rewinding drops every message after this one for good, so it takes two
 * clicks: the icon turns into "Rewind?", which rewinds; it turns back by itself.
 */
function RewindButton({ onRewind }: { onRewind: () => void }) {
  const [isConfirming, setIsConfirming] = useState(false);
  useEffect(() => {
    if (!isConfirming) return;
    const timer = setTimeout(() => setIsConfirming(false), CONFIRM_REWIND_MS);
    return () => clearTimeout(timer);
  }, [isConfirming]);

  if (isConfirming) {
    return (
      <button
        type="button"
        aria-label="Confirm rewind"
        title="Remove this message and everything after it, and put it back in the composer"
        onClick={() => {
          setIsConfirming(false);
          onRewind();
        }}
        className="rounded bg-amber-950/70 px-1.5 py-0.5 text-[10px] font-medium text-amber-300 hover:bg-amber-900 focus:outline-none focus:ring-1 focus:ring-amber-700"
      >
        Rewind?
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setIsConfirming(true)}
      aria-label="Rewind to here"
      title="Go back to before this message, with it ready to edit"
      className={ICON_BUTTON}
    >
      <RotateCcw className="h-3.5 w-3.5" />
    </button>
  );
}

/** The time, Copy and Rewind under one of your messages. */
export function UserMessageBar({ timeLabel, copied, onCopy, onRewind }: UserMessageBarProps) {
  return (
    <div className="mt-1.5 flex items-center gap-2 px-1 text-xs text-neutral-500">
      <span>{timeLabel}</span>
      <button type="button" onClick={onCopy} aria-label="Copy message" title="Copy" className={ICON_BUTTON}>
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {onRewind && <RewindButton onRewind={onRewind} />}
    </div>
  );
}
