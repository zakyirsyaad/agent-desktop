import { Sparkles, X } from "lucide-react";
import { NOTICE_BANNER_LAYOUT } from "./ui/noticeBannerStyle";

export function NoticeBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      className={`bg-danger-surface text-danger ${NOTICE_BANNER_LAYOUT}`}
    >
      <span className="break-words">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notice"
        className="shrink-0 ml-3 rounded p-0.5 text-danger hover:text-fg focus-ring"
      >
        <X size={13} />
      </button>
    </div>
  );
}

export function EmptySessionState() {
  return (
    <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 border border-border text-fg-muted">
        <Sparkles size={24} />
      </div>
      <h1 className="text-xl font-medium text-fg">No session yet</h1>
      <p className="mt-1 max-w-sm text-sm text-fg-muted">
        Type a message below to start an agent in this workspace.
      </p>
    </div>
  );
}

/** Shown over the conversation while files are dragged onto the window. */
export function FileDropOverlay() {
  return (
    <div className="pointer-events-none absolute inset-3 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-border-strong bg-overlay text-sm text-fg">
      Drop files to add them to your message
    </div>
  );
}
