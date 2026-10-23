import type { ChatMessage, PlanEntry } from "../types";

/**
 * The plan a session is on: the newest reply the agent reported one for.
 * Older replies keep the plan they showed; an empty plan is not a plan.
 */
export function currentPlan(messages: readonly ChatMessage[]): PlanEntry[] | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const plan = messages[i].plan;
    if (plan && plan.length > 0) return plan;
  }
  return undefined;
}

/** How many of the plan's steps are done, for the top bar's count. */
export function planProgress(entries: readonly PlanEntry[]): { done: number; total: number } {
  return {
    done: entries.filter((entry) => entry.status === "completed").length,
    total: entries.length,
  };
}