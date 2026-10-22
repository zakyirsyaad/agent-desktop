import { describe, it, expect } from "vitest";
import { backgroundTasksOf, formatElapsed, runningToolTasks } from "../lib/background-tasks";
import type { ChatMessage, Session, ToolExecution } from "../types";

function session(over: Partial<Session>): Session {
  return { id: "s1", name: "Alpha", profileId: "p", cwd: "/w", status: "running", createdAt: 500, ...over };
}

function message(tools: ToolExecution[], over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "m1", role: "agent", content: "", timestamp: 80_000, tools, ...over };
}

const base = {
  isBusy: () => false,
  busySince: () => undefined,
  needsApproval: () => false,
  transcripts: {},
  processes: [],
  processesReadAt: 100_000,
};

describe("formatElapsed", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(133_000)).toBe("2m 13s");
    expect(formatElapsed(3_840_000)).toBe("1h 04m");
  });
});

describe("runningToolTasks", () => {
  it("lists a running shell tool by its title", () => {
    const tasks = runningToolTasks(
      {
        s1: [
          message([
            {
              id: "t1",
              name: "pnpm test:unit",
              status: "running",
              kind: "execute",
              startedAt: 70_000,
            },
          ]),
        ],
      },
      [session({})],
    );

    expect(tasks).toEqual([
      {
        id: "tool:s1:t1",
        kind: "shell",
        name: "pnpm test:unit",
        detail: "Alpha",
        status: "Running",
        startedAt: 70_000,
        sessionId: "s1",
        toolId: "t1",
      },
    ]);
  });

  it("lists a running subagent from the agent's own tool name", () => {
    const tasks = runningToolTasks(
      {
        s1: [
          message([
            {
              id: "t1",
              name: "Explore the auth module",
              status: "running",
              kind: "think",
              providerToolName: "Task",
              startedAt: 70_000,
            },
          ]),
        ],
      },
      [session({})],
    );

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: "subagent", name: "Explore the auth module" });
  });

  it("lists a subagent by a title that names it, for older adapters", () => {
    const tasks = runningToolTasks(
      { s1: [message([{ id: "t1", name: "Agent: audit the migrations", status: "running", kind: "other" }])] },
      [session({})],
    );

    expect(tasks[0]).toMatchObject({ kind: "subagent", name: "Agent: audit the migrations" });
  });

  it("does not list plain reasoning or a finished tool", () => {
    const tasks = runningToolTasks(
      {
        s1: [
          message([
            { id: "t1", name: "Thinking", status: "running", kind: "think" },
            { id: "t2", name: "pnpm test", status: "completed", kind: "execute" },
            { id: "t3", name: "Read src/App.tsx", status: "running", kind: "read" },
          ]),
        ],
      },
      [session({})],
    );

    expect(tasks).toEqual([]);
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

  it("lists processes as shell tasks with the session name and ports", () => {
    const tasks = backgroundTasksOf({
      ...base,
      sessions: [session({ status: "idle" })],
      processes: [{ pid: 11, sessionId: "s1", command: "npm run dev", elapsedSecs: 30, ports: [5173] }],
    });
    expect(tasks).toEqual([
      {
        id: "process:11",
        kind: "shell",
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

  it("lists a running shell tool while no process is known yet", () => {
    const tasks = backgroundTasksOf({
      ...base,
      sessions: [session({})],
      transcripts: {
        s1: [message([{ id: "t1", name: "pnpm test:unit", status: "running", kind: "execute", startedAt: 90_000 }])],
      },
    });

    expect(tasks).toEqual([expect.objectContaining({ kind: "shell", name: "pnpm test:unit", toolId: "t1" })]);
  });

  it("lists a shell tool and its process once, keeping the process row", () => {
    const tasks = backgroundTasksOf({
      ...base,
      sessions: [session({})],
      transcripts: {
        s1: [message([{ id: "t1", name: "pnpm test:unit", status: "running", kind: "execute", startedAt: 90_000 }])],
      },
      processes: [{ pid: 11, sessionId: "s1", command: "pnpm test:unit", elapsedSecs: 5, ports: [] }],
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: "process:11", kind: "shell", pid: 11 });
  });

  it("matches a process started while its tool ran, even when the titles differ", () => {
    const tasks = backgroundTasksOf({
      ...base,
      sessions: [session({})],
      transcripts: {
        s1: [message([{ id: "t1", name: "Run the unit tests", status: "running", kind: "execute", startedAt: 90_000 }])],
      },
      processes: [{ pid: 11, sessionId: "s1", command: "node /app/pnpm test:unit", elapsedSecs: 5, ports: [] }],
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("process:11");
  });

  it("keeps a background command after its tool call completed", () => {
    const tasks = backgroundTasksOf({
      ...base,
      sessions: [session({})],
      transcripts: {
        s1: [message([{ id: "t1", name: "next dev", status: "completed", kind: "execute", startedAt: 90_000 }])],
      },
      processes: [{ pid: 11, sessionId: "s1", command: "node next dev", elapsedSecs: 30, ports: [3000] }],
    });

    expect(tasks).toEqual([expect.objectContaining({ id: "process:11" })]);
  });

  it("does not match a process to a tool in another session", () => {
    const tasks = backgroundTasksOf({
      ...base,
      sessions: [session({ id: "s1" }), session({ id: "s2", name: "Beta" })],
      transcripts: {
        s1: [message([{ id: "t1", name: "pnpm test:unit", status: "running", kind: "execute", startedAt: 90_000 }])],
        s2: [],
      },
      processes: [{ pid: 11, sessionId: "s2", command: "pnpm test:unit", elapsedSecs: 5, ports: [] }],
    });

    expect(tasks.map((t) => t.id)).toEqual(["tool:s1:t1", "process:11"]);
  });

  it("sorts oldest first", () => {
    const tasks = backgroundTasksOf({
      ...base,
      sessions: [session({ transport: "acp" })],
      isBusy: () => true,
      busySince: () => 90_000,
      processes: [{ pid: 1, sessionId: "s1", command: "a", elapsedSecs: 50, ports: [] }],
    });
    expect(tasks.map((t) => t.id)).toEqual(["process:1", "agent:s1"]);
  });
});