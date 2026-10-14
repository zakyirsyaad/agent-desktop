import { Check, X, Wrench, AlertTriangle } from "lucide-react";
import type { ActionCard as ActionCardType } from "../types";

/**
 * Approval card for an agent prompt. It deliberately offers no in-place command
 * editing: the only thing a y/n prompt understands is the approval or rejection
 * key, and typing an edited command into it can approve the original command
 * (for example "yarn clean" begins with "y").
 */
export interface ActionCardProps {
  card: ActionCardType;
  onApprove: (key: string) => void;
  onReject: (key: string) => void;
  disabled?: boolean;
}

export function ActionCard({
  card,
  onApprove,
  onReject,
  disabled = false,
}: ActionCardProps) {
  const isResolved = card.status === "approved" || card.status === "rejected";
  const isDisabled = disabled || isResolved;

  const handleApprove = () => {
    if (isDisabled) return;
    onApprove(card.approvalKey || "y\n");
  };

  const handleReject = () => {
    if (isDisabled) return;
    onReject(card.rejectKey || "n\n");
  };

  return (
    <div
      data-testid={`action-card-${card.id}`}
      className="my-3 rounded-xl border border-neutral-800 border-l-4 border-l-amber-500 bg-[#141414] p-4 text-left shadow-lg transition-all"
    >
      {/* Header with Title and Tool Badge */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
          <h2 className="text-sm font-semibold tracking-wide text-neutral-100">
            {card.title}
          </h2>
        </div>

        {card.toolName && (
          <span className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 border border-neutral-800 px-2.5 py-0.5 text-xs font-mono text-neutral-400">
            <Wrench className="h-3 w-3 text-neutral-500" />
            Tool: {card.toolName}
          </span>
        )}
      </div>

      {/* Description / Prompt */}
      <p className="mt-2 text-xs leading-relaxed text-neutral-300">
        {card.prompt}
      </p>

      {/* Command Snippet */}
      {card.commandSnippet && (
        <div className="mt-3 rounded-lg border border-neutral-800/80 bg-neutral-950/80 p-2.5 font-mono text-xs text-amber-400/90 overflow-x-auto">
          <code>{card.commandSnippet}</code>
        </div>
      )}

      {/* Action Buttons */}
      <div className="mt-4 flex items-center justify-between gap-2 pt-2 border-t border-neutral-800/60">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleApprove}
            disabled={isDisabled}
            aria-label={card.status === "approved" ? "Approved" : "Approve"}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors ${
              card.status === "approved"
                ? "bg-emerald-950/60 text-emerald-400 border border-emerald-800/50 cursor-not-allowed opacity-80"
                : isDisabled
                ? "bg-neutral-800 text-neutral-500 cursor-not-allowed border border-neutral-700/50"
                : "bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm hover:shadow"
            }`}
          >
            <Check className="h-3.5 w-3.5" />
            {card.status === "approved" ? "Approved" : "✓ Approve"}
          </button>

          <button
            type="button"
            onClick={handleReject}
            disabled={isDisabled}
            aria-label={card.status === "rejected" ? "Rejected" : "Reject"}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              card.status === "rejected"
                ? "bg-rose-950/60 text-rose-400 border border-rose-800/50 cursor-not-allowed opacity-80"
                : isDisabled
                ? "bg-neutral-800 text-neutral-500 cursor-not-allowed border border-neutral-700/50"
                : "bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-700"
            }`}
          >
            <X className="h-3.5 w-3.5" />
            {card.status === "rejected" ? "Rejected" : "✕ Reject"}
          </button>
        </div>
      </div>
    </div>
  );
}
