import { describe, it, expect } from "vitest";
import {
  INSTALLABLE_HINT,
  NODE_HINT,
  installHintFor,
  readyAgents,
  resolveDefaultAgentId,
  resolveDraftAgentId,
  resolveUsableAgentId,
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
    expect(installHintFor({ id: "codex-acp", name: "Codex", detected: false })).toEqual(nodeHint);
    expect(installHintFor({ id: "qwen-code", name: "Qwen Code", detected: false })).toEqual(nodeHint);
    expect(installHintFor(gemini)).toEqual(nodeHint);
    expect(NODE_HINT).toContain("Node.js 22");
    expect(NODE_HINT).toContain("Zorvo installs it");
    expect(NODE_HINT).not.toContain("https://nodejs.org");
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

const nodeStep = { kind: "node", name: "Node.js", version: "24.11.1", download_bytes: null } as const;
const codexToInstall: AgentSummary = { id: "codex-acp", name: "Codex", detected: false, install_plan: [nodeStep] };
const opencodeToInstall: AgentSummary = {
  id: "opencode",
  name: "OpenCode",
  detected: false,
  distribution: "binary",
  install_plan: [{ kind: "agent", name: "OpenCode", version: "1.19.3", download_bytes: null }],
};

describe("resolveDraftAgentId", () => {
  it("keeps the ready default over an offered agent", () => {
    expect(resolveDraftAgentId([codexToInstall, claude], null, [codexToInstall, claude])).toBe("claude-acp");
  });

  it("falls back to the preferred, else the first, offered agent when none is ready", () => {
    const offered = [codexToInstall, opencodeToInstall];
    expect(resolveDraftAgentId(offered, "opencode", offered)).toBe("opencode");
    expect(resolveDraftAgentId(offered, null, offered)).toBe("codex-acp");
    expect(resolveDraftAgentId(offered, null, [])).toBeNull();
  });
});

describe("resolveUsableAgentId", () => {
  it("keeps a preferred agent Zorvo can install, else picks a ready one first", () => {
    expect(resolveUsableAgentId([codexToInstall, claude], "codex-acp")).toBe("codex-acp");
    expect(resolveUsableAgentId([codexToInstall, claude], null)).toBe("claude-acp");
    expect(resolveUsableAgentId([codexToInstall, omp], "omp")).toBe("codex-acp");
    expect(resolveUsableAgentId([omp], null)).toBeNull();
  });
});

describe("installHintFor an agent Zorvo can install", () => {
  it("says Install does it", () => {
    expect(installHintFor(opencodeToInstall)).toEqual({ kind: "docs", text: INSTALLABLE_HINT });
  });
});
