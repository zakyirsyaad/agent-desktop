import { describe, it, expect } from "vitest";
import { AGENT_IDLE_AFTER_MS, isAgentBusy } from "../lib/activity";

const LAST_OUTPUT_AT = 10_000;

describe("AGENT_IDLE_AFTER_MS", () => {
  it("treats an agent as idle after 1500ms of silence", () => {
    expect(AGENT_IDLE_AFTER_MS).toBe(1500);
  });
});

describe("isAgentBusy", () => {
  it("is idle when no output has ever been seen", () => {
    expect(isAgentBusy(null, LAST_OUTPUT_AT)).toBe(false);
    expect(isAgentBusy(null, 0)).toBe(false);
  });

  it("is busy the instant output arrives", () => {
    expect(isAgentBusy(LAST_OUTPUT_AT, LAST_OUTPUT_AT)).toBe(true);
  });

  it("is busy 1499ms after the last output", () => {
    expect(isAgentBusy(LAST_OUTPUT_AT, LAST_OUTPUT_AT + 1499)).toBe(true);
  });

  it("is idle at exactly AGENT_IDLE_AFTER_MS, so the boundary is not off by one", () => {
    expect(isAgentBusy(LAST_OUTPUT_AT, LAST_OUTPUT_AT + AGENT_IDLE_AFTER_MS)).toBe(false);
  });

  it("stays idle long after the last output", () => {
    expect(isAgentBusy(LAST_OUTPUT_AT, LAST_OUTPUT_AT + 60_000)).toBe(false);
  });

  it("honours a shorter custom idle window", () => {
    expect(isAgentBusy(LAST_OUTPUT_AT, LAST_OUTPUT_AT + 499, 500)).toBe(true);
    expect(isAgentBusy(LAST_OUTPUT_AT, LAST_OUTPUT_AT + 500, 500)).toBe(false);
  });

  it("honours a longer custom idle window", () => {
    expect(isAgentBusy(LAST_OUTPUT_AT, LAST_OUTPUT_AT + 5000, 10_000)).toBe(true);
    expect(isAgentBusy(LAST_OUTPUT_AT, LAST_OUTPUT_AT + 10_000, 10_000)).toBe(false);
  });

  it("is a pure function of its arguments", () => {
    expect(isAgentBusy(LAST_OUTPUT_AT, LAST_OUTPUT_AT + 100)).toBe(
      isAgentBusy(LAST_OUTPUT_AT, LAST_OUTPUT_AT + 100),
    );
  });
});
