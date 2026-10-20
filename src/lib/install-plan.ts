import type { AgentProfile, InstallStep } from '../types';
import { isAgentRunnable } from './agent-readiness';

const BYTES_PER_MB = 1_048_576;

/** What the installer is doing within one step, as `agent-install-progress` reports it. */
export type InstallPhase = 'download' | 'verify' | 'unpack' | 'npm';

function describeStep(step: InstallStep): string {
  const size = step.download_bytes === null ? '' : ` (${Math.round(step.download_bytes / BYTES_PER_MB)} MB)`;
  return `${step.name} ${step.version}${size}`;
}

/** "Node.js 24.11.1 (49 MB), pi 0.9.0 and OpenCode 1.19.3": what Install would put on the machine. */
export function describePlan(steps: readonly InstallStep[]): string {
  const parts = steps.map(describeStep);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const PHASE_LINES: Record<InstallPhase, (name: string) => string> = {
  download: (name) => `Downloading ${name}…`,
  verify: (name) => `Checking ${name}…`,
  unpack: (name) => `Unpacking ${name}…`,
  npm: (name) => `Installing ${name} with npm…`,
};

/** The line under the progress bar for the step the installer is on. */
export function describePhase(phase: InstallPhase, name: string): string {
  return PHASE_LINES[phase](name);
}

/** How the new-session agent picker names an agent: one not ready yet says so. */
export function pickerLabelOf(agent: Pick<AgentProfile, 'name' | 'availability'>): string {
  return isAgentRunnable(agent) ? agent.name : `${agent.name} (not installed)`;
}
