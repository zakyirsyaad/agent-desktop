import { Copy, Check, GitBranch, Volume2, Square } from "lucide-react";

export interface MessageActionBarProps {
  copied: boolean;
  timeLabel: string;
  onCopy: () => void;
  /** Fork is offered only when the host app can fork a session. */
  onFork?: () => void;
  /** Read aloud is offered only when speech synthesis is available. */
  readAloud?: { speaking: boolean; onToggle: () => void };
}

const ACTION_BUTTON_CLASS =
  "flex items-center gap-1 hover:text-neutral-200 transition-colors";

/** Copy / Fork / Read aloud controls and the timestamp under an agent message. */
export function MessageActionBar({
  copied,
  timeLabel,
  onCopy,
  onFork,
  readAloud,
}: MessageActionBarProps) {
  return (
    <div className="flex items-center gap-3 mt-2 px-1 text-xs text-neutral-400">
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy message"
        className={ACTION_BUTTON_CLASS}
      >
        {copied ? (
          <>
            <Check className="h-3.5 w-3.5 text-emerald-400" />
            <span className="text-emerald-400">Copied</span>
          </>
        ) : (
          <>
            <Copy className="h-3.5 w-3.5" />
            <span>Copy</span>
          </>
        )}
      </button>

      {onFork && (
        <button
          type="button"
          onClick={onFork}
          aria-label="Fork branch"
          className={ACTION_BUTTON_CLASS}
        >
          <GitBranch className="h-3.5 w-3.5" />
          <span>Fork</span>
        </button>
      )}

      {readAloud && (
        <button
          type="button"
          onClick={readAloud.onToggle}
          aria-label={readAloud.speaking ? "Stop reading" : "Read aloud"}
          className={`${ACTION_BUTTON_CLASS} ${
            readAloud.speaking ? "text-amber-400" : ""
          }`}
        >
          {readAloud.speaking ? (
            <Square className="h-3.5 w-3.5" />
          ) : (
            <Volume2 className="h-3.5 w-3.5" />
          )}
        </button>
      )}

      <span className="text-neutral-400">{timeLabel}</span>
    </div>
  );
}
