import { Copy, Check, GitBranch, Volume2, Square } from "lucide-react";

export interface MessageActionBarProps {
  copied: boolean;
  /** Undefined for a replayed message, whose time the agent did not report. */
  timeLabel?: string;
  onCopy: () => void;
  /** Fork is offered only when the host app can fork a session. */
  onFork?: () => void;
  /** Read aloud is offered only when speech synthesis is available. */
  readAloud?: { speaking: boolean; onToggle: () => void };
}

const ACTION_BUTTON_CLASS =
  "flex items-center gap-1 hover:text-fg-secondary transition-colors";

/** Copy / Fork / Read aloud controls and the timestamp under an agent message. */
export function MessageActionBar({
  copied,
  timeLabel,
  onCopy,
  onFork,
  readAloud,
}: MessageActionBarProps) {
  return (
    <div className="flex items-center gap-3 mt-2 px-1 text-xs text-fg-muted">
      <button
        type="button"
        onClick={onCopy}
        aria-label="Copy message"
        className={ACTION_BUTTON_CLASS}
      >
        {copied ? (
          <>
            <Check className="h-3.5 w-3.5 text-status-running" />
            <span className="text-status-running">Copied</span>
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
            readAloud.speaking ? "text-fg" : ""
          }`}
        >
          {readAloud.speaking ? (
            <Square className="h-3.5 w-3.5" />
          ) : (
            <Volume2 className="h-3.5 w-3.5" />
          )}
        </button>
      )}

      {timeLabel && <span className="text-fg-muted">{timeLabel}</span>}
    </div>
  );
}
