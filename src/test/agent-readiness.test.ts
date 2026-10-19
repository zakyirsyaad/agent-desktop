import { describe, it, expect } from "vitest";
import {
  NODE_HINT,
  installHintFor,
  noAgentNotice,
  readyAgents,
  resolveDefaultAgentId,
  type AgentSummary,
} from "../lib/agent-readiness";

const claude: AgentSummary = { id: "claude-acp", name: "Claude Code", detected: true, distribution: "npx" };
const omp: AgentSummary = { id: "omp", name: "Oh-My-Pi", detected: false, distribution: null };
const aider: AgentSummary = { id: "aider", name: "Aider", detected: true, distribution: null };

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
  it("returns the verified install command for a terminal agent", () => {
    expect(installHintFor(aider)).toEqual({
      kind: "command",
      command: "python -m pip install aider-install && aider-install",
    });
  });

  it("points a registry npx agent at Node.js, which is all it needs", () => {
    const nodeHint = { kind: "docs", text: NODE_HINT };
    const gemini: AgentSummary = { id: "gemini", name: "Gemini CLI", detected: false, distribution: "npx" };

    expect(installHintFor(claude)).toEqual(nodeHint);
    expect(installHintFor(gemini)).toEqual(nodeHint);
    expect(NODE_HINT).toContain("Node.js 22");
    expect(NODE_HINT).toContain("https://nodejs.org");
  });

  it("goes by the distribution, not the agent id", () => {
    const binaryCodex: AgentSummary = { id: "codex-acp", name: "Codex", detected: false, distribution: "binary" };

    expect(installHintFor(binaryCodex)).toEqual({
      kind: "docs",
      text: "See the Codex documentation for install steps.",
    });
  });

  it("points unknown agents to their own documentation", () => {
    const custom: AgentSummary = { id: "custom", name: "Custom Agent", detected: false, distribution: null };

    expect(installHintFor(custom)).toEqual({
      kind: "docs",
      text: "See the Custom Agent documentation for install steps.",
    });
  });
});

describe("resolveDefaultAgentId takes the candidates as given", () => {
  it("has no filter of its own: callers pass only the agents to choose from", () => {
    // @ts-expect-error -- there is no third parameter; the list is already filtered.
    expect(resolveDefaultAgentId([claude, aider], "claude-acp", () => false)).toBe("claude-acp");
  });
});

describe("noAgentNotice", () => {
  const needsNode = (id: string, name: string): AgentSummary => ({ id, name, detected: false, distribution: "npx" });
  const codex = needsNode("codex-acp", "Codex");
  const qwen = needsNode("qwen-code", "Qwen Code");
  const kimi = needsNode("kimi", "Kimi CLI");
  const opencode: AgentSummary = { id: "opencode", name: "OpenCode", detected: false, distribution: "binary" };
  const NODE_TAIL = "Node.js 22 or later: install it from https://nodejs.org, then check again in Settings.";
  const GENERIC = "No agent is ready. Install one of your agents, then check again in Settings.";

  it("names one agent that needs Node.js", () => {
    expect(noAgentNotice([codex, opencode])).toBe(`No agent is ready. Codex needs ${NODE_TAIL}`);
  });

  it("joins two agents that need Node.js with and", () => {
    expect(noAgentNotice([kimi, opencode, codex])).toBe(`No agent is ready. Kimi CLI and Codex need ${NODE_TAIL}`);
  });

  it("joins three or more agents with commas and a final and", () => {
    expect(noAgentNotice([needsNode("claude-acp", "Claude Code"), codex, qwen])).toBe(
      `No agent is ready. Claude Code, Codex and Qwen Code need ${NODE_TAIL}`,
    );
  });

  it("leaves out npx agents that are ready", () => {
    expect(noAgentNotice([claude, codex])).toBe(`No agent is ready. Codex needs ${NODE_TAIL}`);
  });

  it("asks to install an agent when none of them needs Node.js", () => {
    expect(noAgentNotice([opencode, omp])).toBe(GENERIC);
  });

  it("asks to install an agent when there are no agents in use", () => {
    expect(noAgentNotice([])).toBe(GENERIC);
  });
});
