import { Check, Circle, GitPullRequest, X } from "lucide-react";
import type { PullRequestStatus } from "../../hooks/usePullRequest";

const STATE_STYLE: Record<string, string> = {
  open: "text-status-running",
  draft: "text-fg-muted",
  merged: "text-status-merged",
  closed: "text-danger",
};

/** How the checks stand, in a word: failing beats running beats passing. */
function checksWord({ passing, failing, pending }: PullRequestStatus["checks"]): "failing" | "running" | "passing" | null {
  if (failing > 0) return "failing";
  if (pending > 0) return "running";
  return passing > 0 ? "passing" : null;
}

/** The open session's pull request in the top bar: its number, state and checks; a click opens it. */
export function PullRequestChip({ pullRequest, onOpen }: { pullRequest: PullRequestStatus; onOpen: (url: string) => void }) {
  const state = pullRequest.isDraft && pullRequest.state === "open" ? "draft" : pullRequest.state;
  const checks = checksWord(pullRequest.checks);
  const label = [`Pull request #${pullRequest.number}`, state, checks && `checks ${checks}`].filter(Boolean).join(", ");
  return (
    <button
      type="button"
      onClick={() => onOpen(pullRequest.url)}
      aria-label={label}
      title={`${pullRequest.title}\n${label}`}
      className="flex shrink-0 items-center gap-1 rounded px-1 text-[11px] font-mono text-fg-muted hover:bg-surface-hover hover:text-fg-secondary focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
    >
      <GitPullRequest size={11} aria-hidden="true" className={STATE_STYLE[state] ?? "text-fg-muted"} />
      <span>#{pullRequest.number}</span>
      {checks === "passing" && <Check size={11} aria-hidden="true" className="text-status-running" />}
      {checks === "failing" && <X size={11} aria-hidden="true" className="text-danger" />}
      {checks === "running" && <Circle size={8} aria-hidden="true" className="fill-status-attention text-status-attention" />}
    </button>
  );
}
