import { Brain, CheckCircle2, Circle, CircleDot } from "lucide-react";
import type { PlanEntry } from "../../types";

/** The agent's streamed reasoning, collapsed by default so the answer stays in focus. */
export function ThinkingBlock({ text }: { text: string }) {
  return (
    <details className="mb-3 rounded-lg border border-neutral-800/70 bg-neutral-950/40 px-3 py-2 text-xs text-neutral-400">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 text-neutral-400 hover:text-neutral-200">
        <Brain className="h-3.5 w-3.5" />
        <span>Thinking</span>
      </summary>
      <p className="mt-2 whitespace-pre-wrap leading-relaxed">{text}</p>
    </details>
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
