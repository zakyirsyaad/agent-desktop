import { CheckCircle2, ChevronRight, Circle, CircleDot, Sparkles } from "lucide-react";
import type { PlanEntry } from "../../types";

/**
 * The agent's streamed reasoning: a quiet row with a chevron, collapsed by
 * default so the answer stays in focus. "Thinking" while the reply streams,
 * "Thought" once it is done.
 */
export function ThinkingBlock({ text, isDone = false }: { text: string; isDone?: boolean }) {
  return (
    <details className="group mb-2 text-xs">
      <summary className="flex w-fit cursor-pointer select-none list-none items-center gap-1 text-neutral-500 hover:text-neutral-300 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" aria-hidden="true" />
        <span>{isDone ? "Thought" : "Thinking"}</span>
      </summary>
      <p className="mt-1.5 ml-[7px] whitespace-pre-wrap border-l border-neutral-800 pl-3 leading-relaxed text-neutral-400">
        {text}
      </p>
    </details>
  );
}

/** Shown under the last message while the agent works on its turn. */
export function WorkingIndicator() {
  return (
    <div
      data-testid="agent-working"
      role="status"
      className="mx-auto flex w-full max-w-3xl items-center gap-2 px-1 text-xs text-neutral-400"
    >
      <Sparkles className="h-3.5 w-3.5 animate-pulse text-amber-500" aria-hidden="true" />
      <span className="animate-pulse">Working…</span>
    </div>
  );
}

const PLAN_ICON: Record<PlanEntry["status"], typeof Circle> = {
  pending: Circle,
  in_progress: CircleDot,
  completed: CheckCircle2,
};

const PLAN_TONE: Record<PlanEntry["status"], string> = {
  pending: "text-neutral-500",
  in_progress: "text-amber-400",
  completed: "text-emerald-400",
};

/** The agent's current plan, one line per step with its status. */
export function PlanList({ entries }: { entries: PlanEntry[] }) {
  return (
    <ul aria-label="Plan" className="mb-3 space-y-1 rounded-lg border border-neutral-800/70 bg-neutral-950/40 px-3 py-2">
      {entries.map((entry, index) => {
        const Icon = PLAN_ICON[entry.status];
        return (
          <li key={`${index}-${entry.content}`} className="flex items-start gap-2 text-xs text-neutral-300">
            <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${PLAN_TONE[entry.status]}`} aria-label={entry.status} />
            <span className={entry.status === "completed" ? "text-neutral-500 line-through" : ""}>
              {entry.content}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
