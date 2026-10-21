import type { CatalogAgent, CatalogStatus, InstallStep, Settings } from '../types';
import { describePlan } from './install-plan';
import type { InstallStatus } from './agent-installs';

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY = 86_400;

/** Case-insensitive match of the trimmed query against name, id and description. */
export function matchesQuery(agent: CatalogAgent, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [agent.name, agent.id, agent.description ?? ''].some((text) => text.toLowerCase().includes(needle));
}

const OTHERS_RANK: Record<CatalogStatus, number> = {
  by_zorvo: 0,
  on_your_mac: 0,
  ready: 1,
  not_installed: 1,
  waiting: 2,
  unsupported: 2,
};

const byName = (a: CatalogAgent, b: CatalogAgent) => a.name.localeCompare(b.name);

/** Agents in use (updates first) and the rest (installed first, unavailable last), both filtered by `query`. */
export function catalogSections(
  agents: readonly CatalogAgent[],
  enabledIds: readonly string[],
  query: string,
): { inUse: CatalogAgent[]; others: CatalogAgent[] } {
  const shown = agents.filter((agent) => matchesQuery(agent, query));
  const inUse = shown
    .filter((agent) => enabledIds.includes(agent.id))
    .sort((a, b) => Number(b.updateVersion !== null) - Number(a.updateVersion !== null) || byName(a, b));
  const others = shown
    .filter((agent) => !enabledIds.includes(agent.id))
    .sort((a, b) => OTHERS_RANK[a.status] - OTHERS_RANK[b.status] || byName(a, b));
  return { inUse, others };
}

/** How an agent's install or update is going, for its status line. */
export interface InstallLine {
  status: InstallStatus;
  action: 'install' | 'update';
  error: string | null;
}

function baseStatusLine(agent: CatalogAgent, plan: readonly InstallStep[] | null, isInUse: boolean): string {
  switch (agent.status) {
    case 'by_zorvo':
      return 'Installed by Zorvo';
    case 'on_your_mac':
      return agent.location === null ? 'Installed on your Mac' : `Managed outside Zorvo · ${agent.location}`;
    case 'ready':
      return `Runs with ${agent.distribution}`;
    case 'not_installed':
      if (plan === null || plan.length === 0) return 'Not installed';
      return `Not installed · ${isInUse ? 'Install adds' : 'Add installs'} ${describePlan(plan)}`;
    case 'waiting':
      return agent.availableFrom === null ? 'Not available yet' : `Available from ${formatAvailableFrom(agent.availableFrom)}`;
    case 'unsupported':
      return 'Not available for this Mac';
  }
}

/** The line under an agent's name; `plan` is what Add or Install would install, when known. */
export function statusLine(
  agent: CatalogAgent,
  plan: readonly InstallStep[] | null,
  isInUse = false,
  install?: InstallLine,
): string {
  const line = jobLine(agent, plan, install) ?? baseStatusLine(agent, plan, isInUse);
  return agent.listed ? line : `${line} · No longer listed`;
}

/** What the agent is doing instead of its usual status line while an install or update runs, or why it failed. */
function jobLine(
  agent: CatalogAgent,
  plan: readonly InstallStep[] | null,
  install: InstallLine | undefined,
): string | null {
  if (!install || install.status === 'idle') return null;
  const isUpdate = install.action === 'update';
  if (install.status === 'failed') {
    return `${isUpdate ? 'Update' : 'Install'} failed · ${install.error ?? 'Unknown error'}`;
  }
  if (isUpdate) return agent.updateVersion ? `Updating to ${agent.updateVersion}` : `Updating ${agent.name}`;
  return `Installing ${plan && plan.length > 0 ? describePlan(plan) : agent.name}`;
}

export interface RowActions {
  add: boolean;
  /** An agent in use that is not installed yet, such as a default one. */
  install: boolean;
  update: boolean;
  remove: boolean;
}

/** Which buttons a catalog row offers. */
export function rowActions(agent: CatalogAgent, isInUse: boolean): RowActions {
  const canBeUsed = agent.status !== 'waiting' && agent.status !== 'unsupported';
  // A program managed outside Zorvo with a known location cannot be updated from here.
  const canUpdate = agent.status !== 'on_your_mac' || agent.location === null;
  return {
    add: !isInUse && canBeUsed,
    install: isInUse && agent.status === 'not_installed',
    update: isInUse && canUpdate && agent.updateVersion !== null,
    remove: isInUse,
  };
}

/**
 * Enables an agent: writes the full list (so defaults are not left implicit) and clears any removal.
 * `version`, the one the catalog offers, is recorded unless one already is, so a later
 * Check again cannot change the version in use without an Update.
 */
export function withAgentAdded(
  settings: Settings,
  id: string,
  current: readonly string[],
  version: string | null = null,
): Settings {
  const known = settings.agentVersions ?? {};
  const shouldRecord = version !== null && !(id in known);
  return {
    ...settings,
    enabledAgents: current.includes(id) ? [...current] : [...current, id],
    removedAgents: (settings.removedAgents ?? []).filter((removed) => removed !== id),
    ...(shouldRecord ? { agentVersions: { ...known, [id]: version } } : {}),
  };
}

/** Disables an agent and remembers the removal so it is not enabled again automatically. */
export function withAgentRemoved(settings: Settings, id: string, current: readonly string[]): Settings {
  const removed = settings.removedAgents ?? [];
  return {
    ...settings,
    enabledAgents: current.filter((enabled) => enabled !== id),
    removedAgents: removed.includes(id) ? [...removed] : [...removed, id],
    defaultAgentId: settings.defaultAgentId === id ? null : settings.defaultAgentId,
  };
}

/** Agents in use that have a newer version on offer. */
export function pendingUpdates(agents: readonly CatalogAgent[], enabledIds: readonly string[]): CatalogAgent[] {
  return agents.filter((agent) => enabledIds.includes(agent.id) && agent.updateVersion !== null);
}

const DATE_FORMAT = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });

/** "Oct 27" */
export function formatAvailableFrom(seconds: number): string {
  return DATE_FORMAT.format(new Date(seconds * 1000));
}

const RELATIVE_FORMAT = new Intl.RelativeTimeFormat('en', { numeric: 'always' });

/** "2 hours ago"; "just now" within the first minute. Both arguments are unix seconds. */
export function formatCheckedAgo(seconds: number, now: number): string {
  const elapsed = Math.max(0, now - seconds);
  if (elapsed < SECONDS_PER_MINUTE) return 'just now';
  if (elapsed < SECONDS_PER_HOUR) return RELATIVE_FORMAT.format(-Math.floor(elapsed / SECONDS_PER_MINUTE), 'minute');
  if (elapsed < SECONDS_PER_DAY) return RELATIVE_FORMAT.format(-Math.floor(elapsed / SECONDS_PER_HOUR), 'hour');
  return RELATIVE_FORMAT.format(-Math.floor(elapsed / SECONDS_PER_DAY), 'day');
}
