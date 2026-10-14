import { useState } from "react";
import {
  Search,
  Plus,
  Folder,
  Settings,
  GitBranch,
  GitFork,
  Bot
} from "lucide-react";
import type { AgentProfile, Session } from "../types";

export interface SidebarProps {
  workspaces: string[];
  activeWorkspace?: string;
  sessions: Session[];
  activeSessionId?: string;
  agents: AgentProfile[];
  onNewSession: () => void;
  onSelectSession: (sessionId: string) => void;
  onSelectWorkspace: (workspace: string) => void;
}

export function Sidebar({
  workspaces,
  activeWorkspace,
  sessions,
  activeSessionId,
  agents,
  onNewSession,
  onSelectSession,
  onSelectWorkspace,
}: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState("");

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredWorkspaces = workspaces.filter((ws) =>
    ws.toLowerCase().includes(normalizedQuery)
  );

  const filteredSessions = sessions.filter((s) =>
    s.name.toLowerCase().includes(normalizedQuery) ||
    s.cwd.toLowerCase().includes(normalizedQuery)
  );

  return (
    <aside className="w-64 flex flex-col justify-between border-r border-neutral-800/80 bg-[#0d0d0d] select-none text-xs text-neutral-300">
      {/* Top Section: Search & New Session */}
      <div className="p-3 border-b border-neutral-800/60">
        <div className="flex items-center gap-2 mb-3">
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

      {/* Center Scrollable List: Workspaces, Sessions, Agents */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* Workspaces List */}
        <div>
          <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-1.5 px-1">
            <span>Workspaces</span>
            <span className="text-[10px] text-neutral-600">{filteredWorkspaces.length}</span>
          </div>
          <ul className="space-y-0.5">
            {filteredWorkspaces.map((ws) => {
              const isActive = ws === activeWorkspace;
              return (
                <li key={ws}>
                  <button
                    type="button"
                    onClick={() => onSelectWorkspace(ws)}
                    className={`w-full flex items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors ${
                      isActive
                        ? "bg-neutral-800 text-neutral-100 font-medium"
                        : "text-neutral-400 hover:bg-neutral-900/60 hover:text-neutral-200"
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <Folder size={13} className={isActive ? "text-amber-500" : "text-neutral-500"} />
                      <span className="truncate">{ws}</span>
                    </div>
                    {isActive && (
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0 ml-1" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Sessions & Branches List */}
        <div>
          <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-1.5 px-1">
            <span>Sessions</span>
            <span className="text-[10px] text-neutral-600">{filteredSessions.length}</span>
          </div>
          <ul className="space-y-0.5">
            {filteredSessions.map((s) => {
              const isActive = s.id === activeSessionId;
              const isFork = s.name.toLowerCase().includes("fork");
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => onSelectSession(s.id)}
                    className={`w-full flex items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors ${
                      isActive
                        ? "bg-neutral-800/90 text-neutral-100 font-medium"
                        : "text-neutral-400 hover:bg-neutral-900/60 hover:text-neutral-200"
                    }`}
                  >
                    <div className="flex items-center gap-2 truncate">
                      {isFork ? (
                        <GitFork size={13} className="text-purple-400 shrink-0" />
                      ) : (
                        <GitBranch size={13} className="text-neutral-500 shrink-0" />
                      )}
                      <span className="truncate">{s.name}</span>
                    </div>
                    {s.status === "running" && (
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shrink-0 ml-1 animate-pulse" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Detected Agents */}
        <div>
          <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-1.5 px-1">
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
                <div className="flex items-center gap-1.5 text-[10px]">
                  {agent.detected ? (
                    <span className="flex items-center gap-1 text-emerald-400 font-medium">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 inline-block" />
                      Ready
                    </span>
                  ) : (
                    <span className="text-neutral-600">Not found</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Bottom Profile Footer Bar */}
      <footer className="p-3 border-t border-neutral-800/80 bg-[#0a0a0a] flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-800 text-[11px] font-semibold text-neutral-200 border border-neutral-700/60">
            IN
          </div>
          <div className="flex flex-col">
            <div className="flex items-center gap-1">
              <span className="font-medium text-neutral-200">Iwang</span>
              <span className="text-neutral-500">•</span>
              <span className="text-[10px] text-amber-400/90 font-medium bg-amber-400/10 px-1 rounded">Pro</span>
            </div>
            <span className="text-[10px] text-neutral-500">Agent Desktop v0.1.0</span>
          </div>
        </div>
        <button
          type="button"
          aria-label="Settings"
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-700"
        >
          <Settings size={14} />
        </button>
      </footer>
    </aside>
  );
}
