import type { ChatMessage, PlanEntry } from "../types";

/**
 * The plan a session is on: the newest one the agent reported in the current
 * turn (since your last message). An earlier turn's plan is not what the agent
 * is doing now; that reply still opens its own steps. An empty plan is not a plan.
 */
export function currentPlan(messages: readonly ChatMessage[]): PlanEntry[] | undefined {
  for (let i = messages.length - 1; i >= 0 && messages[i].role !== "user"; i -= 1) {
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