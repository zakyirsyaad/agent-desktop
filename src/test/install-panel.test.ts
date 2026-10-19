import { describe, it, expect } from "vitest";
import { installPanelAgentOf } from "../lib/install-panel";
import { makeProfile } from "./fixtures/agents";
import type { Session } from "../types";

const notInstalled = makeProfile({
  id: "codex-acp",
  name: "Codex",
  source: "registry",
  transport: "acp",
  detected: false,
  install_plan: [{ kind: "agent", name: "Codex", version: "0.4.2", download_bytes: null }],
});
const ready = makeProfile({ id: "qwen-code", name: "Qwen Code", transport: "acp", detected: true, install_plan: null });

function session(overrides: Partial<Session>): Session {
  return {
    id: "s-1",
    name: "Chat",
    profileId: "codex-acp",
    cwd: "/Users/test/project",
    status: "terminated",
    createdAt: 1,
    transport: "acp",
    ...overrides,
  } as Session;
}

describe("installPanelAgentOf", () => {
  it("shows the draft's agent when no session is open and it can be installed", () => {
    expect(installPanelAgentOf(undefined, undefined, notInstalled)).toBe(notInstalled);
    expect(installPanelAgentOf(undefined, undefined, ready)).toBeUndefined();
  });

  it("shows an ended chat's own agent, not the draft's", () => {
    expect(installPanelAgentOf(session({}), notInstalled, ready)).toBe(notInstalled);
    expect(installPanelAgentOf(session({}), ready, notInstalled)).toBeUndefined();
  });

  it("shows nothing over a running chat or a terminal session", () => {
    expect(installPanelAgentOf(session({ status: "running" }), notInstalled, notInstalled)).toBeUndefined();
    expect(installPanelAgentOf(session({ transport: "pty" }), notInstalled, notInstalled)).toBeUndefined();
  });
});
