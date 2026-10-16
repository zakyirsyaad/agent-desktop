import type { AgentProfile } from "../../types";

/** Builds an agent profile with every required field, overriding only what a test cares about. */
export function makeProfile(overrides: Partial<AgentProfile> & Pick<AgentProfile, "id" | "name">): AgentProfile {
  return {
    command: overrides.id,
    detected: false,
    detected_path: null,
    models: [],
    model_arg: null,
    effort_levels: [],
    permission_modes: [{ id: "ask", label: "Ask every time", args: [] }],
    session_id_arg: null,
    fork_support: "handoff",
    resume_fork_args: [],
    approval_pattern: null,
    approval_key: null,
    reject_key: null,
    ...overrides,
  };
}

/** Shaped like the real Claude Code profile the backend reports. */
export const claudeProfile = makeProfile({
  id: "claude-code",
  name: "Claude Code",
  command: "claude",
  detected: true,
  detected_path: "/opt/homebrew/bin/claude",
  models: ["opus", "sonnet", "haiku"],
  model_arg: "--model",
  effort_levels: [
    { label: "low", args: ["--effort", "low"], env: [] },
    { label: "medium", args: ["--effort", "medium"], env: [] },
    { label: "high", args: ["--effort", "high"], env: [] },
  ],
  permission_modes: [
    { id: "ask", label: "Ask every time", args: [] },
    { id: "bypass", label: "Bypass permissions", args: ["--permission-mode", "bypassPermissions"] },
    { id: "plan", label: "Plan mode", args: ["--permission-mode", "plan"] },
  ],
  session_id_arg: "--session-id",
  fork_support: "native",
  resume_fork_args: ["--resume", "{session_id}", "--fork-session"],
});

export const ompProfile = makeProfile({
  id: "omp",
  name: "Oh-My-Pi",
  command: "omp",
  detected: true,
  detected_path: "/usr/local/bin/omp",
  effort_levels: [{ label: "high", args: ["--thinking=high"], env: [] }],
  permission_modes: [
    { id: "ask", label: "Always ask", args: [] },
    { id: "bypass", label: "Bypass approvals", args: ["--approval-mode=yolo"] },
  ],
});

export const aiderProfile = makeProfile({
  id: "aider",
  name: "Aider",
  command: "aider",
  detected: false,
});

export const fakeProfiles: AgentProfile[] = [claudeProfile, ompProfile, aiderProfile];
