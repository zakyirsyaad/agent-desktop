import { Sparkles, X } from "lucide-react";

export function NoticeBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      className="border-rose-800/60 bg-rose-950/40 text-rose-200 text-xs rounded-lg px-3 py-2 mx-6 mt-3 flex justify-between items-center"
    >
      <span className="break-words">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notice"
        className="shrink-0 ml-3 rounded p-0.5 text-rose-300 hover:text-rose-100 focus:outline-none focus:ring-1 focus:ring-rose-700"
      >
        <X size={13} />
      </button>
    </div>
  );
}

export function EmptySessionState() {
  return (
    <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-neutral-900 border border-neutral-800 text-amber-500">
        <Sparkles size={24} />
      </div>
      <h1 className="text-xl font-medium text-neutral-100">No session yet</h1>
      <p className="mt-1 max-w-sm text-sm text-neutral-400">
        Type a message below to start an agent in this workspace.
      </p>
    </div>
  );
}
