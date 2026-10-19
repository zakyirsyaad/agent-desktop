import { describe, it, expect } from "vitest";
import {
  installHintFor,
  readyAgents,
  resolveDefaultAgentId,
  type AgentSummary,
} from "../lib/agent-readiness";

const claude: AgentSummary = { id: "claude-acp", name: "Claude Code", detected: true };
const omp: AgentSummary = { id: "omp", name: "Oh-My-Pi", detected: false };
const aider: AgentSummary = { id: "aider", name: "Aider", detected: true };

describe("readyAgents", () => {
  it("keeps only detected agents in their original order", () => {
    expect(readyAgents([omp, aider, claude]).map((agent) => agent.id)).toEqual([
      "aider",
      "claude-acp",
    ]);
  });
});

describe("resolveDefaultAgentId", () => {
  it("keeps the preferred agent when it is ready", () => {
    expect(resolveDefaultAgentId([claude, aider], "aider")).toBe("aider");
  });

  it("falls back to the first ready agent when the preferred one is not installed", () => {
    expect(resolveDefaultAgentId([omp, aider, claude], "omp")).toBe("aider");
  });

  it("returns null when no agent is ready", () => {
    expect(resolveDefaultAgentId([omp], null)).toBeNull();
  });
});

describe("installHintFor", () => {
  it("returns the verified install command for a known agent", () => {
    expect(installHintFor(claude)).toEqual({
      kind: "command",
      command: "npm install -g @anthropic-ai/claude-code",
    });
  });

  it("points unknown agents to their own documentation", () => {
    const custom: AgentSummary = { id: "custom", name: "Custom Agent", detected: false };

    expect(installHintFor(custom)).toEqual({
      kind: "docs",
      text: "See the Custom Agent documentation for install steps.",
    });
  });
});

describe("resolveDefaultAgentId with a candidate filter", () => {
  it("never picks an agent the filter rejects", () => {
    const isAider = (agent: AgentSummary) => agent.id === "aider";

    expect(resolveDefaultAgentId([claude, aider], "claude-acp", isAider)).toBe("aider");
    expect(resolveDefaultAgentId([claude], null, isAider)).toBeNull();
  });
});
