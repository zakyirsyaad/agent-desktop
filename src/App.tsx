import { useState, useEffect, useRef } from "react";
import { Sparkles } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { ChatCanvas } from "./components/ChatCanvas";
import { ComposerDock } from "./components/ComposerDock";
import { TerminalDrawer } from "./components/TerminalDrawer";
import { StreamParser } from "./lib/stream-parser";
import { applyParsedEvents } from "./lib/apply-parsed-events";
import type {
  AgentProfile,
  ChatMessage,
  Session,
  PermissionMode,
  PtyOutputPayload,
  Workspace,
} from "./types";

export default function App() {
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);

  // Default mock workspaces & active selection (by name; path is the spawn cwd)
  const [workspaces] = useState<Workspace[]>([
    { name: "ai-perpetual-trading", path: "/Users/mac/ai-perpetual-trading" },
    { name: "titan-investment", path: "/Users/mac/titan-investment" },
    { name: "agent-desktop", path: "/Users/mac/agent-desktop" },
  ]);
  const [activeWorkspace, setActiveWorkspace] = useState<string>("ai-perpetual-trading");
  const activeWorkspacePath = workspaces.find((ws) => ws.name === activeWorkspace)?.path;

  // Default mock sessions
  const [sessions, setSessions] = useState<Session[]>([
    {
      id: "s-1",
      name: "New session (fork)",
      profileId: "claude-code",
      cwd: "/Users/mac/ai-perpetual-trading",
      status: "running",
      model: "claude-sonnet-5-5",
      effort: "High",
      permissionMode: "bypass",
      createdAt: Date.now() - 3600000,
    },
    {
      id: "s-2",
      name: "Market analyzer refactor",
      profileId: "omp",
      cwd: "/Users/mac/titan-investment",
      status: "idle",
      model: "gemini-3.8-flash-tiered",
      effort: "High",
      permissionMode: "ask",
      createdAt: Date.now() - 7200000,
    },
    {
      id: "s-3",
      name: "Claude Code Session #1",
      profileId: "claude-code",
      cwd: "/Users/mac/agent-desktop",
      status: "idle",
      model: "claude-opus-5-5",
      effort: "Medium",
      permissionMode: "bypass",
      createdAt: Date.now() - 10800000,
    },
  ]);
  const [activeSessionId, setActiveSessionId] = useState<string>("s-1");

  // Mock messages per session for rich chat canvas display
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({
    "s-1": [
      {
        id: "m-1",
        role: "user",
        content: "Please inspect the codebase structure and check if any build scripts require permission.",
        timestamp: Date.now() - 3600000,
      },
      {
        id: "m-2",
        role: "agent",
        content: `# Codebase Inspection Summary

I reviewed the project layout. Here is the operational workflow:

1. **Backend PTY engine**: Uses \`portable-pty\` to manage asynchronous stream IO.
2. **Environment resolution**: Spawns user login shell to load authentic paths.
3. **Frontend replication**: Recreates Claude Code Desktop with dark aesthetics and Action Cards.

To verify the test suite, please run:

\`\`\`bash
pnpm test
\`\`\`

Would you like me to execute this action?`,
        timestamp: Date.now() - 3500000,
        tools: [
          {
            id: "t-1",
            name: "Glob",
            args: 'pattern: "src/**/*.ts*"',
            status: "completed",
          },
          {
            id: "t-2",
            name: "Bash",
            args: "cargo test --workspace",
            status: "completed",
          },
        ],
        actionCard: {
          id: "act-1",
          sessionId: "s-1",
          title: "⚠️ Agent Action Approval Required",
          prompt: "Execute `pnpm test` across the workspace?",
          commandSnippet: "pnpm test",
          toolName: "Bash",
          status: "pending",
          approvalKey: "y\n",
          rejectKey: "n\n",
          timestamp: Date.now() - 3400000,
        },
      },
    ],
  });

  // Detected agent profiles
  const [agents, setAgents] = useState<AgentProfile[]>([
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

  // Map of StreamParser per session
  const parsersRef = useRef<Map<string, StreamParser>>(new Map());

  const getOrCreateParser = (sessionId: string, profile?: AgentProfile): StreamParser => {
    let parser = parsersRef.current.get(sessionId);
    if (!parser) {
      parser = new StreamParser({
        approvalPattern: profile?.approval_pattern ?? undefined,
      });
      parsersRef.current.set(sessionId, parser);
    }
    return parser;
  };

  // Discover installed agent profiles on mount
  useEffect(() => {
    invoke<AgentProfile[]>("get_agent_profiles")
      .then((profiles) => {
        if (profiles && Array.isArray(profiles) && profiles.length > 0) {
          setAgents(profiles);
        }
      })
      .catch(() => {});
  }, []);

  // Listen to Tauri PTY output events and feed into session parser
  useEffect(() => {
    let unlistenOutput: UnlistenFn | null = null;
    let isCancelled = false;

    listen<PtyOutputPayload>("pty-output", (event) => {
      const payload = event.payload;
      if (!payload?.session_id || !payload?.data) return;

      const sid = payload.session_id;
      const targetSession = sessions.find((s) => s.id === sid);
      const targetProfile = agents.find((a) => a.id === targetSession?.profileId);
      const parser = getOrCreateParser(sid, targetProfile);
      const parsedEvents = parser.feed(payload.data);

      if (parsedEvents.length === 0) return;

      setMessages((prev) => ({
        ...prev,
        [sid]: applyParsedEvents(prev[sid] ?? [], parsedEvents, {
          sessionId: sid,
          profile: targetProfile,
          now: Date.now(),
          createId: (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        }),
      }));
    })
      .then((unlisten) => {
        if (isCancelled) {
          unlisten();
        } else {
          unlistenOutput = unlisten;
        }
      })
      .catch(() => {});

    return () => {
      isCancelled = true;
      if (unlistenOutput) {
        unlistenOutput();
      }
    };
  }, [agents, sessions]);

  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const activeAgent = agents.find((a) => a.id === activeSession?.profileId) ?? agents[0];

  const handleNewSession = () => {
    // The backend rejects relative cwds, so never spawn without a resolved path.
    if (!activeWorkspacePath) return;

    const newSessionId = `s-${Date.now()}`;
    const agentToSpawn = activeAgent ?? agents[0];
    const newSession: Session = {
      id: newSessionId,
      name: `Session #${sessions.length + 1}`,
      profileId: agentToSpawn?.id || "claude-code",
      cwd: activeWorkspacePath,
      status: "running",
      createdAt: Date.now(),
    };
    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(newSessionId);

    // Call spawn_session on Tauri backend
    if (agentToSpawn && agentToSpawn.command) {
      invoke("spawn_session", {
        sessionId: newSessionId,
        cwd: activeWorkspacePath,
        command: agentToSpawn.command,
        args: [],
      }).catch(() => {});
    }
  };

  const handleSelectSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    const selected = sessions.find((s) => s.id === sessionId);
    if (selected) {
      // If session belongs to known workspace, switch workspace too
      const matchingWs = workspaces.find((ws) => ws.path === selected.cwd);
      if (matchingWs) {
        setActiveWorkspace(matchingWs.name);
      }
    }
  };

  const handleSelectWorkspace = (workspace: string) => {
    setActiveWorkspace(workspace);
  };

  const handleToggleTerminal = () => {
    setIsTerminalOpen((prev) => !prev);
  };

  /**
   * Raw PTY input forwarding: dispatches keystrokes/data straight to backend PTY via Tauri send_input.
   */
  const handleSendPtyInput = (input: string) => {
    invoke("send_input", { sessionId: activeSessionId, data: input }).catch(() => {});
  };

  /**
   * Action Card approval handling: updates message status and forwards only the approval key to PTY.
   */
  const handleActionApprove = (key: string, cardId?: string) => {
    setMessages((prev) => {
      const sessionMsgs = prev[activeSessionId] ?? [];
      const updated = sessionMsgs.map((msg) => {
        if (!msg.actionCard) return msg;
        if (cardId && msg.actionCard.id !== cardId) return msg;
        return {
          ...msg,
          actionCard: {
            ...msg.actionCard,
            status: "approved" as const,
          },
        };
      });
      return {
        ...prev,
        [activeSessionId]: updated,
      };
    });

    handleSendPtyInput(key);
  };

  const handleActionReject = (key: string, cardId?: string) => {
    setMessages((prev) => {
      const sessionMsgs = prev[activeSessionId] ?? [];
      const updated = sessionMsgs.map((msg) => {
        if (!msg.actionCard) return msg;
        if (cardId && msg.actionCard.id !== cardId) return msg;
        return {
          ...msg,
          actionCard: {
            ...msg.actionCard,
            status: "rejected" as const,
          },
        };
      });
      return {
        ...prev,
        [activeSessionId]: updated,
      };
    });

    handleSendPtyInput(key);
  };

  const handleSendMessage = (messageText: string) => {
    const newMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: "user",
      content: messageText,
      timestamp: Date.now(),
    };

    setMessages((prev) => ({
      ...prev,
      [activeSessionId]: [...(prev[activeSessionId] ?? []), newMessage],
    }));

    // Forwards input directly to backend PTY send_input
    handleSendPtyInput(`${messageText}\n`);
  };

  const handleModelChange = (newModel: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSessionId ? { ...s, model: newModel } : s))
    );
  };

  const handleEffortChange = (newEffort: string) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSessionId ? { ...s, effort: newEffort } : s))
    );
  };

  const handlePermissionModeChange = (newMode: PermissionMode) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === activeSessionId ? { ...s, permissionMode: newMode } : s))
    );
  };

  const currentMessages = messages[activeSessionId] ?? [];

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
          workspaces={workspaces.map((ws) => ws.name)}
          activeWorkspace={activeWorkspace}
          sessions={sessions}
          activeSessionId={activeSessionId}
          agents={agents}
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onSelectWorkspace={handleSelectWorkspace}
        />

        {/* Chat / Canvas Area */}
        <article className="flex-1 flex flex-col bg-[#000000] relative overflow-hidden">
          {currentMessages.length > 0 ? (
            <ChatCanvas
              messages={currentMessages}
              onSendPtyInput={handleSendPtyInput}
              onApproveAction={handleActionApprove}
              onRejectAction={handleActionReject}
            />
          ) : (
            <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center text-center">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-neutral-900 border border-neutral-800 text-amber-500">
                <Sparkles size={24} />
              </div>
              <h1 className="text-xl font-medium text-neutral-100">Agent Desktop GUI</h1>
              <p className="mt-1 max-w-sm text-sm text-neutral-400">
                Generic terminal coding agent wrapper with authentic shell environment and interactive action cards.
              </p>
            </div>
          )}

          {/* Floating Composer Dock */}
          <div className="p-4 flex justify-center">
            <ComposerDock
              activeAgent={activeAgent}
              selectedModel={activeSession?.model}
              selectedEffort={activeSession?.effort}
              permissionMode={activeSession?.permissionMode ?? "bypass"}
              isThinking={activeSession?.status === "running"}
              bannerMessage="Approaching weekly usage limit • Resets Fri, Oct 16, 5:00 AM"
              onSendMessage={handleSendMessage}
              onModelChange={handleModelChange}
              onEffortChange={handleEffortChange}
              onPermissionModeChange={handlePermissionModeChange}
            />
          </div>

          {/* Collapsible Raw Terminal Drawer */}
          <TerminalDrawer
            isOpen={isTerminalOpen}
            sessionId={activeSessionId}
            sessionName={activeSession?.name}
            pid={activeSession?.pid}
            onClose={() => setIsTerminalOpen(false)}
            onSendInput={handleSendPtyInput}
          />
        </article>
      </section>
    </main>
  );
}
