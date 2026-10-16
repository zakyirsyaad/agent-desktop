import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { ChatCanvas } from "./components/ChatCanvas";
import { ComposerDock } from "./components/ComposerDock";
import { TerminalDrawer } from "./components/TerminalDrawer";
import { StreamParser } from "./lib/stream-parser";
import { applyParsedEvents } from "./lib/apply-parsed-events";
import {
  mostRecentSessionId,
  patchSessionIn,
  removeSessionFrom,
  setCardStatus,
} from "./lib/session-helpers";
import { usePersistedState } from "./hooks/usePersistedState";
import { useTranscripts } from "./hooks/useTranscripts";
import { usePtyEvents } from "./hooks/usePtyEvents";
import { useAgentProfiles, useWorkspaces } from "./hooks/useDiscovery";
import { resolveDefaultAgentId } from "./lib/agent-readiness";
import type { ActionCard, AgentProfile, ChatMessage, PermissionMode, Session, SpawnOptions } from "./types";
import { DEFAULT_PERMISSION_MODE } from "./types";

const DISABLED_COMPOSER_PLACEHOLDER = "Start a session to send a message";

/** Options picked in the composer for the next session; CLI flags only apply at start. */
interface SessionDraft {
  model?: string;
  effort?: string;
  permissionMode: PermissionMode;
}

const EMPTY_DRAFT: SessionDraft = { permissionMode: DEFAULT_PERMISSION_MODE };

function spawnOptionsFor(agent: AgentProfile, draft: SessionDraft): SpawnOptions {
  return {
    model: draft.model,
    effort: draft.effort,
    permissionMode: draft.permissionMode,
    // Agents with a session-id flag get an id we choose, so they can be forked natively later.
    agentSessionId: agent.session_id_arg ? crypto.randomUUID() : undefined,
  };
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function NoticeBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      className="border-rose-800/60 bg-rose-950/40 text-rose-200 text-xs rounded-lg px-3 py-2 mx-6 mt-3 flex justify-between items-center"
    >
      <span className="break-words">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notice"
        className="shrink-0 ml-3 rounded p-0.5 text-rose-300 hover:text-rose-100 focus:outline-none focus:ring-1 focus:ring-rose-700"
      >
        <X size={13} />
      </button>
    </div>
  );
}

function EmptySessionState() {
  return (
    <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-neutral-900 border border-neutral-800 text-amber-500">
        <Sparkles size={24} />
      </div>
      <h1 className="text-xl font-medium text-neutral-100">No session yet</h1>
      <p className="mt-1 max-w-sm text-sm text-neutral-400">
        Pick a workspace in the sidebar, then click New to start an agent.
      </p>
    </div>
  );
}

export default function App() {
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [draft, setDraft] = useState<SessionDraft>(EMPTY_DRAFT);
  const parsersRef = useRef<Map<string, StreamParser>>(new Map());

  const reportError = useCallback((message: string) => setNotice(message), []);
  const { state, isLoaded, updateState } = usePersistedState(reportError);
  const { transcripts, ensureLoaded, updateMessages, removeTranscript } = useTranscripts(reportError);
  const agents = useAgentProfiles(reportError);
  const { workspaces, activeWorkspace, activeWorkspacePath, setActiveWorkspace } =
    useWorkspaces(reportError);

  const sessions = state.sessions;
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeAgent = agents.find((a) => a.id === activeSession?.profileId);
  const isActiveRunning = activeSession?.status === "running";
  const newSessionAgentId = resolveDefaultAgentId(agents, state.settings.defaultAgentId);
  const newSessionAgent = agents.find((a) => a.id === newSessionAgentId);

  // A model or effort chosen for one agent means nothing to another one.
  useEffect(() => setDraft(EMPTY_DRAFT), [newSessionAgentId]);

  // Once saved sessions are loaded, show the most recent one.
  useEffect(() => {
    if (isLoaded) setActiveSessionId((current) => current || mostRecentSessionId(state.sessions));
    // Only on the load transition; later session changes must not move the selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded]);

  useEffect(() => {
    if (activeSessionId) ensureLoaded(activeSessionId);
  }, [activeSessionId, ensureLoaded]);

  const patchSession = useCallback(
    (sessionId: string, patch: Partial<Session>) =>
      updateState((prev) => patchSessionIn(prev, sessionId, patch)),
    [updateState],
  );

  usePtyEvents({
    onOutput: (sessionId, data) => {
      const session = sessions.find((s) => s.id === sessionId);
      const profile = agents.find((a) => a.id === session?.profileId);
      let parser = parsersRef.current.get(sessionId);
      if (!parser) {
        parser = new StreamParser({ approvalPattern: profile?.approval_pattern ?? undefined });
        parsersRef.current.set(sessionId, parser);
      }
      const events = parser.feed(data);
      if (events.length === 0) return;
      updateMessages(sessionId, (prev) =>
        applyParsedEvents(prev, events, { sessionId, profile, now: Date.now(), createId }),
      );
    },
    onExit: (sessionId, exitCode) => {
      parsersRef.current.delete(sessionId);
      patchSession(sessionId, { status: "terminated", endedAt: Date.now(), exitCode });
    },
  });

  const handleNewSession = () => {
    // The backend rejects relative and missing cwds, so never spawn without a path.
    if (!activeWorkspacePath) {
      setNotice("No workspace folder found. Add a project folder under ~/developer and restart the app.");
      return;
    }
    const agentToSpawn = newSessionAgent;
    if (!agentToSpawn) {
      setNotice("No supported agent is installed. Install Claude Code, Aider or omp, then restart the app.");
      return;
    }
    const options = spawnOptionsFor(agentToSpawn, draft);
    const newSession: Session = {
      id: createId("s"),
      name: `Session #${sessions.length + 1}`,
      profileId: agentToSpawn.id,
      cwd: activeWorkspacePath,
      status: "running",
      createdAt: Date.now(),
      model: options.model,
      effort: options.effort,
      permissionMode: options.permissionMode,
      agentSessionId: options.agentSessionId ?? null,
    };
    updateState((prev) => ({ ...prev, sessions: [newSession, ...prev.sessions] }));
    setActiveSessionId(newSession.id);

    invoke("spawn_session", {
      sessionId: newSession.id,
      cwd: activeWorkspacePath,
      profileId: agentToSpawn.id,
      options,
    }).catch((error) => {
      // The PTY never came up, so the session cannot stay "running".
      patchSession(newSession.id, { status: "terminated", endedAt: Date.now() });
      setNotice(`Failed to start ${agentToSpawn.name}: ${String(error)}`);
    });
  };

  const handleSelectSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    const selected = sessions.find((s) => s.id === sessionId);
    const matchingWs = workspaces.find((ws) => ws.path === selected?.cwd);
    if (matchingWs) setActiveWorkspace(matchingWs.name);
  };

  const handleStopSession = (sessionId: string) => {
    // The status flips to "terminated" when the backend reports pty-exit.
    invoke("terminate_session", { sessionId }).catch((error) => {
      setNotice(`Failed to stop the session: ${String(error)}`);
    });
  };

  const handleDeleteSession = (sessionId: string) => {
    parsersRef.current.delete(sessionId);
    updateState((prev) => removeSessionFrom(prev, sessionId));
    removeTranscript(sessionId);
    if (sessionId === activeSessionId) {
      setActiveSessionId(mostRecentSessionId(sessions.filter((s) => s.id !== sessionId)));
    }
  };

  /** Sends raw input to the active session's PTY; reports failures instead of hiding them. */
  const sendToActiveSession = async (data: string): Promise<boolean> => {
    try {
      await invoke("send_input", { sessionId: activeSessionId, data });
      return true;
    } catch (error) {
      setNotice(`Failed to send input: ${String(error)}`);
      return false;
    }
  };

  const handleSendPtyInput = (input: string) => {
    void sendToActiveSession(input);
  };

  const handleSendMessage = async (messageText: string) => {
    if (!(await sendToActiveSession(`${messageText}\n`))) return;
    const message: ChatMessage = {
      id: createId("msg"),
      role: "user",
      content: messageText,
      timestamp: Date.now(),
    };
    updateMessages(activeSessionId, (prev) => [...prev, message]);
  };

  const resolveActionCard = (key: string, cardId: string | undefined, status: ActionCard["status"]) => {
    updateMessages(activeSessionId, (prev) => setCardStatus(prev, cardId, status));
    handleSendPtyInput(key);
  };

  const currentMessages = transcripts[activeSessionId] ?? [];

  return (
    <main className="flex h-screen w-screen flex-col bg-[#0a0a0a] text-neutral-200">
      <TopBar
        sessionName={activeSession?.name}
        workspaceName={activeWorkspace}
        isTerminalOpen={isTerminalOpen}
        onToggleTerminal={() => setIsTerminalOpen((prev) => !prev)}
      />

      <section className="flex flex-1 overflow-hidden">
        <Sidebar
          workspaces={workspaces.map((ws) => ws.name)}
          activeWorkspace={activeWorkspace}
          sessions={sessions}
          activeSessionId={activeSessionId}
          agents={agents}
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onSelectWorkspace={setActiveWorkspace}
          onStopSession={handleStopSession}
          onDeleteSession={handleDeleteSession}
        />

        <article className="flex-1 flex flex-col bg-[#000000] relative overflow-hidden">
          {notice && <NoticeBanner message={notice} onDismiss={() => setNotice(null)} />}
          {activeSession && currentMessages.length > 0 ? (
            <ChatCanvas
              messages={currentMessages}
              onSendPtyInput={handleSendPtyInput}
              onApproveAction={(key, cardId) => resolveActionCard(key, cardId, "approved")}
              onRejectAction={(key, cardId) => resolveActionCard(key, cardId, "rejected")}
            />
          ) : (
            <EmptySessionState />
          )}

          <div className="p-4 flex justify-center">
            <ComposerDock
              activeAgent={isActiveRunning ? activeAgent : newSessionAgent}
              selectedModel={isActiveRunning ? activeSession?.model : draft.model}
              selectedEffort={isActiveRunning ? activeSession?.effort : draft.effort}
              permissionMode={
                isActiveRunning ? activeSession?.permissionMode ?? DEFAULT_PERMISSION_MODE : draft.permissionMode
              }
              optionsLocked={isActiveRunning}
              isThinking={isActiveRunning}
              disabled={!isActiveRunning}
              placeholder={isActiveRunning ? undefined : DISABLED_COMPOSER_PLACEHOLDER}
              onSendMessage={(text) => void handleSendMessage(text)}
              onModelChange={(model) => setDraft((prev) => ({ ...prev, model }))}
              onEffortChange={(effort) => setDraft((prev) => ({ ...prev, effort }))}
              onPermissionModeChange={(permissionMode) => setDraft((prev) => ({ ...prev, permissionMode }))}
            />
          </div>

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
