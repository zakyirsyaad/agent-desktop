import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { ChatCanvas } from "./components/ChatCanvas";
import { ComposerDock, type ComposerHandle } from "./components/ComposerDock";
import { FilesPanel } from "./components/FilesPanel";
import { EmptySessionState, NoticeBanner } from "./components/AppPlaceholders";
import { AuthPanel } from "./components/AuthPanel";
import { TerminalView } from "./components/TerminalView";
import { NewSessionView } from "./components/workspace/NewSessionView";
import { ChangesPanel } from "./components/changes/ChangesPanel";
import { useSidePanel } from "./hooks/useSidePanel";
import { useAgentAuth } from "./hooks/useAgentAuth";
import { createSessionWorktree, removeSessionWorktree } from "./lib/session-worktree";
import { EMPTY_DRAFT, spawnOptionsFor, titleFor } from "./lib/session-start";
import { createPtyOutputStore } from "./lib/pty-output-store";
import { closeTurn, isAwaitingPermission } from "./lib/acp-events";
import {
  folderNameOf,
  isArchived,
  isAutoName,
  workspacePathOf,
  mostRecentSessionId,
  nextSessionName,
  patchSessionIn,
  removeSessionFrom,
} from "./lib/session-helpers";
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
import { useWorkspaceDetails } from "./hooks/useWorkspaceDetails";
import { usePopoutHost } from "./hooks/usePopoutHost";
import { useLatest } from "./hooks/useLatest";
import type { PopoutAction } from "./lib/popout-bridge";
import { usePtyEngine } from "./hooks/session-engine/usePtyEngine";
import { useAcpEngine, type AttentionReason, type FirstMessage } from "./hooks/session-engine/useAcpEngine";
import { attentionBody, notifyIfAway } from "./lib/notify";
import { buildForkHandoff, buildForkPrompt } from "./lib/fork-handoff";
import { pickFiles } from "./lib/file-picker";
import { resolveDefaultAgentId } from "./lib/agent-readiness";
import type { SessionDraft } from "./lib/composer-controls";
import { composerStateFor } from "./lib/composer-state";
import { NO_CHOICES, type AcpChoices, type AgentOptions } from "./lib/acp-draft";
import type { AgentProfile, ChatMessage, Session, SessionWorktree, Settings, SpawnOptions } from "./types";
import { DEFAULT_PERMISSION_MODE, TRANSPORT_ACP } from "./types";

const NO_WORKSPACE_PLACEHOLDER = "Open a folder and install an agent to start";
const NEW_SESSION_PLACEHOLDER = "Message the agent to start a new session...";
const RESUME_PLACEHOLDER = "Message the agent to continue this session...";
const CREATING_WORKTREE_PLACEHOLDER = "Creating a worktree for the session...";
const NO_FOLDER_NOTICE = "Open a project folder first: use the Open folder button next to Workspaces.";
const NO_AGENT_NOTICE =
  "No supported agent is installed. Install Claude Code, Qwen Code, Codex, Aider or omp, then check again in Settings.";

const isAcp = (session: Session | undefined) => session?.transport === TRANSPORT_ACP;
/** Shown in the session list: not archived. */
const isListed = (session: Session) => !isArchived(session);

export default function App() {
  const [notice, setNotice] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [draft, setDraft] = useState<SessionDraft>(EMPTY_DRAFT);
  /** The agent picked for the next new session; null means the default from Settings. */
  const [pickedAgentId, setPickedAgentId] = useState<string | null>(null);
  /** Whether the next new session runs in its own worktree (a git repository only). */
  const [isWorktreeOn, setIsWorktreeOn] = useState(false);
  const [isCreatingWorktree, setIsCreatingWorktree] = useState(false);
  const [acpChoices, setAcpChoices] = useState<AcpChoices>(NO_CHOICES);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);
  const [ptyOutput] = useState(createPtyOutputStore);
  const { authRequest, requestSignIn, signIn, dismiss: dismissSignIn } = useAgentAuth();

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
  const sessionsRef = useLatest(sessions);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeAgent = agents.find((a) => a.id === activeSession?.profileId);
  const isActiveRunning = activeSession?.status === "running";
  const defaultAgentId = resolveDefaultAgentId(agents, state.settings.defaultAgentId);
  const newSessionAgentId =
    agents.find((a) => a.id === pickedAgentId && a.detected)?.id ?? defaultAgentId;
  const newSessionAgent = agents.find((a) => a.id === newSessionAgentId);
  // No session is selected: the window shows a new one, not started until its first message.
  const isNewSessionDraft = !activeSession;
  // A session shows the folder it runs in, even one no longer in the recents.
  const shownFolderPath = activeSession?.cwd ?? activeWorkspacePath;
  const workspaceDetails = useWorkspaceDetails(shownFolderPath, reportError);
  // Files and Reveal act on the folder the top bar names. The backend browses
  // every saved session's folder, so one gone from the recents keeps them.
  const isRepository = Boolean(workspaceDetails?.branch);
  const canUseWorktree = isNewSessionDraft && isRepository;
  const filesFolder =
    workspaces.find((ws) => ws.path === shownFolderPath) ??
    (activeSession ? { name: folderNameOf(activeSession.cwd), path: activeSession.cwd } : undefined);

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

  // Agents a previous UI left running (a webview reload keeps the backend
  // alive) are unknown to this one, which shows their sessions as ended;
  // end them so a resume does not collide with a still-open session.
  useEffect(() => {
    invoke("end_orphaned_sessions").catch((error) => {
      setNotice(`Could not stop agents left from before: ${String(error)}`);
    });
  }, []);

  // Once saved sessions are loaded, show the most recent one.
  useEffect(() => {
    if (isLoaded) setActiveSessionId((current) => current || mostRecentSessionId(state.sessions.filter(isListed)));
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

  const rememberAgentOptions = (profileId: string, options: Partial<AgentOptions>) =>
    updateState((prev) => {
      const known = prev.agentOptions?.[profileId] ?? { modes: null, configOptions: [] };
      return { ...prev, agentOptions: { ...prev.agentOptions, [profileId]: { ...known, ...options } } };
    });

  const engineDeps = { sessions, agents, updateMessages, patchSession, reportError };
  const pty = usePtyEngine({ ...engineDeps, output: ptyOutput });
  const acp = useAcpEngine({
    ...engineDeps,
    rememberOptions: rememberAgentOptions,
    onAttention: (sessionId, reason) => notifyAttention(sessionId, reason),
    onAuthRequired: (profileId, cwd, methods, unsent) => {
      requestSignIn(profileId, cwd, methods);
      if (unsent) composerRef.current?.restore(unsent.text, unsent.attachments);
    },
  });

  /** Tells a user who is away that a session needs them or is done. */
  const notifyAttention = (sessionId: string, reason: AttentionReason) => {
    const session = sessionById(sessionId);
    const agentName = agents.find((a) => a.id === session?.profileId)?.name ?? "The agent";
    // A notification that cannot be shown is not worth an error banner: the chat has it all.
    notifyIfAway({ title: session?.name ?? agentName, body: attentionBody(agentName, reason) }).catch(() => {});
  };

  const sessionById = (sessionId: string) => sessions.find((s) => s.id === sessionId);
  const isSessionBusy = (sessionId: string) =>
    isAcp(sessionById(sessionId)) ? acp.isBusy(sessionId) : pty.isBusy(sessionId);

  const sidePanel = useSidePanel(
    filesFolder?.path,
    isRepository,
    Boolean(activeSessionId) && isSessionBusy(activeSessionId),
    reportError,
  );
  /**
   * Whether a session's agent waits for the user's answer. An ACP agent stays
   * busy while it asks; a terminal agent goes quiet on its y/n prompt, so for
   * it a running session with an unanswered approval card is enough.
   */
  const isSessionWaiting = (sessionId: string) => {
    const session = sessionById(sessionId);
    if (session?.status !== "running") return false;
    const messages = transcripts[sessionId] ?? [];
    return isAcp(session)
      ? isSessionBusy(sessionId) && isAwaitingPermission(messages)
      : isAwaitingPermission(messages, { includeTerminal: true });
  };

  interface SessionSpec {
    id?: string;
    agent: AgentProfile;
    cwd: string;
    name: string;
    /** Terminal agents only: the CLI flags to start with. */
    options?: SpawnOptions;
    forkedFrom?: string;
    initialMessages?: ChatMessage[];
    worktree?: SessionWorktree | null;
  }

  /** Records a new session and shows it; the agent is started by its engine. */
  const recordSession = ({ id, agent, cwd, name, options, forkedFrom, initialMessages, worktree }: SessionSpec): Session => {
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
      worktree: worktree ?? null,
    };
    updateState((prev) => ({ ...prev, sessions: [session, ...prev.sessions] }));
    if (initialMessages) updateMessages(session.id, () => initialMessages);
    setActiveSessionId(session.id);
    return session;
  };

  /** A terminal agent gets only the text: its files are already typed into it. */
  const startSession = (spec: SessionSpec, first?: FirstMessage) => {
    const session = recordSession(spec);
    if (isAcp(session)) void acp.start(session, first, acpChoices);
    else pty.start(session, spec.options ?? spawnOptionsFor(spec.agent, draft), first?.text);
  };

  /**
   * Starts a session in the active workspace with the agent picked for it, in
   * a new worktree of it when Worktree is on.
   */
  const handleNewSession = async (first?: FirstMessage) => {
    // The backend rejects relative and missing cwds, so never spawn without a path.
    if (!activeWorkspace) {
      setNotice(NO_FOLDER_NOTICE);
      return;
    }
    if (!newSessionAgent) {
      setNotice(NO_AGENT_NOTICE);
      return;
    }
    rememberFolder(activeWorkspace);
    const name = first ? titleFor(first) : nextSessionName(sessions);
    let worktree: SessionWorktree | null = null;
    let cwd = activeWorkspace.path;
    if (isWorktreeOn && canUseWorktree) {
      setIsCreatingWorktree(true);
      try {
        ({ worktree, cwd } = await createSessionWorktree(activeWorkspace.path, name));
      } catch (error) {
        setNotice(`Could not create a worktree: ${String(error)}`);
        // The user may have opened another session meanwhile: the message goes
        // back into the new session it was written for, not that one's composer.
        openNewSession(activeWorkspace.path, newSessionAgent.id);
        if (first) composerRef.current?.restore(first.text, first.attachments);
        return;
      } finally {
        setIsCreatingWorktree(false);
      }
    }
    setPickedAgentId(null);
    startSession({ agent: newSessionAgent, cwd, name, worktree }, first);
  };

  /** Makes `path` the active workspace; a folder only old sessions still use is added back to the recents. */
  const chooseFolder = (path: string) => {
    if (workspaces.some((ws) => ws.path === path)) selectWorkspace(path);
    else rememberFolder({ name: folderNameOf(path), path });
  };

  /**
   * Shows a new, empty session: the folder and agent can still be changed in
   * the composer, and the agent starts with the first message.
   */
  const openNewSession = (path?: string, agentId?: string) => {
    if (path) chooseFolder(path);
    setPickedAgentId(agentId ?? null);
    setActiveSessionId("");
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
      // A fork works in the same checkout as its source.
      worktree: source.worktree,
      initialMessages: messages.slice(0, index + 1),
    };
    // A native fork needs the source agent alive; after it exited, fall back to a handoff.
    if (isAcp(source) && source.status === "running" && isLatest && acp.canFork(source.id)) {
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
      startSession({ ...spec, options: spawnOptionsFor(agent, baseOptions) }, { text: buildForkPrompt(handoffPath) });
    } catch (error) {
      setNotice(`Could not fork the session: ${String(error)}`);
    }
  };

  const handleSelectSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    // An agent picked for a new session that was never started is forgotten.
    setPickedAgentId(null);
    const selected = sessionById(sessionId);
    const workspacePath = selected && workspacePathOf(selected);
    if (workspacePath && workspaces.some((ws) => ws.path === workspacePath)) selectWorkspace(workspacePath);
  };

  const navigateTo = (sessionId: string | null) => {
    if (sessionId) handleSelectSession(sessionId);
  };

  const handleRevealFolder = () => {
    if (!filesFolder) return;
    invoke("reveal_in_finder", { path: filesFolder.path }).catch((error) => {
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

  /** Ends a session's agent when it runs; resolves with whether it is stopped. */
  const stopAgent = (session: Session | undefined): Promise<boolean> => {
    if (session?.status !== "running") return Promise.resolve(true);
    return isAcp(session) ? acp.stop(session.id) : pty.stop(session.id);
  };

  /**
   * After a session leaves the list, the most recent listed one is shown if it
   * was. Read from the latest sessions: an archive may have waited for its
   * agent while other sessions were archived or deleted.
   */
  const selectNextAfter = (sessionId: string) =>
    setActiveSessionId((current) =>
      current === sessionId
        ? mostRecentSessionId(sessionsRef.current.filter((s) => s.id !== sessionId && isListed(s)))
        : current,
    );

  const handleDeleteSession = (sessionId: string) => {
    const session = sessionById(sessionId);
    const stopped = stopAgent(session);
    pty.forget(sessionId);
    navigation.remove(sessionId);
    updateState((prev) => removeSessionFrom(prev, sessionId));
    removeTranscript(sessionId);
    if (session) {
      void removeSessionWorktree(session, sessions, stopped).then((kept) => kept && setNotice(kept));
    }
    selectNextAfter(sessionId);
  };

  const handleRenameSession = (sessionId: string, name: string) =>
    patchSession(sessionId, { name, namedByUser: true });

  const handlePinSession = (sessionId: string, isPinned: boolean) => patchSession(sessionId, { pinned: isPinned });

  /**
   * Archiving hides a session and ends its agent; its conversation and pin
   * stay, and an ACP session can be continued after unarchiving it. A session
   * whose agent cannot be stopped stays listed, so nothing runs out of sight.
   */
  const handleArchiveSession = async (sessionId: string, isArchived: boolean) => {
    if (!isArchived) {
      patchSession(sessionId, { archivedAt: null });
      return;
    }
    const session = sessionById(sessionId);
    const isRunning = session?.status === "running";
    if (!(await stopAgent(session))) {
      setNotice(`Did not archive "${session?.name ?? "the session"}": its agent could not be stopped.`);
      return;
    }
    // A stopped agent ends no turn itself: requests it was waiting on are answered as closed.
    if (isRunning) updateMessages(sessionId, closeTurn);
    const now = Date.now();
    patchSession(sessionId, { archivedAt: now, ...(isRunning ? { status: "terminated", endedAt: now } : {}) });
    selectNextAfter(sessionId);
  };

  const sendTo = async (sessionId: string, message: FirstMessage) => {
    const session = sessionById(sessionId);
    // A numbered session takes its title from the first thing the user asks.
    const isFirstMessage = !(transcripts[sessionId]?.some((m) => m.role === "user") ?? false);
    const sent = await (isAcp(session)
      ? acp.send(sessionId, message.text, message.attachments)
      : pty.send(sessionId, message.text));
    if (sent && session && isFirstMessage && isAutoName(session.name) && !session.namedByUser) {
      patchSession(sessionId, { name: titleFor(message) });
    }
  };

  /** Continues an ended ACP session: a fresh agent process loads it, then gets the message. */
  const resumeSession = (session: Session, message: FirstMessage) => {
    if (!session.acpSessionId) return;
    // Continuing an archived session brings it back into the list.
    patchSession(session.id, { status: "running", endedAt: null, exitCode: null, archivedAt: null });
    void acp.resume(session, session.acpSessionId, message, acpChoices);
  };

  /** Sends to the active session, continues it when it can be resumed, or starts a new one. */
  const handleSendMessage = (text: string, attachments?: string[]) => {
    const message = { text, attachments };
    if (activeSession && isActiveRunning) void sendTo(activeSession.id, message);
    else if (activeSession && isResumable) resumeSession(activeSession, message);
    else void handleNewSession(message);
  };

  const chooseOption = (sessionId: string, cardId: string, optionId: string) =>
    acp.chooseOption(sessionId, transcripts[sessionId], cardId, optionId);

  usePopoutHost({
    sessions,
    transcripts,
    ensureLoaded,
    statusOf: (sessionId) => ({
      isBusy: isSessionBusy(sessionId),
      isWaiting: isSessionWaiting(sessionId),
      contextUsage: isAcp(sessionById(sessionId)) ? acp.info[sessionId]?.usage : undefined,
    }),
    onAction: (sessionId: string, action: PopoutAction) => {
      if (action.kind === "send") void sendTo(sessionId, { text: action.text });
      else if (action.kind === "stop") handleInterrupt(sessionId);
      else if (action.kind === "choose-option") chooseOption(sessionId, action.cardId, action.optionId);
      else pty.resolveCard(sessionId, action.key, action.cardId, action.status);
    },
  });

  // A new session is not in the history: Back from it returns to the session viewed last.
  const lastViewedSessionId = navigation.current && sessionById(navigation.current) ? navigation.current : null;
  const canGoBack = isNewSessionDraft ? lastViewedSessionId !== null : navigation.canGoBack;

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
  // A terminal agent shows its real screen: live, or the last one while it is still in memory.
  const showsTerminal =
    Boolean(activeSession) && !isAcp(activeSession) && (isActiveRunning || ptyOutput.has(activeSessionId));
  // A live ACP session's own commands; before it runs, the ones its agent offered last time.
  const composerCommands = isActiveRunning
    ? isAcp(activeSession)
      ? acp.info[activeSessionId]?.commands
      : undefined
    : draftAgent?.transport === TRANSPORT_ACP
      ? state.agentOptions?.[draftAgent.id]?.commands
      : undefined;

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
        workspaceName={activeSession ? folderNameOf(workspacePathOf(activeSession)) : activeWorkspace?.name}
        workspacePath={shownFolderPath}
        branch={workspaceDetails?.branch ?? undefined}
        canGoBack={canGoBack}
        canGoForward={navigation.canGoForward}
        onBack={() => navigateTo(isNewSessionDraft ? lastViewedSessionId : navigation.back())}
        onForward={() => navigateTo(navigation.forward())}
        onToggleFiles={filesFolder ? () => sidePanel.toggle("files") : undefined}
        isFilesOpen={sidePanel.open === "files" && Boolean(filesFolder)}
        onToggleChanges={filesFolder && isRepository ? () => sidePanel.toggle("changes") : undefined}
        isChangesOpen={sidePanel.open === "changes" && Boolean(filesFolder) && isRepository}
        changeCount={sidePanel.changes.changes?.length}
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
          onNewSession={() => openNewSession()}
          onSelectSession={handleSelectSession}
          onNewSessionIn={openNewSession}
          defaultAgentId={defaultAgentId ?? undefined}
          onOpenFolder={() => void openFolder()}
          isSessionBusy={isSessionBusy}
          isSessionWaiting={isSessionWaiting}
          onStopSession={handleInterrupt}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onPinSession={handlePinSession}
          onArchiveSession={(sessionId, isArchived) => void handleArchiveSession(sessionId, isArchived)}
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
          {authRequest && (
            <AuthPanel
              agentName={agents.find((a) => a.id === authRequest.profileId)?.name ?? authRequest.profileId}
              methods={authRequest.methods}
              status={authRequest.status}
              error={authRequest.error}
              onSignIn={signIn}
              onDismiss={dismissSignIn}
            />
          )}
          {showsTerminal ? (
            <TerminalView
              sessionId={activeSessionId}
              output={ptyOutput}
              isLive={isActiveTerminal}
              onInput={(data) => void pty.sendRaw(activeSessionId, data)}
              onResize={(cols, rows) => pty.resize(activeSessionId, cols, rows)}
            />
          ) : activeSession && (currentMessages.length > 0 || isSessionBusy(activeSessionId)) ? (
            <ChatCanvas
              conversationId={activeSessionId}
              messages={currentMessages}
              agentName={activeAgent?.name}
              onForkBranch={(messageId) => void handleFork(messageId)}
              onSendPtyInput={(input) => void pty.sendRaw(activeSessionId, input)}
              onApproveAction={(key, cardId) => pty.resolveCard(activeSessionId, key, cardId, "approved")}
              onRejectAction={(key, cardId) => pty.resolveCard(activeSessionId, key, cardId, "rejected")}
              onChooseOption={(cardId, optionId) => chooseOption(activeSessionId, cardId, optionId)}
              isWorking={isSessionBusy(activeSessionId) && !isAwaitingPermission(currentMessages)}
            />
          ) : isNewSessionDraft ? (
            <NewSessionView
              workspace={activeWorkspace}
              details={workspaceDetails}
              agentName={newSessionAgent?.name}
            />
          ) : (
            <EmptySessionState />
          )}

          {/* A live terminal agent takes input in its own screen. */}
          <div className={isActiveTerminal ? "hidden" : "p-4 flex justify-center"}>
            <ComposerDock
              controls={composer.controls}
              optionsLocked={composer.locked}
              isThinking={Boolean(activeSession) && isSessionBusy(activeSessionId)}
              onStop={activeSession ? () => handleInterrupt(activeSessionId) : undefined}
              disabled={isCreatingWorktree || (!isActiveRunning && !isResumable && !canStartSession)}
              placeholder={
                isActiveRunning
                  ? undefined
                  : isCreatingWorktree
                    ? CREATING_WORKTREE_PLACEHOLDER
                    : isResumable
                    ? RESUME_PLACEHOLDER
                    : canStartSession
                      ? NEW_SESSION_PLACEHOLDER
                      : NO_WORKSPACE_PLACEHOLDER
              }
              onSendMessage={handleSendMessage}
              attachAsFiles={isActiveRunning ? isAcp(activeSession) : draftAgent?.transport === TRANSPORT_ACP}
              onAttach={pickFiles}
              handleRef={composerRef}
              commands={composerCommands}
              contextUsage={isActiveRunning && isAcp(activeSession) ? acp.info[activeSessionId]?.usage : undefined}
              folder={
                isNewSessionDraft
                  ? {
                      folders: workspaces,
                      selectedPath: activeWorkspacePath,
                      onSelect: chooseFolder,
                      onOpenFolder: () => void openFolder(),
                      worktree: canUseWorktree ? { isOn: isWorktreeOn, onChange: setIsWorktreeOn } : undefined,
                    }
                  : undefined
              }
              agent={
                isNewSessionDraft && newSessionAgent
                  ? {
                      options: agents.filter((a) => a.detected).map((a) => ({ value: a.id, label: a.name })),
                      selected: newSessionAgent.id,
                      onChange: (agentId) => setPickedAgentId(agentId ?? null),
                    }
                  : undefined
              }
            />
          </div>

        </article>
        {sidePanel.open === "changes" && filesFolder && isRepository && (
          <ChangesPanel
            key={filesFolder.path}
            rootPath={filesFolder.path}
            rootName={filesFolder.name}
            branch={workspaceDetails?.branch ?? undefined}
            changes={sidePanel.changes.changes}
            version={sidePanel.changes.version}
            onReload={sidePanel.changes.reload}
            onClose={sidePanel.close}
          />
        )}
        {sidePanel.open === "files" && filesFolder && (
          <FilesPanel
            key={filesFolder.path}
            rootPath={filesFolder.path}
            rootName={filesFolder.name}
            onClose={sidePanel.close}
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
