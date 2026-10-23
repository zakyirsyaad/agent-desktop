import { describe, it, expect } from "vitest";
import { currentPlan, planProgress } from "../lib/plan";
import type { ChatMessage, PlanEntry } from "../types";

const step = (content: string, status: PlanEntry["status"]): PlanEntry => ({ content, status });

describe("currentPlan", () => {
  it("returns the newest plan the agent reported", () => {
    const messages: ChatMessage[] = [
      { id: "a-1", role: "agent", content: "", timestamp: 1, plan: [step("Old step", "completed")] },
      { id: "a-2", role: "agent", content: "", timestamp: 2, plan: [step("New step", "in_progress")] },
    ];

    expect(currentPlan(messages)).toEqual([step("New step", "in_progress")]);
  });

  it("skips a reply whose plan is empty", () => {
    const messages: ChatMessage[] = [
      { id: "a-1", role: "agent", content: "", timestamp: 1, plan: [step("Keep me", "pending")] },
      { id: "a-2", role: "agent", content: "", timestamp: 2, plan: [] },
    ];

    expect(currentPlan(messages)).toEqual([step("Keep me", "pending")]);
  });

  it("forgets an earlier turn's plan once you send a new message", () => {
    // A finished plan from yesterday is not what the agent is doing now.
    const messages: ChatMessage[] = [
      { id: "a-1", role: "agent", content: "", timestamp: 1, plan: [step("Done step", "completed")] },
      { id: "u-2", role: "user", content: "a quick question", timestamp: 2 },
      { id: "a-2", role: "agent", content: "the answer", timestamp: 3 },
    ];

    expect(currentPlan(messages)).toBeUndefined();
  });

  it("keeps the plan of a turn that just ended until the next message", () => {
    const messages: ChatMessage[] = [
      { id: "u-1", role: "user", content: "go", timestamp: 1 },
      { id: "a-1", role: "agent", content: "", timestamp: 2, plan: [step("Step", "completed")], isComplete: true },
    ];

    expect(currentPlan(messages)).toEqual([step("Step", "completed")]);
  });

  it("has no plan before the agent reports one", () => {
    expect(currentPlan([])).toBeUndefined();
    expect(
      currentPlan([{ id: "a-1", role: "agent", content: "hello", timestamp: 1 }]),
    ).toBeUndefined();
  });
});

describe("planProgress", () => {
  it("counts the completed steps out of all of them", () => {
    expect(
      planProgress([step("One", "completed"), step("Two", "in_progress"), step("Three", "pending")]),
    ).toEqual({ done: 1, total: 3 });
  });
});