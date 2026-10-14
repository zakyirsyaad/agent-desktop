import { useState } from "react";
import { Sparkles } from "lucide-react";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import type { AgentProfile, Session } from "./types";

export default function App() {
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);

  // Default mock workspaces & active selection
  const [workspaces] = useState<string[]>([
    "ai-perpetual-trading",
    "titan-investment",
    "agent-desktop",
  ]);
  const [activeWorkspace, setActiveWorkspace] = useState<string>("ai-perpetual-trading");

  // Default mock sessions
  const [sessions, setSessions] = useState<Session[]>([
    {
      id: "s-1",
      name: "New session (fork)",
      profileId: "claude-code",
      cwd: "/Users/mac/ai-perpetual-trading",
      status: "running",
      createdAt: Date.now() - 3600000,
    },
    {
      id: "s-2",
      name: "Market analyzer refactor",
      profileId: "omp",
      cwd: "/Users/mac/titan-investment",
      status: "idle",
      createdAt: Date.now() - 7200000,
    },
    {
      id: "s-3",
      name: "Claude Code Session #1",
      profileId: "claude-code",
      cwd: "/Users/mac/agent-desktop",
      status: "idle",
      createdAt: Date.now() - 10800000,
    },
  ]);
  const [activeSessionId, setActiveSessionId] = useState<string>("s-1");

  // Detected agent profiles
  const [agents] = useState<AgentProfile[]>([
    {
      id: "claude-code",
      name: "Claude Code",
      command: "claude",
      detected: true,
      detected_path: "/opt/homebrew/bin/claude",
      models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"],
      effort_levels: ["Low", "Medium", "High"],
    },
    {
      id: "omp",
      name: "Oh-My-Pi",
      command: "omp",
      detected: true,
      detected_path: "/usr/local/bin/omp",
      models: ["gemini-3.8-flash-tiered"],
      effort_levels: ["Low", "High"],
    },
    {
      id: "aider",
      name: "Aider",
      command: "aider",
      detected: false,
      models: ["gpt-5"],
      effort_levels: [],
    },
  ]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];

  const handleNewSession = () => {
    const newSessionId = `s-${Date.now()}`;
    const newSession: Session = {
      id: newSessionId,
      name: `Session #${sessions.length + 1}`,
      profileId: "claude-code",
      cwd: activeWorkspace,
      status: "running",
      createdAt: Date.now(),
    };
    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(newSessionId);
  };

  const handleSelectSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    const selected = sessions.find((s) => s.id === sessionId);
    if (selected) {
      // If session belongs to known workspace, switch workspace too
      const matchingWs = workspaces.find((ws) => selected.cwd.includes(ws));
      if (matchingWs) {
        setActiveWorkspace(matchingWs);
      }
    }
  };

  const handleSelectWorkspace = (workspace: string) => {
    setActiveWorkspace(workspace);
  };

  const handleToggleTerminal = () => {
    setIsTerminalOpen((prev) => !prev);
  };

  return (
    <main className="flex h-screen w-screen flex-col bg-[#0a0a0a] text-neutral-200">
      {/* Top Bar Window Bar */}
      <TopBar
        sessionName={activeSession?.name ?? "Claude Code Session #1"}
        workspaceName={activeWorkspace}
        isTerminalOpen={isTerminalOpen}
        onToggleTerminal={handleToggleTerminal}
      />

      {/* Main Workspace Body */}
      <section className="flex flex-1 overflow-hidden">
        {/* Left Sidebar */}
        <Sidebar
          workspaces={workspaces}
          activeWorkspace={activeWorkspace}
          sessions={sessions}
          activeSessionId={activeSessionId}
          agents={agents}
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onSelectWorkspace={handleSelectWorkspace}
        />

        {/* Chat / Canvas Area */}
        <article className="flex-1 flex flex-col bg-[#000000] relative">
          <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-neutral-900 border border-neutral-800 text-amber-500">
              <Sparkles size={24} />
            </div>
            <h1 className="text-xl font-medium text-neutral-100">Agent Desktop GUI</h1>
            <p className="mt-1 max-w-sm text-sm text-neutral-400">
              Generic terminal coding agent wrapper with authentic shell environment and interactive action cards.
            </p>
          </div>

          {/* Floating Composer Placeholder */}
          <footer className="p-4 flex justify-center">
            <div className="w-full max-w-2xl rounded-2xl border border-neutral-800 bg-[#121212] p-3 shadow-2xl flex items-center gap-2">
              <input
                type="text"
                readOnly
                placeholder="Type / for commands, or prompt the agent..."
                className="flex-1 bg-transparent text-sm text-neutral-300 placeholder-neutral-500 outline-none"
              />
              <div className="rounded-lg bg-neutral-800 px-2.5 py-1 text-xs text-neutral-400">
                Claude Code
              </div>
            </div>
          </footer>

          {/* Collapsible Raw Terminal Drawer Placeholder (Full integration in Task 9) */}
          {isTerminalOpen && (
            <div
              data-testid="raw-terminal-drawer"
              className="h-64 border-t border-neutral-800 bg-[#050505] p-3 font-mono text-xs text-neutral-400"
            >
              <div className="flex items-center justify-between pb-2 border-b border-neutral-800 mb-2">
                <span className="text-neutral-500">&gt; Raw Terminal Stream ({activeSession?.name})</span>
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
              </div>
              <div className="text-neutral-500">Connecting to PTY master stream...</div>
            </div>
          )}
        </article>
      </section>
    </main>
  );
}
