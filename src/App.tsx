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
import { useAgentProfiles, useSuggestedFolders } from "./hooks/useDiscovery";
import { useWorkspaceSelection } from "./hooks/useWorkspaceSelection";
import { Onboarding, type OnboardingResult } from "./components/Onboarding";
import { SettingsPanel } from "./components/SettingsPanel";
import { ProfileFooter } from "./components/ProfileFooter";
import { useNavigationHistory } from "./hooks/useNavigationHistory";
import { useUserProfile } from "./hooks/useUserProfile";
import { usePopoutHost } from "./hooks/usePopoutHost";
import type { PopoutAction } from "./lib/popout-bridge";
import { resolveDefaultAgentId } from "./lib/agent-readiness";
import type { ActionCard, AgentProfile, ChatMessage, PermissionMode, Session, Settings, SpawnOptions } from "./types";
import { DEFAULT_PERMISSION_MODE } from "./types";

const DISABLED_COMPOSER_PLACEHOLDER = "Start a session to send a message";
const NO_FOLDER_NOTICE = "Open a project folder first: use the Open folder button next to Workspaces.";
const NO_AGENT_NOTICE = "No supported agent is installed. Install Claude Code, Aider or omp, then check again in Settings.";

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
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const parsersRef = useRef<Map<string, StreamParser>>(new Map());

  const reportError = useCallback((message: string) => setNotice(message), []);
  const { state, isLoaded, updateState } = usePersistedState(reportError);
  const { transcripts, ensureLoaded, updateMessages, removeTranscript } = useTranscripts(reportError);
  const { agents, refresh: refreshAgents } = useAgentProfiles(reportError);
  const suggestedFolders = useSuggestedFolders();
  const userProfile = useUserProfile();
  const navigation = useNavigationHistory();
  const {
    workspaces,
    activeWorkspace,
    activeWorkspacePath,
    selectWorkspace,
    rememberFolder,
    openFolder,
    removeFolder,
  } = useWorkspaceSelection(state, isLoaded, updateState, reportError);

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
    if (!activeSessionId) return;
    ensureLoaded(activeSessionId);
    navigation.visit(activeSessionId);
  }, [activeSessionId, ensureLoaded, navigation.visit]);

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
    if (!activeWorkspace || !activeWorkspacePath) {
      setNotice(NO_FOLDER_NOTICE);
      return;
    }
    const agentToSpawn = newSessionAgent;
    if (!agentToSpawn) {
      setNotice(NO_AGENT_NOTICE);
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
    rememberFolder(activeWorkspace);
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
    if (selected && workspaces.some((ws) => ws.path === selected.cwd)) selectWorkspace(selected.cwd);
  };

  const navigateTo = (sessionId: string | null) => {
    if (sessionId) handleSelectSession(sessionId);
  };

  const handleRevealFolder = () => {
    if (!activeWorkspacePath) return;
    invoke("reveal_in_finder", { path: activeWorkspacePath }).catch((error) => {
      setNotice(`Could not open the folder: ${String(error)}`);
    });
  };

  const handlePopout = () => {
    if (!activeSession) return;
    invoke("open_session_window", { sessionId: activeSession.id }).catch((error) => {
      setNotice(`Could not open a new window: ${String(error)}`);
    });
  };

  const updateSettings = (patch: Partial<Settings>) =>
    updateState((prev) => ({ ...prev, settings: { ...prev.settings, ...patch } }));

  const handleOnboardingComplete = ({ defaultAgentId, folder }: OnboardingResult) => {
    updateSettings({ onboardingCompleted: true, defaultAgentId });
    rememberFolder(folder);
  };

  const handleRunOnboarding = () => {
    setIsSettingsOpen(false);
    updateSettings({ onboardingCompleted: false });
  };

  const handleStopSession = (sessionId: string) => {
    // The status flips to "terminated" when the backend reports pty-exit.
    invoke("terminate_session", { sessionId }).catch((error) => {
      setNotice(`Failed to stop the session: ${String(error)}`);
    });
  };

  const handleDeleteSession = (sessionId: string) => {
    parsersRef.current.delete(sessionId);
    navigation.remove(sessionId);
    updateState((prev) => removeSessionFrom(prev, sessionId));
    removeTranscript(sessionId);
    if (sessionId === activeSessionId) {
      setActiveSessionId(mostRecentSessionId(sessions.filter((s) => s.id !== sessionId)));
    }
  };

  /** Sends raw input to a session's PTY; reports failures instead of hiding them. */
  const sendToSession = async (sessionId: string, data: string): Promise<boolean> => {
    try {
      await invoke("send_input", { sessionId, data });
      return true;
    } catch (error) {
      setNotice(`Failed to send input: ${String(error)}`);
      return false;
    }
  };

  const handleSendPtyInput = (input: string) => {
    void sendToSession(activeSessionId, input);
  };

  const sendMessage = async (sessionId: string, messageText: string) => {
    if (!(await sendToSession(sessionId, `${messageText}\n`))) return;
    const message: ChatMessage = {
      id: createId("msg"),
      role: "user",
      content: messageText,
      timestamp: Date.now(),
    };
    updateMessages(sessionId, (prev) => [...prev, message]);
  };

  const resolveActionCard = (
    sessionId: string,
    key: string,
    cardId: string | undefined,
    status: ActionCard["status"],
  ) => {
    updateMessages(sessionId, (prev) => setCardStatus(prev, cardId, status));
    void sendToSession(sessionId, key);
  };

  usePopoutHost({
    sessions,
    transcripts,
    ensureLoaded,
    onAction: (sessionId: string, action: PopoutAction) => {
      if (action.kind === "send") void sendMessage(sessionId, action.text);
      else resolveActionCard(sessionId, action.key, action.cardId, action.status);
    },
  });

  const currentMessages = transcripts[activeSessionId] ?? [];

  if (isLoaded && !state.settings.onboardingCompleted) {
    return (
      <Onboarding
        agents={agents}
        recentFolders={workspaces}
        suggestedFolders={suggestedFolders}
        onRecheckAgents={refreshAgents}
        onPickFolder={openFolder}
        onComplete={handleOnboardingComplete}
      />
    );
  }

  return (
    <main className="flex h-screen w-screen flex-col bg-[#0a0a0a] text-neutral-200">
      <TopBar
        sessionName={activeSession?.name}
        workspaceName={activeWorkspace?.name}
        isTerminalOpen={isTerminalOpen}
        onToggleTerminal={() => setIsTerminalOpen((prev) => !prev)}
        canGoBack={navigation.canGoBack}
        canGoForward={navigation.canGoForward}
        onBack={() => navigateTo(navigation.back())}
        onForward={() => navigateTo(navigation.forward())}
        onOpenFolder={activeWorkspacePath ? handleRevealFolder : undefined}
        onPopout={activeSession ? handlePopout : undefined}
        onOpenSettings={() => setIsSettingsOpen(true)}
      />

      <section className="flex flex-1 overflow-hidden">
        <Sidebar
          workspaces={workspaces}
          activeWorkspacePath={activeWorkspacePath}
          sessions={sessions}
          activeSessionId={activeSessionId}
          agents={agents}
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
          onSelectWorkspace={selectWorkspace}
          onOpenFolder={() => void openFolder()}
          onStopSession={handleStopSession}
          onDeleteSession={handleDeleteSession}
          footer={
            <ProfileFooter
              name={userProfile.name}
              email={userProfile.email}
              version={userProfile.version}
              onOpenSettings={() => setIsSettingsOpen(true)}
            />
          }
        />

        <article className="flex-1 flex flex-col bg-[#000000] relative overflow-hidden">
          {notice && <NoticeBanner message={notice} onDismiss={() => setNotice(null)} />}
          {activeSession && currentMessages.length > 0 ? (
            <ChatCanvas
              messages={currentMessages}
              onSendPtyInput={handleSendPtyInput}
              onApproveAction={(key, cardId) => resolveActionCard(activeSessionId, key, cardId, "approved")}
              onRejectAction={(key, cardId) => resolveActionCard(activeSessionId, key, cardId, "rejected")}
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
              onSendMessage={(text) => void sendMessage(activeSessionId, text)}
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
      {isSettingsOpen && (
        <SettingsPanel
          agents={agents}
          defaultAgentId={state.settings.defaultAgentId}
          recentFolders={workspaces}
          onChangeDefaultAgent={(defaultAgentId) => updateSettings({ defaultAgentId })}
          onRemoveRecentFolder={removeFolder}
          onRunOnboarding={handleRunOnboarding}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}
    </main>
  );
}
