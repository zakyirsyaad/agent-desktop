import { useEffect, useState, type ReactNode } from "react";
import { Search, Plus, FolderPlus, ChevronRight, Bot, Square, Trash2 } from "lucide-react";
import type { AgentProfile, Session, Workspace } from "../types";
import { NewSessionMenu } from "./sidebar/NewSessionMenu";
import { groupSessionsByWorkspace, type SessionGroup, type SessionNode } from "../lib/session-helpers";

export interface SidebarProps {
  workspaces: Workspace[];
  activeWorkspacePath?: string;
  sessions: Session[];
  activeSessionId?: string;
  agents: AgentProfile[];
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  /** Makes a folder the active workspace (its files, the next session's folder). */
  onSelectWorkspace?: (path: string) => void;
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
  /** Bottom bar content, e.g. the user's profile. */
  footer?: ReactNode;
}

const SECTION_HEADER =
  "flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-1.5 px-1";
const ROW_ACTION =
  "mr-1 rounded p-1 text-neutral-500 opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-rose-300 focus:outline-none focus:ring-1 focus:ring-neutral-600";

function matches(query: string, ...values: string[]): boolean {
  return query === "" || values.some((v) => v.toLowerCase().includes(query));
}

interface SessionRowProps {
  session: Session;
  agentName?: string;
  isActive: boolean;
  isBusy: boolean;
  isWaiting: boolean;
  onSelect: () => void;
  onStop?: () => void;
  onDelete?: () => void;
}

function SessionRow({ session, agentName, isActive, isBusy, isWaiting, onSelect, onStop, onDelete }: SessionRowProps) {
  return (
    <div
      className={`group flex items-center rounded-md transition-colors ${
        isActive
          ? "bg-neutral-800/90 text-neutral-100 font-medium"
          : "text-neutral-400 hover:bg-neutral-900/60 hover:text-neutral-200"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        title={agentName ? `${session.name} · ${agentName}` : session.name}
        className="flex-1 min-w-0 flex items-center justify-between px-2 py-1.5 text-left"
      >
        <span className="truncate">{session.name}</span>
        {isWaiting ? (
          <span
            role="status"
            aria-label="Waiting for your answer"
            title="The agent waits for your answer"
            className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0 ml-1"
          />
        ) : isBusy && (
          <span
            role="status"
            aria-label="Agent working"
            title="The agent is working"
            className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0 ml-1 animate-pulse"
          />
        )}
      </button>
      {isBusy && onStop && (
        <button
          type="button"
          aria-label="Stop session"
          title="Stop the agent's current turn"
          onClick={onStop}
          className={ROW_ACTION}
        >
          <Square size={11} />
        </button>
      )}
      {!isBusy && onDelete && <DeleteButton onDelete={onDelete} />}
    </div>
  );
}

/** What every row in the tree needs besides its own session. */
interface SessionTreeContext {
  activeSessionId?: string;
  agentNameOf: (profileId: string) => string | undefined;
  isSessionBusy: (sessionId: string) => boolean;
  isSessionWaiting: (sessionId: string) => boolean;
  onSelectSession: (sessionId: string) => void;
  onStopSession?: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
}

/** Sessions with their forks nested beneath them, joined by a guide line. */
function SessionTree({ nodes, label, context, isNested = false }: {
  nodes: SessionNode[];
  label: string;
  context: SessionTreeContext;
  isNested?: boolean;
}) {
  const { onStopSession, onDeleteSession } = context;
  return (
    <ul
      aria-label={label}
      className={isNested ? "ml-3 mt-0.5 space-y-0.5 border-l border-neutral-800 pl-1.5" : "space-y-0.5"}
    >
      {nodes.map(({ session, children }) => (
        <li key={session.id}>
          <SessionRow
            session={session}
            agentName={context.agentNameOf(session.profileId)}
            isActive={session.id === context.activeSessionId}
            isBusy={context.isSessionBusy(session.id)}
            isWaiting={context.isSessionWaiting(session.id)}
            onSelect={() => context.onSelectSession(session.id)}
            onStop={onStopSession ? () => onStopSession(session.id) : undefined}
            onDelete={onDeleteSession ? () => onDeleteSession(session.id) : undefined}
          />
          {children.length > 0 && (
            <SessionTree nodes={children} label={`Forks of ${session.name}`} context={context} isNested />
          )}
        </li>
      ))}
    </ul>
  );
}

interface WorkspaceGroupProps {
  group: SessionGroup;
  isActive: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  /** The + button's menu; hidden when absent. */
  newSessionMenu?: ReactNode;
  context: SessionTreeContext;
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

/** How long the delete button waits for its confirming second click. */
const CONFIRM_DELETE_MS = 4000;

/**
 * Deleting erases the conversation for good, so it takes two clicks: the
 * trash icon turns into "Delete?", which deletes; it turns back by itself.
 */
function DeleteButton({ onDelete }: { onDelete: () => void }) {
  const [isConfirming, setIsConfirming] = useState(false);
  useEffect(() => {
    if (!isConfirming) return;
    const timer = setTimeout(() => setIsConfirming(false), CONFIRM_DELETE_MS);
    return () => clearTimeout(timer);
  }, [isConfirming]);

  if (isConfirming) {
    return (
      <button
        type="button"
        aria-label="Confirm delete"
        title="Delete this session and its conversation for good"
        onClick={onDelete}
        className="mr-1 rounded bg-rose-950/70 px-1.5 py-0.5 text-[10px] font-medium text-rose-300 hover:bg-rose-900 focus:outline-none focus:ring-1 focus:ring-rose-700"
      >
        Delete?
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-label="Delete session"
      title="Delete session"
      onClick={() => setIsConfirming(true)}
      className={ROW_ACTION}
    >
      <Trash2 size={12} />
    </button>
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
              <Bot size={13} aria-hidden="true" className="text-emerald-400" />
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
  onSelectWorkspace,
  defaultAgentId,
  onOpenFolder,
  isSessionBusy = () => false,
  isSessionWaiting = () => false,
  onStopSession,
  onDeleteSession,
  footer,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const query = searchQuery.trim().toLowerCase();

  const groups = searchGroups(groupSessionsByWorkspace(workspaces, sessions), query);
  const detectedAgents = agents.filter((agent) => agent.detected);
  const toggle = (path: string) =>
    setCollapsedPaths((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const context: SessionTreeContext = {
    activeSessionId,
    agentNameOf: (profileId) => agents.find((agent) => agent.id === profileId)?.name,
    isSessionBusy,
    isSessionWaiting,
    onSelectSession,
    onStopSession,
    onDeleteSession,
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
        {groups.length === 0 && (
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
              onToggle={() => {
                // A heading both folds its sessions and makes its folder the active one.
                toggle(group.path);
                onSelectWorkspace?.(group.path);
              }}
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
      </div>

      <DetectedAgents agents={agents} />
      {footer && <div className="border-t border-neutral-800/80 bg-[#0a0a0a]">{footer}</div>}
    </aside>
  );
}
