import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { ChatCanvas } from "./components/ChatCanvas";
import { ComposerDock, type ComposerHandle } from "./components/ComposerDock";
import { FilesPanel } from "./components/FilesPanel";
import { TerminalDrawer } from "./components/TerminalDrawer";
import { EmptySessionState, NoticeBanner } from "./components/AppPlaceholders";
import { mostRecentSessionId, nextSessionName, patchSessionIn, removeSessionFrom } from "./lib/session-helpers";
import { createId } from "./lib/ids";
import { usePersistedState } from "./hooks/usePersistedState";
import { useTranscripts } from "./hooks/useTranscripts";
import { useAgentProfiles, useSuggestedFolders } from "./hooks/useDiscovery";
import { useWorkspaceSelection } from "./hooks/useWorkspaceSelection";
import { Onboarding, type OnboardingResult } from "./components/Onboarding";
import { SettingsPanel } from "./components/SettingsPanel";
import { ProfileFooter } from "./components/ProfileFooter";
import { useNavigationHistory } from "./hooks/useNavigationHistory";
import { useUserProfile } from "./hooks/useUserProfile";
import { usePopoutHost } from "./hooks/usePopoutHost";
import type { PopoutAction } from "./lib/popout-bridge";
import { usePtyEngine } from "./hooks/session-engine/usePtyEngine";
import { useAcpEngine } from "./hooks/session-engine/useAcpEngine";
import { buildForkHandoff, buildForkPrompt } from "./lib/fork-handoff";
import { pickFiles } from "./lib/file-picker";
import { resolveDefaultAgentId } from "./lib/agent-readiness";
import type { SessionDraft } from "./lib/composer-controls";
import { composerStateFor } from "./lib/composer-state";
import { NO_CHOICES, type AcpChoices, type AgentOptions } from "./lib/acp-draft";
import type { AgentProfile, ChatMessage, Session, Settings, SpawnOptions } from "./types";
import { DEFAULT_PERMISSION_MODE, TRANSPORT_ACP } from "./types";

const ACP_NO_TERMINAL_MESSAGE = "This agent talks to the app directly over ACP, so it has no terminal.";
const NO_WORKSPACE_PLACEHOLDER = "Open a folder and install an agent to start";
const NEW_SESSION_PLACEHOLDER = "Message the agent to start a new session...";
const RESUME_PLACEHOLDER = "Message the agent to continue this session...";
const NO_FOLDER_NOTICE = "Open a project folder first: use the Open folder button next to Workspaces.";
const NO_AGENT_NOTICE =
  "No supported agent is installed. Install Claude Code, Qwen Code, Codex, Aider or omp, then check again in Settings.";

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

const isAcp = (session: Session | undefined) => session?.transport === TRANSPORT_ACP;

export default function App() {
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [draft, setDraft] = useState<SessionDraft>(EMPTY_DRAFT);
  const [acpChoices, setAcpChoices] = useState<AcpChoices>(NO_CHOICES);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isFilesOpen, setIsFilesOpen] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);

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

  // An ended ACP session continues where it left off with its own agent.
  const isResumable =
    isAcp(activeSession) &&
    activeSession?.status !== "running" &&
    Boolean(activeSession?.acpSessionId) &&
    activeAgent?.detected === true;
  const draftAgent = isResumable ? activeAgent : newSessionAgent;

  // A model or effort chosen for one agent means nothing to another one.
  useEffect(() => setDraft(EMPTY_DRAFT), [newSessionAgentId]);
  useEffect(() => setAcpChoices(NO_CHOICES), [draftAgent?.id]);

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

  const rememberAgentOptions = (profileId: string, options: AgentOptions) =>
    updateState((prev) => ({ ...prev, agentOptions: { ...prev.agentOptions, [profileId]: options } }));

  const engineDeps = { sessions, agents, updateMessages, patchSession, reportError };
  const pty = usePtyEngine(engineDeps);
  const acp = useAcpEngine({ ...engineDeps, rememberOptions: rememberAgentOptions });

  const sessionById = (sessionId: string) => sessions.find((s) => s.id === sessionId);
  const isSessionBusy = (sessionId: string) =>
    isAcp(sessionById(sessionId)) ? acp.isBusy(sessionId) : pty.isBusy(sessionId);

  interface SessionSpec {
    id?: string;
    agent: AgentProfile;
    cwd: string;
    name: string;
    /** Terminal agents only: the CLI flags to start with. */
    options?: SpawnOptions;
    forkedFrom?: string;
    initialMessages?: ChatMessage[];
  }

  /** Records a new session and shows it; the agent is started by its engine. */
  const recordSession = ({ id, agent, cwd, name, options, forkedFrom, initialMessages }: SessionSpec): Session => {
    const session: Session = {
      id: id ?? createId("s"),
      name,
      profileId: agent.id,
      cwd,
      status: "running",
      createdAt: Date.now(),
      model: options?.model,
      effort: options?.effort,
      permissionMode: options?.permissionMode,
      agentSessionId: options?.agentSessionId ?? null,
      forkedFrom: forkedFrom ?? null,
      transport: agent.transport,
    };
    updateState((prev) => ({ ...prev, sessions: [session, ...prev.sessions] }));
    if (initialMessages) updateMessages(session.id, () => initialMessages);
    setActiveSessionId(session.id);
    return session;
  };

  const startSession = (spec: SessionSpec, firstPrompt?: string) => {
    const session = recordSession(spec);
    if (isAcp(session)) void acp.start(session, firstPrompt, acpChoices);
    else pty.start(session, spec.options ?? spawnOptionsFor(spec.agent, draft), firstPrompt);
  };

  const handleNewSession = (firstPrompt?: string) => {
    // The backend rejects relative and missing cwds, so never spawn without a path.
    if (!activeWorkspace || !activeWorkspacePath) {
      setNotice(NO_FOLDER_NOTICE);
      return;
    }
    if (!newSessionAgent) {
      setNotice(NO_AGENT_NOTICE);
      return;
    }
    rememberFolder(activeWorkspace);
    startSession(
      { agent: newSessionAgent, cwd: activeWorkspacePath, name: nextSessionName(sessions) },
      firstPrompt,
    );
  };

  /**
   * Forks the active session at `messageId`. From the latest message, an ACP
   * agent that supports it forks its own live session, and Claude Code in a
   * terminal resumes and forks its session natively. Otherwise the
   * conversation is written to a handoff file and the new agent is asked, in
   * one line, to read it.
   */
  const handleFork = async (messageId: string) => {
    const source = activeSession;
    const agent = agents.find((a) => a.id === source?.profileId);
    if (!source || !agent?.detected) {
      setNotice("The agent for this session is not installed, so it cannot be forked.");
      return;
    }
    const messages = transcripts[source.id] ?? [];
    const index = messages.findIndex((m) => m.id === messageId);
    if (index < 0) return;

    const isLatest = index === messages.length - 1;
    const baseOptions: SessionDraft = {
      model: source.model,
      effort: source.effort,
      permissionMode: source.permissionMode ?? DEFAULT_PERMISSION_MODE,
    };
    const spec: SessionSpec = {
      id: createId("s"),
      agent,
      cwd: source.cwd,
      name: `${source.name} (fork)`,
      forkedFrom: source.id,
      initialMessages: messages.slice(0, index + 1),
    };
    if (isAcp(source) && isLatest && acp.canFork(source.id)) {
      void acp.fork(source.id, recordSession(spec));
      return;
    }
    if (!isAcp(source) && agent.fork_support === "native" && isLatest && source.agentSessionId) {
      startSession({ ...spec, options: { ...baseOptions, forkFromAgentSessionId: source.agentSessionId } });
      return;
    }

    try {
      const content = buildForkHandoff(messages, messageId, {
        sourceSessionName: source.name,
        agentName: agent.name,
        cwd: source.cwd,
        createdAt: Date.now(),
      });
      const handoffPath = await invoke<string>("write_fork_handoff", { handoffId: spec.id, content });
      startSession({ ...spec, options: spawnOptionsFor(agent, baseOptions) }, buildForkPrompt(handoffPath));
    } catch (error) {
      setNotice(`Could not fork the session: ${String(error)}`);
    }
  };

  const handleSelectSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    const selected = sessionById(sessionId);
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

  /** Stops the agent's current turn; the session stays open for the next message. */
  const handleInterrupt = (sessionId: string) => {
    if (isAcp(sessionById(sessionId))) acp.interrupt(sessionId, transcripts[sessionId]);
    else pty.interrupt(sessionId);
  };

  const handleDeleteSession = (sessionId: string) => {
    const session = sessionById(sessionId);
    if (session?.status === "running") {
      if (isAcp(session)) acp.stop(sessionId);
      else pty.stop(sessionId);
    }
    pty.forget(sessionId);
    navigation.remove(sessionId);
    updateState((prev) => removeSessionFrom(prev, sessionId));
    removeTranscript(sessionId);
    if (sessionId === activeSessionId) {
      setActiveSessionId(mostRecentSessionId(sessions.filter((s) => s.id !== sessionId)));
    }
  };

  const sendTo = (sessionId: string, text: string) =>
    isAcp(sessionById(sessionId)) ? acp.send(sessionId, text) : pty.send(sessionId, text);

  /** Sends to the active session, or starts a new one with the message as its first prompt. */
  /** Continues an ended ACP session: a fresh agent process loads it, then gets the message. */
  const resumeSession = (session: Session, text: string) => {
    if (!session.acpSessionId) return;
    patchSession(session.id, { status: "running", endedAt: null, exitCode: null });
    void acp.resume(session, session.acpSessionId, text, acpChoices);
  };

  /** Sends to the active session, continues it when it can be resumed, or starts a new one. */
  const handleSendMessage = (text: string) => {
    if (activeSession && isActiveRunning) void sendTo(activeSession.id, text);
    else if (activeSession && isResumable) resumeSession(activeSession, text);
    else handleNewSession(text);
  };

  const chooseOption = (sessionId: string, cardId: string, optionId: string) =>
    acp.chooseOption(sessionId, transcripts[sessionId], cardId, optionId);

  usePopoutHost({
    sessions,
    transcripts,
    ensureLoaded,
    onAction: (sessionId: string, action: PopoutAction) => {
      if (action.kind === "send") void sendTo(sessionId, action.text);
      else if (action.kind === "choose-option") chooseOption(sessionId, action.cardId, action.optionId);
      else pty.resolveCard(sessionId, action.key, action.cardId, action.status);
    },
  });

  const currentMessages = transcripts[activeSessionId] ?? [];
  const canStartSession = Boolean(activeWorkspacePath && newSessionAgent);
  const composer = composerStateFor({
    session: activeSession,
    sessionAgent: activeAgent,
    draftAgent,
    draft,
    setDraft,
    acpChoices,
    setAcpChoices,
    agentOptions: state.agentOptions,
    acp,
  });
  const isActiveTerminal = isActiveRunning && !isAcp(activeSession);

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
        onToggleFiles={activeWorkspacePath ? () => setIsFilesOpen((prev) => !prev) : undefined}
        isFilesOpen={isFilesOpen && Boolean(activeWorkspacePath)}
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
          onNewSession={() => handleNewSession()}
          onSelectSession={handleSelectSession}
          onSelectWorkspace={selectWorkspace}
          onOpenFolder={() => void openFolder()}
          isSessionBusy={isSessionBusy}
          onStopSession={handleInterrupt}
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
              agentName={activeAgent?.name}
              onForkBranch={(messageId) => void handleFork(messageId)}
              onSendPtyInput={(input) => void pty.sendRaw(activeSessionId, input)}
              onApproveAction={(key, cardId) => pty.resolveCard(activeSessionId, key, cardId, "approved")}
              onRejectAction={(key, cardId) => pty.resolveCard(activeSessionId, key, cardId, "rejected")}
              onChooseOption={(cardId, optionId) => chooseOption(activeSessionId, cardId, optionId)}
            />
          ) : (
            <EmptySessionState />
          )}

          <div className="p-4 flex justify-center">
            <ComposerDock
              controls={composer.controls}
              optionsLocked={composer.locked}
              isThinking={Boolean(activeSession) && isSessionBusy(activeSessionId)}
              onStop={activeSession ? () => handleInterrupt(activeSessionId) : undefined}
              disabled={!isActiveRunning && !isResumable && !canStartSession}
              placeholder={
                isActiveRunning
                  ? undefined
                  : isResumable
                    ? RESUME_PLACEHOLDER
                    : canStartSession
                      ? NEW_SESSION_PLACEHOLDER
                      : NO_WORKSPACE_PLACEHOLDER
              }
              onSendMessage={handleSendMessage}
              onAttach={pickFiles}
              handleRef={composerRef}
            />
          </div>

          <TerminalDrawer
            isOpen={isTerminalOpen}
            sessionId={activeSessionId}
            sessionName={activeSession?.name}
            isLive={isActiveTerminal}
            emptyMessage={isActiveRunning && isAcp(activeSession) ? ACP_NO_TERMINAL_MESSAGE : undefined}
            onClose={() => setIsTerminalOpen(false)}
            onSendInput={(input) => void pty.sendRaw(activeSessionId, input)}
          />
        </article>
        {isFilesOpen && activeWorkspace && activeWorkspacePath && (
          <FilesPanel
            key={activeWorkspacePath}
            rootPath={activeWorkspacePath}
            rootName={activeWorkspace.name}
            onClose={() => setIsFilesOpen(false)}
            onInsertPath={(path) => composerRef.current?.insertPaths([path])}
            onRevealRoot={handleRevealFolder}
          />
        )}
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
