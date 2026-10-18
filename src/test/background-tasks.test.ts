import { describe, it, expect } from "vitest";
import { backgroundTasksOf, formatElapsed } from "../lib/background-tasks";
import type { Session } from "../types";

function session(over: Partial<Session>): Session {
  return { id: "s1", name: "Alpha", profileId: "p", cwd: "/w", status: "running", createdAt: 500, ...over };
}

const base = {
  isAcp: (s: Session) => s.transport === "acp",
  isBusy: () => false,
  busySince: () => undefined,
  needsApproval: () => false,
  processes: [],
  now: 100_000,
};

describe("formatElapsed", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(133_000)).toBe("2m 13s");
    expect(formatElapsed(3_840_000)).toBe("1h 04m");
  });
});

describe("backgroundTasksOf", () => {
  it("lists a busy agent that needs approval", () => {
    const tasks = backgroundTasksOf({
      ...base,
      sessions: [session({ transport: "acp" })],
      isBusy: () => true,
      busySince: () => 1000,
      needsApproval: () => true,
    });
    expect(tasks).toEqual([
      expect.objectContaining({ id: "agent:s1", kind: "agent", status: "Needs approval", startedAt: 1000, sessionId: "s1" }),
    ]);
  });

  it("falls back to createdAt when a busy agent has no busySince", () => {
    const tasks = backgroundTasksOf({ ...base, sessions: [session({ transport: "acp" })], isBusy: () => true });
    expect(tasks[0]).toMatchObject({ status: "Working", startedAt: 500 });
  });

  it("skips idle agents", () => {
    expect(backgroundTasksOf({ ...base, sessions: [session({ transport: "acp" })] })).toEqual([]);
  });

  it("lists running terminals and skips terminated ones", () => {
    const tasks = backgroundTasksOf({
      ...base,
      sessions: [session({}), session({ id: "s2", status: "terminated" })],
    });
    expect(tasks).toEqual([expect.objectContaining({ id: "terminal:s1", kind: "terminal", status: "Running", startedAt: 500 })]);
  });

  it("lists processes with the session name and ports", () => {
    const tasks = backgroundTasksOf({
      ...base,
      sessions: [session({ status: "idle" })],
      processes: [{ pid: 11, sessionId: "s1", command: "npm run dev", elapsedSecs: 30, ports: [5173] }],
    });
    expect(tasks).toEqual([
      {
        id: "process:11",
        kind: "process",
        name: "npm run dev",
        detail: "Alpha · localhost:5173",
        status: "Running",
        startedAt: 70_000,
        sessionId: "s1",
        pid: 11,
      },
    ]);
  });

  it("omits the session name when the session is unknown", () => {
    const tasks = backgroundTasksOf({
      ...base,
      sessions: [],
      processes: [{ pid: 12, sessionId: "gone", command: "sleep 9", elapsedSecs: 1, ports: [] }],
    });
    expect(tasks[0].detail).toBeUndefined();
  });

  it("sorts oldest first", () => {
    const tasks = backgroundTasksOf({
      ...base,
      sessions: [session({ createdAt: 90_000 })],
      processes: [{ pid: 1, sessionId: "s1", command: "a", elapsedSecs: 50, ports: [] }],
    });
    expect(tasks.map((t) => t.id)).toEqual(["process:1", "terminal:s1"]);
  });
});
