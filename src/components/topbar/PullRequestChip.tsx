import { Check, Circle, GitPullRequest, X } from "lucide-react";
import type { PullRequestStatus } from "../../hooks/usePullRequest";

const STATE_STYLE: Record<string, string> = {
  open: "text-emerald-400",
  draft: "text-neutral-400",
  merged: "text-purple-400",
  closed: "text-rose-400",
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
      className="flex shrink-0 items-center gap-1 rounded px-1 text-[11px] font-mono text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-700"
    >
      <GitPullRequest size={11} aria-hidden="true" className={STATE_STYLE[state] ?? "text-neutral-400"} />
      <span>#{pullRequest.number}</span>
      {checks === "passing" && <Check size={11} aria-hidden="true" className="text-emerald-400" />}
      {checks === "failing" && <X size={11} aria-hidden="true" className="text-rose-400" />}
      {checks === "running" && <Circle size={8} aria-hidden="true" className="fill-amber-400 text-amber-400" />}
    </button>
  );
}
