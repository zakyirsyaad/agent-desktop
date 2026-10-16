/**
 * Core type definitions for Agent Desktop GUI
 */

/** A reasoning-effort choice backed by a real CLI flag or env var. */
export interface EffortLevel {
  label: string;
  args: string[];
  env: [string, string][];
}

/** A permission mode the CLI supports; `"ask"` is always first and passes no args. */
export interface PermissionModeOption {
  id: string;
  label: string;
  args: string[];
}

/** How a session can be forked: resumed natively by the CLI, or via a handoff file. */
export type ForkSupport = 'native' | 'handoff';

/** Mirrors the Rust `AgentProfile` (snake_case on the wire). */
export interface AgentProfile {
  id: string;
  name: string;
  command: string;
  detected: boolean;
  detected_path?: string | null;
  models: string[];
  model_arg?: string | null;
  effort_levels: EffortLevel[];
  permission_modes: PermissionModeOption[];
  session_id_arg?: string | null;
  fork_support: ForkSupport | string;
  resume_fork_args: string[];
  approval_pattern?: string | null;
  approval_key?: string | null;
  reject_key?: string | null;
}

/** A `PermissionModeOption.id`; `"ask"` is the safe default every agent supports. */
export type PermissionMode = string;

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask';

/** What the backend's `spawn_session` accepts besides the profile id (camelCase). */
export interface SpawnOptions {
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  agentSessionId?: string;
  forkFromAgentSessionId?: string;
}

/** A project folder: `name` is shown in the UI, `path` is the absolute spawn cwd. */
export interface Workspace {
  name: string;
  path: string;
}

export interface SessionConfig {
  profileId: string;
  cwd: string;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
}

export interface Session {
  id: string;
  name: string;
  profileId: string;
  cwd: string;
  status: 'running' | 'idle' | 'waiting_approval' | 'terminated';
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  createdAt: number;
  endedAt?: number | null;
  exitCode?: number | null;
  forkedFrom?: string | null;
  agentSessionId?: string | null;
}

export interface Settings {
  defaultAgentId: string | null;
  onboardingCompleted: boolean;
}

export interface RecentFolder {
  name: string;
  path: string;
  lastOpenedAt: number;
}

/** Everything the backend store keeps in `state.json` (camelCase on the wire). */
export interface PersistedState {
  version: number;
  settings: Settings;
  recentFolders: RecentFolder[];
  sessions: Session[];
}

export interface ActionCard {
  id: string;
  sessionId: string;
  title: string;
  prompt: string;
  commandSnippet?: string;
  toolName?: string;
  status: 'pending' | 'approved' | 'rejected';
  approvalKey: string;
  rejectKey: string;
  timestamp: number;
}

export type ParsedStreamEventType =
  | 'text'
  | 'tool_start'
  | 'approval_request'
  | 'idle';

export interface ParsedStreamEvent {
  type: ParsedStreamEventType;
  content: string;
  metadata?: Record<string, string>;
}

export interface ToolExecution {
  id: string;
  name: string;
  args: string;
  status: 'running' | 'completed' | 'failed';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: number;
  tools?: ToolExecution[];
  actionCard?: ActionCard;
}

export interface PtyOutputPayload {
  session_id: string;
  data: string;
}

export interface PtyExitPayload {
  session_id: string;
  exit_code: number;
}
