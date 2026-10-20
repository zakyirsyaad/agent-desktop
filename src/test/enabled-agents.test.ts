import { describe, it, expect } from "vitest";
import {
  DEFAULT_ENABLED_AGENTS,
  enabledAgentIds,
  isInUse,
  removedAgentNameFor,
  withAutoEnabled,
} from "../lib/enabled-agents";
import type { Settings } from "../types";
import { aiderProfile, claudeProfile, makeProfile } from "./fixtures/agents";

const BASE: Settings = { appearance: "system", defaultAgentId: null, onboardingCompleted: true };

const gemini = makeProfile({
  id: "gemini",
  name: "Gemini CLI",
  source: "registry",
  version: "1.2.3",
  installed_on_system: true,
});

describe("enabled agents", () => {
  it("uses the defaults until the user changes the list", () => {
    expect(enabledAgentIds(BASE)).toEqual(DEFAULT_ENABLED_AGENTS);
    expect(enabledAgentIds({ ...BASE, enabledAgents: ["gemini"] })).toEqual(["gemini"]);
    expect(isInUse(claudeProfile, BASE)).toBe(true);
    expect(isInUse(gemini, BASE)).toBe(false);
  });

  it("enables an agent found installed on the system once", () => {
    const next = withAutoEnabled(BASE, [gemini]);

    expect(next.enabledAgents).toEqual([...DEFAULT_ENABLED_AGENTS, "gemini"]);
    expect(isInUse(gemini, next)).toBe(true);
  });

  it("does not re-enable an agent the user removed", () => {
    const settings = { ...BASE, enabledAgents: ["claude-acp"], removedAgents: ["gemini"] };

    expect(withAutoEnabled(settings, [gemini])).toBe(settings);
  });

  it("records the version of each agent in use", () => {
    const next = withAutoEnabled(
      { ...BASE, enabledAgents: ["gemini"], agentVersions: { other: "9.9.9" } },
      [gemini],
    );

    expect(next.agentVersions).toEqual({ other: "9.9.9", gemini: "1.2.3" });
  });

  it("never overwrites a recorded version", () => {
    const settings = { ...BASE, enabledAgents: ["gemini"], agentVersions: { gemini: "1.0.0" } };

    expect(withAutoEnabled(settings, [gemini])).toBe(settings);
  });

  it("returns the same settings when nothing changes", () => {
    const first = withAutoEnabled(BASE, [gemini, claudeProfile]);

    expect(withAutoEnabled(first, [gemini, claudeProfile])).toBe(first);
    expect(withAutoEnabled(BASE, [aiderProfile])).toBe(BASE);
  });

  it("leaves the enabled list unset when it only records versions", () => {
    const next = withAutoEnabled(BASE, [{ ...claudeProfile, version: "0.93.0" }]);

    expect(next.agentVersions).toEqual({ "claude-acp": "0.93.0" });
    expect(next.enabledAgents).toBeUndefined();
    expect("enabledAgents" in next).toBe(false);
  });

  it("keeps the enabled list as it was when it only records versions", () => {
    const next = withAutoEnabled({ ...BASE, enabledAgents: ["gemini"] }, [{ ...gemini, installed_on_system: false }]);

    expect(next.enabledAgents).toEqual(["gemini"]);
    expect(next.agentVersions).toEqual({ gemini: "1.2.3" });
  });

  it("a builtin terminal agent is in use when detected", () => {
    expect(isInUse({ ...aiderProfile, detected: true }, BASE)).toBe(true);
    expect(isInUse({ ...aiderProfile, detected: false }, BASE)).toBe(false);
  });
});

describe("removedAgentNameFor", () => {
  const removed: Settings = { ...BASE, enabledAgents: ["claude-acp"], removedAgents: ["gemini"] };

  it("names a removed agent for a session that is not running", () => {
    expect(removedAgentNameFor({ profileId: "gemini", status: "terminated" }, [gemini], removed)).toBe("Gemini CLI");
  });

  it("names nothing while the session still runs, so its composer keeps Stop", () => {
    expect(removedAgentNameFor({ profileId: "gemini", status: "running" }, [gemini], removed)).toBeNull();
  });

  it("names nothing without a session or for an agent in use", () => {
    expect(removedAgentNameFor(undefined, [gemini], removed)).toBeNull();
    expect(removedAgentNameFor({ profileId: "claude-acp", status: "terminated" }, [claudeProfile], removed)).toBeNull();
  });
});
