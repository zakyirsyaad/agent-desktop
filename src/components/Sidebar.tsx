import { useState, type ReactNode } from "react";
import { Search, Plus, FolderPlus, ChevronRight } from "lucide-react";
import { AgentLogo } from "./AgentLogo";
import type { AgentProfile, Session, Workspace } from "../types";
import { NewSessionMenu } from "./sidebar/NewSessionMenu";
import { SessionTree, type SessionListContext } from "./sidebar/SessionList";
import {
  folderNameOf,
  groupSessionsByWorkspace,
  isArchived,
  isShownPinned,
  workspacePathOf,
  type SessionGroup,
  type SessionNode,
} from "../lib/session-helpers";

export interface SidebarProps {
  workspaces: Workspace[];
  activeWorkspacePath?: string;
  sessions: Session[];
  activeSessionId?: string;
  agents: AgentProfile[];
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  /** Opens a new session in that folder with that agent; each workspace's + button is hidden when absent. */
  onNewSessionIn?: (path: string, agentId: string) => void;
  /** The agent the + menu marks as the default. */
  defaultAgentId?: string;
  /** Opens the native folder dialog; the button is hidden when absent. */
  onOpenFolder?: () => void;
  /** True while a session's agent is working on a turn. */
  isSessionBusy?: (sessionId: string) => boolean;
  /** True while a session's agent waits for the user to answer a permission request. */
  isSessionWaiting?: (sessionId: string) => boolean;
  /** Stops the agent's current turn; offered only while it works. */
  onStopSession?: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  /** Each is offered in a session's ⋯ menu when given. */
  onRenameSession?: (sessionId: string, name: string) => void;
  onPinSession?: (sessionId: string, isPinned: boolean) => void;
  onArchiveSession?: (sessionId: string, isArchived: boolean) => void;
  /** Bottom bar content, e.g. the user's profile. */
  footer?: ReactNode;
}

const SECTION_HEADER =
  "flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-1.5 px-1";

function matches(query: string, ...values: string[]): boolean {
  return query === "" || values.some((v) => v.toLowerCase().includes(query));
}

interface WorkspaceGroupProps {
  group: SessionGroup;
  isActive: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  /** The + button's menu; hidden when absent. */
  newSessionMenu?: ReactNode;
  context: SessionListContext;
}

/** A folder's heading, which folds its sessions away, and its sessions. */
function WorkspaceGroup({ group, isActive, isExpanded, onToggle, newSessionMenu, context }: WorkspaceGroupProps) {
  return (
    <li>
      <div className="group/ws flex items-center">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isExpanded}
          title={group.path}
          className={`flex-1 min-w-0 flex items-center gap-1 rounded px-1.5 py-1 text-left text-[12px] transition-colors hover:text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-neutral-600 ${
            isActive ? "text-neutral-300" : "text-neutral-500"
          }`}
        >
          <span className="truncate">{group.name}</span>
          <ChevronRight
            size={12}
            aria-hidden="true"
            className={`shrink-0 transition-transform ${
              isExpanded ? "rotate-90 opacity-0 group-hover/ws:opacity-100" : ""
            }`}
          />
        </button>
        {newSessionMenu}
      </div>
      {isExpanded && group.sessions.length > 0 && (
        <div className="mt-0.5">
          <SessionTree nodes={group.sessions} label={`Sessions in ${group.name}`} context={context} />
        </div>
      )}
    </li>
  );
}

/** Installed agents, pinned above the footer; renders nothing when none are detected. */
function DetectedAgents({ agents }: { agents: AgentProfile[] }) {
  const detected = agents.filter((agent) => agent.detected);
  if (detected.length === 0) return null;
  return (
    <section aria-label="Detected agents" className="border-t border-neutral-800/60 px-3 pt-2.5 pb-2">
      <div className={SECTION_HEADER}>
        <span>Detected Agents</span>
        <span className="text-[10px] text-neutral-600">{detected.length}</span>
      </div>
      <ul aria-label="Detected agents" className="space-y-0.5">
        {detected.map((agent) => (
          <li
            key={agent.id}
            title={agent.detected_path ?? undefined}
            className="flex items-center justify-between rounded-md px-2 py-1 text-neutral-300 hover:bg-neutral-900/40"
          >
            <div className="flex items-center gap-2 truncate">
              <AgentLogo profileId={agent.id} name={agent.name} />
              <span className="truncate">{agent.name}</span>
            </div>
            <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-medium">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 inline-block" />
              Ready
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** True when the session or one of its forks matches the search. */
function nodeMatches(node: SessionNode, query: string): boolean {
  return matches(query, node.session.name) || node.children.some((child) => nodeMatches(child, query));
}

/** Keeps the sessions that match, with the sources of matching forks so the tree stays readable. */
function filterNodes(nodes: SessionNode[], query: string): SessionNode[] {
  return nodes
    .filter((node) => nodeMatches(node, query))
    .map((node) => ({ ...node, children: filterNodes(node.children, query) }));
}

/** The groups to show for a search: a folder that matches keeps all its sessions. */
function searchGroups(groups: SessionGroup[], query: string): SessionGroup[] {
  if (query === "") return groups;
  return groups
    .map((group) =>
      matches(query, group.name, group.path) ? group : { ...group, sessions: filterNodes(group.sessions, query) },
    )
    .filter((group) => group.sessions.length > 0 || matches(query, group.name, group.path));
}

export function Sidebar({
  workspaces,
  activeWorkspacePath,
  sessions,
  activeSessionId,
  agents,
  onNewSession,
  onSelectSession,
  onNewSessionIn,
  defaultAgentId,
  onOpenFolder,
  isSessionBusy = () => false,
  isSessionWaiting = () => false,
  onStopSession,
  onDeleteSession,
  onRenameSession,
  onPinSession,
  onArchiveSession,
  footer,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const query = searchQuery.trim().toLowerCase();

  // Pinned sessions sit on top and archived ones at the bottom, out of their workspace.
  const listed = sessions.filter((s) => !isArchived(s) && !isShownPinned(s));
  const groups = searchGroups(groupSessionsByWorkspace(workspaces, listed), query);
  const asNodes = (list: Session[]) => list.map((session) => ({ session, children: [] }));
  // Like a listed session, one is found by its own name or its project's.
  const isFound = (s: Session) => matches(query, s.name, folderNameOf(workspacePathOf(s)), workspacePathOf(s));
  const pinned = sessions
    .filter((s) => isShownPinned(s) && isFound(s))
    .sort((a, b) => b.createdAt - a.createdAt);
  const archived = sessions
    .filter((s) => isArchived(s) && isFound(s))
    .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
  const detectedAgents = agents.filter((agent) => agent.detected);
  const toggle = (path: string) =>
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const context: SessionListContext = {
    activeSessionId,
    agentNameOf: (profileId) => agents.find((agent) => agent.id === profileId)?.name,
    isSessionBusy,
    isSessionWaiting,
    onSelectSession,
    onStopSession,
    onDeleteSession,
    onRenameSession,
    onPinSession,
    onArchiveSession,
  };

  return (
    <aside className="w-64 flex flex-col justify-between border-r border-neutral-800/80 bg-[#0d0d0d] select-none text-xs text-neutral-300">
      <div className="p-3 border-b border-neutral-800/60">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search..."
              aria-label="Search workspaces and sessions"
              className="w-full rounded-md bg-neutral-900/90 border border-neutral-800/80 py-1.5 pl-8 pr-3 text-xs text-neutral-200 placeholder-neutral-500 outline-none focus:border-neutral-700 focus:ring-1 focus:ring-neutral-700"
            />
          </div>
          <button
            type="button"
            onClick={onNewSession}
            aria-label="+ New session"
            className="flex items-center gap-1 rounded-md bg-neutral-800/90 hover:bg-neutral-700/90 px-2.5 py-1.5 font-medium text-neutral-200 transition-colors focus:outline-none focus:ring-1 focus:ring-neutral-600"
          >
            <Plus size={13} />
            <span>New</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {pinned.length > 0 && (
          <section className="mb-4">
            <div className={SECTION_HEADER}>
              <span>Pinned</span>
            </div>
            <SessionTree nodes={asNodes(pinned)} label="Pinned sessions" context={context} />
          </section>
        )}
        <div className={SECTION_HEADER}>
          <span>Workspaces</span>
          {onOpenFolder && (
            <button
              type="button"
              aria-label="Open folder"
              title="Open a project folder"
              onClick={onOpenFolder}
              className="rounded p-0.5 text-neutral-500 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-600"
            >
              <FolderPlus size={13} />
            </button>
          )}
        </div>
        {groups.length === 0 && pinned.length === 0 && archived.length === 0 && (
          <p className="px-2 py-1 text-[11px] text-neutral-500">
            {query ? "Nothing matches your search." : "No folders yet. Open one to start."}
          </p>
        )}
        <ul aria-label="Workspaces" className="space-y-3">
          {groups.map((group) => (
            <WorkspaceGroup
              key={group.path}
              group={group}
              isActive={group.path === activeWorkspacePath}
              // A search shows every match, folded or not.
              isExpanded={query !== "" || !collapsedPaths.has(group.path)}
              onToggle={() => toggle(group.path)}
              newSessionMenu={
                onNewSessionIn && (
                  <NewSessionMenu
                    folderName={group.name}
                    agents={detectedAgents}
                    defaultAgentId={defaultAgentId}
                    onPick={(agentId) => onNewSessionIn(group.path, agentId)}
                  />
                )
              }
              context={context}
            />
          ))}
        </ul>
        {archived.length > 0 && (
          <section className="mt-4">
            <button
              type="button"
              onClick={() => setIsArchiveOpen((open) => !open)}
              // A search shows its matches whether the section is folded or not.
              disabled={query !== ""}
              aria-expanded={isArchiveOpen || query !== ""}
              className="flex w-full items-center gap-1 px-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 hover:text-neutral-300"
            >
              <ChevronRight
                size={11}
                aria-hidden="true"
                className={`transition-transform ${isArchiveOpen || query !== "" ? "rotate-90" : ""}`}
              />
              {`Archived (${archived.length})`}
            </button>
            {(isArchiveOpen || query !== "") && (
              <div className="mt-1.5">
                <SessionTree nodes={asNodes(archived)} label="Archived sessions" context={context} />
              </div>
            )}
          </section>
        )}
      </div>

      <DetectedAgents agents={agents} />
      {footer && <div className="border-t border-neutral-800/80 bg-[#0a0a0a]">{footer}</div>}
    </aside>
  );
}
