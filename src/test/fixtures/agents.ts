import type { AgentProfile } from "../../types";

/** Builds an agent profile with every required field, overriding only what a test cares about. */
export function makeProfile(overrides: Partial<AgentProfile> & Pick<AgentProfile, "id" | "name">): AgentProfile {
  return {
    command: overrides.id,
    detected: false,
    detected_path: null,
    acp_program: null,
    acp_args: [],
    acp_program_path: null,
    source: "builtin",
    version: null,
    distribution: null,
    availability: "ready",
    install_plan: null,
    description: null,
    installed_on_system: false,
    listed: true,
    ...overrides,
  };
}

/** Shaped like the real Claude Code profile the backend reports. */
export const claudeProfile = makeProfile({
  id: "claude-acp",
  source: "registry",
  distribution: "npx",
  name: "Claude Code",
  command: "claude",
  detected: true,
  detected_path: "/opt/homebrew/bin/claude",
});

/** Shaped like the real Qwen Code profile: everything comes from the ACP session. */
export const qwenProfile = makeProfile({
  id: "qwen-code",
  source: "registry",
  distribution: "npx",
  name: "Qwen Code",
  command: "qwen",
  detected: true,
  detected_path: "/Users/test/.local/bin/qwen",
  acp_program: "qwen",
  acp_args: ["--acp"],
  acp_program_path: "/Users/test/.local/bin/qwen",
});

export const fakeProfiles: AgentProfile[] = [claudeProfile, qwenProfile];
