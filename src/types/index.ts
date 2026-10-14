/**
 * Core type definitions for Agent Desktop GUI
 */

export interface AgentProfile {
  id: string;
  name: string;
  command: string;
  detected: boolean;
  detected_path?: string | null;
  models: string[];
  model_arg?: string | null;
  effort_levels: string[];
  effort_env?: string | null;
  approval_pattern?: string | null;
  approval_key?: string | null;
  reject_key?: string | null;
}

export type PermissionMode = 'bypass' | 'ask';

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
  pid?: number | null;
  model?: string;
  effort?: string;
  permissionMode?: PermissionMode;
  createdAt: number;
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
