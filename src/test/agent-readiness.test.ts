import { describe, it, expect } from "vitest";
import {
  INSTALLABLE_HINT,
  NODE_HINT,
  installHintFor,
  isAgentRunnable,
  noAgentNotice,
  readyAgents,
  resolveDefaultAgentId,
  resolveDraftAgentId,
  resolveUsableAgentId,
  type AgentSummary,
} from "../lib/agent-readiness";

const claude: AgentSummary = { id: "claude-acp", name: "Claude Code", detected: true, distribution: "npx" };
const omp: AgentSummary = { id: "omp", name: "Oh-My-Pi", detected: false, distribution: null };
const aider: AgentSummary = { id: "aider", name: "Aider", detected: true, distribution: null };

describe("isAgentRunnable", () => {
  it("is true only when the backend says the agent can start now", () => {
    expect(isAgentRunnable({ availability: "ready" })).toBe(true);
    expect(isAgentRunnable({ availability: "needs_runtime" })).toBe(false);
  });
});

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

  it("points an agent whose Install sets up Node.js at Node.js", () => {
    const nodeHint = { kind: "docs", text: NODE_HINT };
    const gemini: AgentSummary = {
      id: "gemini",
      name: "Gemini CLI",
      detected: false,
      distribution: "npx",
      install_plan: [nodeStep],
    };

    expect(installHintFor(gemini)).toEqual(nodeHint);
    expect(NODE_HINT).toContain("Node.js 22 or newer");
    expect(NODE_HINT).toContain("Zorvo installs it");
    expect(NODE_HINT).not.toContain("https://nodejs.org");
  });

  it("goes by the install plan, not the distribution: an npx agent missing only a prerequisite", () => {
    const piAcp: AgentSummary = {
      id: "pi-acp",
      name: "pi ACP",
      detected: false,
      distribution: "npx",
      install_plan: [{ kind: "prerequisite", name: "pi", version: "0.9.0", download_bytes: null }],
    };

    expect(installHintFor(piAcp)).toEqual({ kind: "docs", text: INSTALLABLE_HINT });
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

const nodeStep = { kind: "node", name: "Node.js", version: "24.11.1", download_bytes: null } as const;

describe("noAgentNotice", () => {
  const needsNode = (id: string, name: string): AgentSummary => ({
    id,
    name,
    detected: false,
    distribution: "npx",
    install_plan: [nodeStep],
  });
  const codex = needsNode("codex-acp", "Codex");
  const qwen = needsNode("qwen-code", "Qwen Code");
  const kimi = needsNode("kimi", "Kimi CLI");
  const opencode: AgentSummary = {
    id: "opencode",
    name: "OpenCode",
    detected: false,
    distribution: "binary",
    install_plan: [{ kind: "agent", name: "OpenCode", version: "1.19.3", download_bytes: null }],
  };
  const NODE_TAIL = "Node.js 22 or newer, which Zorvo installs for you.";
  const GENERIC = "No agent is ready. Install one of your agents, then check again in Settings.";

  it("names one agent that needs Node.js and points at Install", () => {
    expect(noAgentNotice([codex, omp])).toBe(`No agent is ready. Codex needs ${NODE_TAIL} Click Install to set it up.`);
  });

  it("asks to choose when other agents can be installed too, even if only one needs Node.js", () => {
    expect(noAgentNotice([codex, opencode])).toBe(`No agent is ready. Codex needs ${NODE_TAIL} Choose one and click Install.`);
  });

  it("does not say Node.js for an npx agent that only misses a prerequisite", () => {
    const piAcp: AgentSummary = {
      id: "pi-acp",
      name: "pi ACP",
      detected: false,
      distribution: "npx",
      install_plan: [{ kind: "prerequisite", name: "pi", version: "0.9.0", download_bytes: null }],
    };

    expect(noAgentNotice([piAcp])).toBe("No agent is ready. pi ACP is not installed yet. Click Install to set it up.");
  });

  it("joins two agents that need Node.js with and", () => {
    expect(noAgentNotice([kimi, opencode, codex])).toBe(
      `No agent is ready. Kimi CLI and Codex need ${NODE_TAIL} Choose one and click Install.`,
    );
  });

  it("joins three or more agents with commas and a final and", () => {
    expect(noAgentNotice([needsNode("claude-acp", "Claude Code"), codex, qwen])).toBe(
      `No agent is ready. Claude Code, Codex and Qwen Code need ${NODE_TAIL} Choose one and click Install.`,
    );
  });

  it("never sends the user to install Node.js themselves", () => {
    expect(noAgentNotice([codex])).not.toContain("nodejs.org");
  });

  it("leaves out npx agents that are ready", () => {
    expect(noAgentNotice([{ ...claude, install_plan: null }, codex])).toBe(
      `No agent is ready. Codex needs ${NODE_TAIL} Click Install to set it up.`,
    );
  });

  it("names the agents Zorvo can install when none of them needs Node.js", () => {
    expect(noAgentNotice([opencode, omp])).toBe(
      "No agent is ready. OpenCode is not installed yet. Click Install to set it up.",
    );
  });

  it("asks to install an agent when Zorvo cannot install any of them", () => {
    const npxWithoutPlan: AgentSummary = { id: "gemini", name: "Gemini CLI", detected: false, distribution: "npx" };
    expect(noAgentNotice([npxWithoutPlan, omp])).toBe(GENERIC);
  });

  it("asks to install an agent when there are no agents in use", () => {
    expect(noAgentNotice([])).toBe(GENERIC);
  });
});

const codexToInstall: AgentSummary = {
  id: "codex-acp",
  name: "Codex",
  detected: false,
  distribution: "npx",
  install_plan: [nodeStep],
};
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
