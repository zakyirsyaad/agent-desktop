import { describe, it, expect } from "vitest";
import {
  catalogSections,
  formatAvailableFrom,
  formatCheckedAgo,
  matchesQuery,
  pendingUpdates,
  rowActions,
  statusLine,
  withAgentAdded,
  withAgentRemoved,
} from "../lib/agent-catalog";
import { makeCatalogAgent } from "./fixtures/catalog";
import type { InstallStep, Settings } from "../types";

const settings: Settings = { appearance: "system", defaultAgentId: null, onboardingCompleted: true };
const ids = (agents: { id: string }[]) => agents.map((a) => a.id);

describe("catalogSections", () => {
  it("puts an in-use agent with an update first, then sorts by name", () => {
    const agents = [
      makeCatalogAgent({ id: "b", name: "Beta" }),
      makeCatalogAgent({ id: "a", name: "Alpha" }),
      makeCatalogAgent({ id: "c", name: "Zeta", updateVersion: "2.0.0" }),
    ];
    expect(ids(catalogSections(agents, ["a", "b", "c"], "").inUse)).toEqual(["c", "a", "b"]);
  });

  it("orders others: installed first, waiting and unsupported last", () => {
    const agents = [
      makeCatalogAgent({ id: "w", name: "Aaa", status: "waiting" }),
      makeCatalogAgent({ id: "u", name: "Bbb", status: "unsupported" }),
      makeCatalogAgent({ id: "n", name: "Ccc", status: "not_installed" }),
      makeCatalogAgent({ id: "m", name: "Ddd", status: "on_your_mac" }),
      makeCatalogAgent({ id: "z", name: "Eee", status: "by_zorvo" }),
      makeCatalogAgent({ id: "r", name: "Fff", status: "ready" }),
    ];
    expect(ids(catalogSections(agents, [], "").others)).toEqual(["m", "z", "n", "r", "w", "u"]);
  });

  it("filters both sections by query, ignoring case and outer spaces", () => {
    const agents = [
      makeCatalogAgent({ id: "gemini", name: "Gemini CLI" }),
      makeCatalogAgent({ id: "x", name: "Other", description: "A gem of an agent" }),
      makeCatalogAgent({ id: "y", name: "Nope" }),
      makeCatalogAgent({ id: "g2", name: "Gemstone" }),
    ];
    const { inUse, others } = catalogSections(agents, ["g2", "y"], "  GEM ");
    expect(ids(inUse)).toEqual(["g2"]);
    expect(ids(others)).toEqual(["gemini", "x"]);
  });
});

describe("matchesQuery", () => {
  it("matches everything for a blank query and the id", () => {
    const agent = makeCatalogAgent({ id: "opencode", name: "OpenCode" });
    expect(matchesQuery(agent, "   ")).toBe(true);
    expect(matchesQuery(agent, "CODE")).toBe(true);
    expect(matchesQuery(agent, "zzz")).toBe(false);
  });
});

describe("statusLine", () => {
  const plan: InstallStep[] = [
    { kind: "node", name: "Node.js", version: "24.11.1", download_bytes: 52_428_800 },
    { kind: "agent", name: "OpenCode", version: "1.19.3", download_bytes: null },
  ];

  it("describes each status", () => {
    expect(statusLine(makeCatalogAgent({ id: "a", name: "A", status: "by_zorvo" }), null)).toBe("Installed by Zorvo");
    expect(
      statusLine(makeCatalogAgent({ id: "a", name: "A", status: "on_your_mac", location: "/opt/homebrew/bin/opencode" }), null),
    ).toBe("Managed outside Zorvo · /opt/homebrew/bin/opencode");
    expect(statusLine(makeCatalogAgent({ id: "a", name: "A", status: "on_your_mac" }), null)).toBe("Installed on your Mac");
    expect(statusLine(makeCatalogAgent({ id: "a", name: "A", status: "ready", distribution: "npx" }), null)).toBe("Runs with npx");
    expect(statusLine(makeCatalogAgent({ id: "a", name: "A", status: "ready", distribution: "uvx" }), null)).toBe("Runs with uvx");
    expect(statusLine(makeCatalogAgent({ id: "a", name: "A", status: "not_installed" }), null)).toBe("Not installed");
    expect(statusLine(makeCatalogAgent({ id: "a", name: "A", status: "not_installed" }), [])).toBe("Not installed");
    expect(statusLine(makeCatalogAgent({ id: "a", name: "A", status: "not_installed" }), plan)).toBe(
      "Not installed · Add installs Node.js 24.11.1 (50 MB) and OpenCode 1.19.3",
    );
    expect(statusLine(makeCatalogAgent({ id: "a", name: "A", status: "not_installed" }), plan, true)).toBe(
      "Not installed · Install adds Node.js 24.11.1 (50 MB) and OpenCode 1.19.3",
    );
    expect(
      statusLine(makeCatalogAgent({ id: "a", name: "A", status: "waiting", availableFrom: Date.UTC(2026, 9, 27, 12) / 1000 }), null),
    ).toBe("Available from Oct 27");
    expect(statusLine(makeCatalogAgent({ id: "a", name: "A", status: "unsupported" }), null)).toBe("Not available for this Mac");
  });

  it("appends the unlisted note", () => {
    expect(statusLine(makeCatalogAgent({ id: "a", name: "A", status: "by_zorvo", listed: false }), null)).toBe(
      "Installed by Zorvo · No longer listed",
    );
  });
});

describe("rowActions", () => {
  it("follows the table", () => {
    const a = (over: Parameters<typeof makeCatalogAgent>[0]) => makeCatalogAgent(over);
    const base = { id: "a", name: "A" };
    expect(rowActions(a({ ...base, status: "on_your_mac", distribution: "binary", location: "/x" }), true)).toEqual({
      add: false,
      install: false,
      update: false,
      remove: true,
    });
    expect(rowActions(a({ ...base, status: "waiting" }), false)).toEqual({ add: false, install: false, update: false, remove: false });
    expect(rowActions(a({ ...base, status: "waiting" }), true)).toEqual({ add: false, install: false, update: false, remove: true });
    expect(rowActions(a({ ...base, status: "unsupported" }), true).remove).toBe(true);
    expect(rowActions(a({ ...base, status: "by_zorvo", updateVersion: "2" }), true)).toEqual({ add: false, install: false, update: true, remove: true });
    expect(rowActions(a({ ...base, status: "by_zorvo", updateVersion: "2" }), false)).toEqual({ add: true, install: false, update: false, remove: false });
    expect(rowActions(a({ ...base, status: "by_zorvo" }), true).update).toBe(false);
    expect(rowActions(a({ ...base, status: "ready", updateVersion: "2" }), true).update).toBe(true);
    expect(rowActions(a({ ...base, status: "not_installed" }), false)).toEqual({ add: true, install: false, update: false, remove: false });
    expect(rowActions(a({ ...base, status: "not_installed" }), true)).toEqual({ add: false, install: true, update: false, remove: true });
    expect(rowActions(a({ ...base, status: "on_your_mac", location: null, updateVersion: "2" }), true)).toEqual({
      add: false,
      install: false,
      update: true,
      remove: true,
    });
  });
});

describe("withAgentAdded / withAgentRemoved", () => {
  const current = ["claude-acp", "codex-acp", "qwen-code"];

  it("writes the full list and clears the removal, without touching the input", () => {
    const input: Settings = { ...settings, removedAgents: ["gemini", "x"] };
    const next = withAgentAdded(input, "gemini", current);
    expect(next.enabledAgents).toEqual(["claude-acp", "codex-acp", "qwen-code", "gemini"]);
    expect(next.removedAgents).toEqual(["x"]);
    expect(next).not.toBe(input);
    expect(input.enabledAgents).toBeUndefined();
    expect(input.removedAgents).toEqual(["gemini", "x"]);
  });

  it("does not duplicate an agent already enabled", () => {
    expect(withAgentAdded(settings, "qwen-code", current).enabledAgents).toEqual(current);
  });

  it("drops the id, records the removal once and clears a default that pointed at it", () => {
    const input: Settings = { ...settings, defaultAgentId: "codex-acp", removedAgents: ["codex-acp"] };
    const next = withAgentRemoved(input, "codex-acp", current);
    expect(next.enabledAgents).toEqual(["claude-acp", "qwen-code"]);
    expect(next.removedAgents).toEqual(["codex-acp"]);
    expect(next.defaultAgentId).toBeNull();
    expect(input.defaultAgentId).toBe("codex-acp");
  });

  it("keeps another default", () => {
    const next = withAgentRemoved({ ...settings, defaultAgentId: "claude-acp" }, "codex-acp", current);
    expect(next.defaultAgentId).toBe("claude-acp");
    expect(next.removedAgents).toEqual(["codex-acp"]);
  });
});

describe("pendingUpdates", () => {
  it("returns only in-use agents with an update", () => {
    const agents = [
      makeCatalogAgent({ id: "a", name: "A", updateVersion: "2" }),
      makeCatalogAgent({ id: "b", name: "B", updateVersion: "2" }),
      makeCatalogAgent({ id: "c", name: "C" }),
    ];
    expect(ids(pendingUpdates(agents, ["a", "c"]))).toEqual(["a"]);
  });
});

describe("time formatting", () => {
  it("formats the availability date", () => {
    expect(formatAvailableFrom(Date.UTC(2026, 9, 27, 12) / 1000)).toBe("Oct 27");
  });

  it("formats how long ago a check ran", () => {
    const now = 1_000_000;
    expect(formatCheckedAgo(now - 2 * 3600, now)).toBe("2 hours ago");
    expect(formatCheckedAgo(now - 3 * 86400, now)).toBe("3 days ago");
    expect(formatCheckedAgo(now - 5, now)).toBe("just now");
    expect(formatCheckedAgo(now - 90, now)).toBe("1 minute ago");
  });
});
