import { useState, type ReactNode } from "react";
import { Search, Plus, Folder, FolderPlus, GitBranch, GitFork, Bot, Square, Trash2 } from "lucide-react";
import type { AgentProfile, Session, Workspace } from "../types";
import { groupSessionsByFolder } from "../lib/session-helpers";

export interface SidebarProps {
  workspaces: Workspace[];
  activeWorkspacePath?: string;
  sessions: Session[];
  activeSessionId?: string;
  agents: AgentProfile[];
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onSelectWorkspace: (path: string) => void;
  /** Opens the native folder dialog; the button is hidden when absent. */
  onOpenFolder?: () => void;
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
  isActive: boolean;
  onSelect: () => void;
  onStop?: () => void;
  onDelete?: () => void;
}

function SessionRow({ session, isActive, onSelect, onStop, onDelete }: SessionRowProps) {
  const isRunning = session.status === "running";
  return (
    <li
      className={`group flex items-center rounded-md transition-colors ${
        isActive
          ? "bg-neutral-800/90 text-neutral-100 font-medium"
          : "text-neutral-400 hover:bg-neutral-900/60 hover:text-neutral-200"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex-1 min-w-0 flex items-center justify-between px-2 py-1.5 text-left"
      >
        <div className="flex items-center gap-2 truncate">
          {session.forkedFrom ? (
            <GitFork size={13} className="text-purple-400 shrink-0" />
          ) : (
            <GitBranch size={13} className="text-neutral-500 shrink-0" />
          )}
          <span className="truncate">{session.name}</span>
        </div>
        {isRunning && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0 ml-1 animate-pulse" />}
      </button>
      {isRunning && onStop && (
        <button type="button" aria-label="Stop session" title="Stop session" onClick={onStop} className={ROW_ACTION}>
          <Square size={11} />
        </button>
      )}
      {!isRunning && onDelete && (
        <button
          type="button"
          aria-label="Delete session"
          title="Delete session"
          onClick={onDelete}
          className={ROW_ACTION}
        >
          <Trash2 size={12} />
        </button>
      )}
    </li>
  );
}

function AgentList({ agents }: { agents: AgentProfile[] }) {
  return (
    <div>
      <div className={SECTION_HEADER}>
        <span>Detected Agents</span>
        <span className="text-[10px] text-neutral-600">{agents.length}</span>
      </div>
      <ul className="space-y-0.5">
        {agents.map((agent) => (
          <li
            key={agent.id}
            className="flex items-center justify-between rounded-md px-2 py-1 text-neutral-300 hover:bg-neutral-900/40"
          >
            <div className="flex items-center gap-2 truncate">
              <Bot size={13} className={agent.detected ? "text-emerald-400" : "text-neutral-600"} />
              <span className="truncate">{agent.name}</span>
            </div>
            {agent.detected ? (
              <span className="flex items-center gap-1 text-[10px] text-emerald-400 font-medium">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 inline-block" />
                Ready
              </span>
            ) : (
              <span className="text-[10px] text-neutral-600">Not found</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Sidebar({
  workspaces,
  activeWorkspacePath,
  sessions,
  activeSessionId,
  agents,
  onNewSession,
  onSelectSession,
  onSelectWorkspace,
  onOpenFolder,
  onStopSession,
  onDeleteSession,
  footer,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const query = searchQuery.trim().toLowerCase();

  const filteredWorkspaces = workspaces.filter((ws) => matches(query, ws.name, ws.path));
  const sessionGroups = groupSessionsByFolder(
    sessions.filter((s) => matches(query, s.name, s.cwd)),
    activeWorkspacePath,
  );
  const sessionCount = sessionGroups.reduce((total, g) => total + g.sessions.length, 0);

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

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        <div>
          <div className={SECTION_HEADER}>
            <span>Workspaces</span>
            {onOpenFolder ? (
              <button
                type="button"
                aria-label="Open folder"
                title="Open a project folder"
                onClick={onOpenFolder}
                className="rounded p-0.5 text-neutral-500 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-600"
              >
                <FolderPlus size={13} />
              </button>
            ) : (
              <span className="text-[10px] text-neutral-600">{filteredWorkspaces.length}</span>
            )}
          </div>
          {filteredWorkspaces.length === 0 && (
            <p className="px-2 py-1 text-[11px] text-neutral-500">No folders yet. Open one to start.</p>
          )}
          <ul aria-label="Workspaces" className="space-y-0.5">
            {filteredWorkspaces.map((ws) => {
              const isActive = ws.path === activeWorkspacePath;
              return (
                <li key={ws.path}>
                  <button
                    type="button"
                    onClick={() => onSelectWorkspace(ws.path)}
                    title={ws.path}
                    className={`w-full flex items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors ${
                      isActive
                        ? "bg-neutral-800 text-neutral-100 font-medium"
                        : "text-neutral-400 hover:bg-neutral-900/60 hover:text-neutral-200"
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <Folder size={13} className={isActive ? "text-amber-500" : "text-neutral-500"} />
                      <span className="truncate">{ws.name}</span>
                    </div>
                    {isActive && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0 ml-1" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div>
          <div className={SECTION_HEADER}>
            <span>Sessions</span>
            <span className="text-[10px] text-neutral-600">{sessionCount}</span>
          </div>
          {sessionGroups.map((group) => (
            <div key={group.path} className="mb-2">
              <div className="px-2 pb-0.5 text-[10px] text-neutral-500 truncate" title={group.path}>
                {group.name}
              </div>
              <ul aria-label={`Sessions in ${group.name}`} className="space-y-0.5">
                {group.sessions.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    isActive={s.id === activeSessionId}
                    onSelect={() => onSelectSession(s.id)}
                    onStop={onStopSession ? () => onStopSession(s.id) : undefined}
                    onDelete={onDeleteSession ? () => onDeleteSession(s.id) : undefined}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>

        <AgentList agents={agents} />
      </div>

      {footer && <div className="border-t border-neutral-800/80 bg-[#0a0a0a]">{footer}</div>}
    </aside>
  );
}
