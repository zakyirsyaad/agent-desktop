import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { ChatCanvas } from "./components/ChatCanvas";
import { ComposerDock, type ComposerHandle } from "./components/ComposerDock";
import { FilesPanel } from "./components/FilesPanel";
import { EmptySessionState, FileDropOverlay, NoticeBanner } from "./components/AppPlaceholders";
import { AuthPanel } from "./components/AuthPanel";
import { AgentInstallPanel } from "./components/AgentInstallPanel";
import { readWindowMode } from "./lib/window-mode";
import { pickerLabelOf } from "./lib/install-plan";
import { TerminalView } from "./components/TerminalView";
import { NewSessionView } from "./components/workspace/NewSessionView";
import { WorkspaceSummary } from "./components/workspace/WorkspaceSummary";
import { ChangesPanel } from "./components/changes/ChangesPanel";
import { DiffView } from "./components/changes/DiffView";
import { totalsOf } from "./lib/diff-stats";
import { useSidePanel } from "./hooks/useSidePanel";
import { useTurnsEnded } from "./hooks/useTurnsEnded";
import { usePullRequest } from "./hooks/usePullRequest";
import { useRepoPullRequests } from "./hooks/useRepoPullRequests";
import { useAgentAuth } from "./hooks/useAgentAuth";
import { useDraftAgentCheck } from "./hooks/useDraftAgentCheck";
import { useLatest } from "./hooks/useLatest";
import { createSessionWorktree } from "./lib/session-worktree";
import {
  EMPTY_DRAFT,
  isWaitingForAnswer,
  newSessionRecord,
  spawnOptionsFor,
  titleFor,
  type SessionSpec,
} from "./lib/session-start";
import { createPtyOutputStore } from "./lib/pty-output-store";
import { isAwaitingPermission } from "./lib/acp-events";
import {
  folderNameOf,
  isAcpSession as isAcp,
  isListed,
  isAutoName,
  workspacePathOf,
  mostRecentSessionId,
  nextSessionName,
  patchSessionIn,
} from "./lib/session-helpers";
import { useAppearance } from "./hooks/useAppearance";
import { usePersistedState } from "./hooks/usePersistedState";
import { useBackgroundTasks } from "./hooks/useBackgroundTasks";
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
import { useSessionActions } from "./hooks/useSessionActions";
import { useSessionFork } from "./hooks/useSessionFork";
import { useSessionRewind } from "./hooks/useSessionRewind";
import { useUnreadMarks } from "./hooks/useUnreadMarks";
import type { PopoutAction } from "./lib/popout-bridge";
import { usePtyEngine } from "./hooks/session-engine/usePtyEngine";
import { useAcpEngine, type AttentionReason, type FirstMessage } from "./hooks/session-engine/useAcpEngine";
import type { AcpConfigOption } from "./hooks/useAcpSessions";
import { attentionBody, notifyIfAway } from "./lib/notify";
import { pickFiles } from "./lib/file-picker";
import { formatAttachmentPath } from "./lib/attachments";
import { useFileDrop } from "./hooks/useFileDrop";
import { resolveDefaultAgentId } from "./lib/agent-readiness";
import { isInUse, withAutoEnabled } from "./lib/enabled-agents";
import type { SessionDraft } from "./lib/composer-controls";
import { composerCommandsFor, composerPlaceholder, composerStateFor } from "./lib/composer-state";
import {
  NO_CHOICES,
  rememberedChoice,
  withPreferred,
  withProbed,
  withRewound,
  type AcpChoices,
  type AgentOptions,
} from "./lib/acp-draft";
import type { Session, SessionWorktree, Settings } from "./types";
import { TRANSPORT_ACP } from "./types";

const NO_FOLDER_NOTICE = "Open a project folder first: use the Open folder button next to Workspaces.";
const NO_AGENT_NOTICE =
  "No supported agent is installed. Install Claude Code, Qwen Code, Codex, Aider or omp, then check again in Settings.";

// Only the main window installs agents; a popout only mirrors it.
const IS_MAIN_WINDOW = readWindowMode(window.location.search).kind === "main";

// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export default function App() {
  const [notice, setNotice] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [draft, setDraft] = useState<SessionDraft>(EMPTY_DRAFT);
  /** The agent picked for the next new session; null means the default from Settings. */
  const [pickedAgentId, setPickedAgentId] = useState<string | null>(null);
  /** Whether the next new session runs in its own worktree (a git repository only). */
  const [isWorktreeOn, setIsWorktreeOn] = useState(false);
  const [isCreatingWorktree, setIsCreatingWorktree] = useState(false);
  /** Bumped after each of the active agent's turns, so its folder's branch is read again. */
  const [branchCheck, setBranchCheck] = useState(0);
  const [acpChoices, setAcpChoices] = useState<AcpChoices>(NO_CHOICES);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);
  const [ptyOutput] = useState(createPtyOutputStore);
  const agentAuth = useAgentAuth();
  const { authRequest, requestSignIn, signIn, dismiss: dismissSignIn } = agentAuth;

  const reportError = useCallback((message: string) => setNotice(message), []);
  const { state, isLoaded, updateState } = usePersistedState(reportError);
  useAppearance(state.settings.appearance, isLoaded, reportError);
  const { transcripts, ensureLoaded, updateMessages, removeTranscript } = useTranscripts(reportError);
  const { agents, refresh: refreshAgents } = useAgentProfiles(reportError);
  // Installed registry agents join the ones in use, and each one's version is recorded.
  useEffect(() => {
    if (!isLoaded || agents.length === 0) return;
    updateState((prev) => {
      const settings = withAutoEnabled(prev.settings, agents);
      return settings === prev.settings ? prev : { ...prev, settings };
    });
  }, [agents, isLoaded, updateState]);
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
  // Only the agents in use are offered: the defaults, installed ones and the terminal agents found.
  const agentsInUse = agents.filter((agent) => isInUse(agent, state.settings));
  // A registry agent not installed yet is offered too: picking it shows its Install panel.
  const pickableAgents = agentsInUse.filter((agent) => agent.source === "registry" || agent.detected);
  const defaultAgentId = resolveDefaultAgentId(agentsInUse, state.settings.defaultAgentId);
  const newSessionAgentId = pickableAgents.find((a) => a.id === pickedAgentId)?.id ?? defaultAgentId;
  const newSessionAgent = agents.find((a) => a.id === newSessionAgentId);
  // No session is selected: the window shows a new one, not started until its first message.
  const isNewSessionDraft = !activeSession;
  // A session shows the folder it runs in, even one no longer in the recents.
  const shownFolderPath = activeSession?.cwd ?? activeWorkspacePath;
  const workspaceDetails = useWorkspaceDetails(shownFolderPath, reportError, branchCheck);
  // Files and Reveal act on the folder the top bar names. The backend browses
  // every saved session's folder, so one gone from the recents keeps them.
  const isRepository = Boolean(workspaceDetails?.branch);
  const canUseWorktree = isNewSessionDraft && isRepository;
  const filesFolder =
    workspaces.find((ws) => ws.path === shownFolderPath) ??
    (activeSession ? { name: folderNameOf(activeSession.cwd), path: activeSession.cwd } : undefined);

  // An ended ACP session continues with its own agent: in the agent's own
  // session when it has one, else (rewound) in a fresh one handed the conversation.
  const isResumable =
    isAcp(activeSession) && activeSession?.status !== "running" && activeAgent?.detected === true;
  const draftAgent = isResumable ? activeAgent : newSessionAgent;
  const isDraftAgentReady = draftAgent?.availability === "ready";

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

  const visitSession = navigation.visit;
  useEffect(() => {
    if (!activeSessionId) return;
    ensureLoaded(activeSessionId);
    visitSession(activeSessionId);
  }, [activeSessionId, ensureLoaded, visitSession]);

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

  /** Keeps a model or effort pick (as the agent settled it), so the agent's next session starts with it too. */
  const rememberPick = (profileId: string, configId: string, value: string, reported?: AcpConfigOption[]) => {
    const preferredConfig = rememberedChoice(state.agentOptions?.[profileId], configId, value, reported);
    if (!preferredConfig) return;
    // The lists on offer follow too (an effort list depends on its model), so the next draft offers the same.
    rememberAgentOptions(profileId, { preferredConfig, ...(reported?.length ? { configOptions: reported } : {}) });
  };

  // A draft asks its ACP agent what it offers, and whether it needs a sign-in, before the first message.
  const agentCheck = useDraftAgentCheck({
    agent: isActiveRunning || !isDraftAgentReady ? undefined : draftAgent,
    cwd: shownFolderPath ?? undefined,
    agentOptions: state.agentOptions,
    rememberProbed: (profileId, probed) =>
      updateState((prev) => ({
        ...prev,
        agentOptions: { ...prev.agentOptions, [profileId]: withProbed(prev.agentOptions?.[profileId], probed) },
      })),
    auth: agentAuth,
  });

  // Read when an agent answers, seconds after the closure that waits for it was made.
  const activeSessionIdRef = useLatest(activeSessionId);
  const engineDeps = { sessions, agents, updateMessages, patchSession, reportError };
  const pty = usePtyEngine({ ...engineDeps, output: ptyOutput });
  const acp = useAcpEngine({
    ...engineDeps,
    rememberOptions: rememberAgentOptions,
    onAttention: (sessionId, reason) => notifyAttention(sessionId, reason),
    onAuthRequired: (session, methods, unsent) => {
      requestSignIn(session.profileId, session.cwd, methods);
      // The composer on screen may be another session's by now: the message goes back only into its own.
      if (unsent && session.id === activeSessionIdRef.current) composerRef.current?.restore(unsent.text, unsent.attachments);
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
  const { rewind, restart, isRestarting, cancelRestart, rewoundOptionsOf } = useSessionRewind({
    agents,
    transcripts,
    acp,
    patchSession,
    updateMessages,
    // The user may have opened another session meanwhile: the message goes back
    // into the session it was written for, not that one's composer.
    onRestore: (sessionId, text, attachments) => {
      setActiveSessionId(sessionId);
      composerRef.current?.restore(text, attachments);
    },
    onNotice: setNotice,
  });

  const isSessionBusy = (sessionId: string) =>
    isAcp(sessionById(sessionId)) ? acp.isBusy(sessionId) || isRestarting(sessionId) : pty.isBusy(sessionId);

  // What a new or resumed session starts with: the picks made for it, else the
  // model picked last; a rewound session's fresh agent, the model and effort it
  // ran with, checked against its own lists (another model offers other efforts).
  const rewound = activeSession && isResumable ? rewoundOptionsOf(activeSession.id) : undefined;
  const agentOptions = withRewound(state.agentOptions, draftAgent?.id, rewound);
  const startChoices = draftAgent ? withPreferred(acpChoices, agentOptions?.[draftAgent.id]) : acpChoices;

  /**
   * Dropped files: typed into a live terminal agent, otherwise added to the
   * message. A name with control characters is left out: a terminal would
   * take them as keys (Enter, Ctrl-C), not as part of a path.
   */
  const handleDroppedFiles = (dropped: string[]) => {
    const paths = dropped.filter((path) => !CONTROL_CHARACTER.test(path));
    if (paths.length < dropped.length) {
      setNotice("Left out a dropped file whose name has control characters.");
    }
    if (paths.length === 0) return;
    if (activeSession?.status === "running" && !isAcp(activeSession)) {
      void pty.sendRaw(activeSession.id, `${paths.map(formatAttachmentPath).join(" ")} `);
    } else {
      composerRef.current?.insertPaths(paths);
    }
  };
  const isDraggingFiles = useFileDrop(handleDroppedFiles, reportError);

  const turnsEnded = useTurnsEnded(Boolean(activeSessionId) && isSessionBusy(activeSessionId));
  const sidePanel = useSidePanel(filesFolder?.path, isRepository, turnsEnded, reportError);
  const diffStats = sidePanel.headStats ? totalsOf(sidePanel.headStats) : undefined;
  // The folder whose diff view is expanded: another folder's view starts unexpanded.
  const [expandedDiffFolder, setExpandedDiffFolder] = useState<string | null>(null);
  const isDiffOpen = sidePanel.open === "diff" && Boolean(filesFolder) && isRepository;
  const isDiffExpanded = isDiffOpen && expandedDiffFolder === filesFolder?.path;
  // An expanded diff view starts over the next time it opens.
  useEffect(() => {
    if (!isDiffOpen) setExpandedDiffFolder(null);
  }, [isDiffOpen]);
  const pullRequest = usePullRequest(
    isRepository ? shownFolderPath : undefined,
    workspaceDetails?.branch ?? undefined,
    turnsEnded,
    reportError,
  );
  // Read only while the Changes panel shows them.
  const repoPullRequests = useRepoPullRequests(
    sidePanel.open === "changes" && isRepository ? filesFolder?.path : undefined,
    turnsEnded,
    reportError,
  );
  const openPullRequest = (url: string) => {
    invoke("open_external_url", { url }).catch((error) => setNotice(`Could not open the pull request: ${String(error)}`));
  };
  // The agent may have checked out another branch: the top bar reads it again after each turn.
  useEffect(() => setBranchCheck(turnsEnded), [turnsEnded]);
  const isSessionWaiting = (sessionId: string) =>
    isWaitingForAnswer(sessionById(sessionId), transcripts[sessionId] ?? [], () => isSessionBusy(sessionId));

  /** Records a new session and shows it; the agent is started by its engine. */
  const recordSession = (spec: SessionSpec): Session => {
    const session = newSessionRecord(spec);
    const { initialMessages } = spec;
    updateState((prev) => ({ ...prev, sessions: [session, ...prev.sessions] }));
    if (initialMessages) updateMessages(session.id, () => initialMessages);
    setActiveSessionId(session.id);
    return session;
  };

  /** A terminal agent gets only the text: its files are already typed into it. */
  const startSession = (spec: SessionSpec, first?: FirstMessage) => {
    const session = recordSession(spec);
    if (isAcp(session)) void acp.start(session, first, startChoices);
    else pty.start(session, spec.options ?? spawnOptionsFor(spec.agent, draft), first?.text);
    // The picks went with the session; a later draft starts from the model picked last.
    setAcpChoices(NO_CHOICES);
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
    // A fresh draft: picks left from an earlier one would override the model picked last.
    setAcpChoices(NO_CHOICES);
    setActiveSessionId("");
  };

  const forkSession = useSessionFork({
    source: activeSession,
    agents,
    transcripts,
    acp,
    recordSession,
    startSession,
    onNotice: setNotice,
  });

  const handleSelectSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    // An agent picked for a new session that was never started is forgotten.
    setPickedAgentId(null);
    const selected = sessionById(sessionId);
    const workspacePath = selected && workspacePathOf(selected);
    if (workspacePath && workspaces.some((ws) => ws.path === workspacePath)) selectWorkspace(workspacePath);
  };

  /** Stops the agent's current turn; the session stays open for the next message. */
  const handleInterrupt = (sessionId: string) => {
    // A rewound session's fresh agent has not started yet: only its start is called off.
    if (isRestarting(sessionId)) cancelRestart(sessionId);
    else if (isAcp(sessionById(sessionId))) acp.interrupt(sessionId, transcripts[sessionId]);
    else pty.interrupt(sessionId);
  };

  const backgroundTasks = useBackgroundTasks({
    sessions,
    isAcp,
    isBusy: acp.isBusy,
    busySince: acp.busySinceOf,
    needsApproval: (id) => isAwaitingPermission(transcripts[id] ?? []),
    onOpenSession: handleSelectSession,
    stopAgent: handleInterrupt,
    onError: reportError,
  });

  const navigateTo = (sessionId: string | null) => {
    if (sessionId) handleSelectSession(sessionId);
  };

  /** A workspace's files for @-mentions; a failure is reported and offers none. */
  const loadWorkspaceFiles = (root: string): Promise<string[]> =>
    invoke<string[]>("workspace_files", { root }).catch((error) => {
      setNotice(`Could not list the files to mention: ${String(error)}`);
      return [];
    });

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

  useUnreadMarks(sessions, activeSessionId, isSessionBusy, patchSession);

  const sessionActions = useSessionActions({
    sessions,
    setActiveSessionId,
    patchSession,
    updateState,
    updateMessages,
    removeTranscript,
    navigation,
    acp,
    pty,
    onNotice: setNotice,
  });

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

  /**
   * Continues an ended ACP session: a fresh agent process loads it, then gets
   * the message. A rewound one has no agent session left to load.
   */
  const resumeSession = (session: Session, message: FirstMessage) => {
    if (!session.acpSessionId) {
      void restart(session, message, startChoices);
      setAcpChoices(NO_CHOICES);
      return;
    }
    // Continuing an archived session brings it back into the list.
    patchSession(session.id, { status: "running", endedAt: null, exitCode: null, archivedAt: null });
    void acp.resume(session, session.acpSessionId, message, startChoices);
    setAcpChoices(NO_CHOICES);
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
    acpChoices: startChoices,
    setAcpChoices,
    agentOptions,
    acp,
    onPick: rememberPick,
  });
  const isActiveTerminal = isActiveRunning && !isAcp(activeSession);
  // A terminal agent shows its real screen: live, or the last one while it is still in memory.
  const showsTerminal =
    Boolean(activeSession) && !isAcp(activeSession) && (isActiveRunning || ptyOutput.has(activeSessionId));
  const composerCommands = composerCommandsFor({
    session: activeSession,
    isRunning: isActiveRunning,
    liveCommands: acp.info[activeSessionId]?.commands,
    draftAgent,
    agentOptions: state.agentOptions,
  });

  if (isLoaded && !state.settings.onboardingCompleted) {
    return (
      <Onboarding
        agents={agents}
        settings={state.settings}
        recentFolders={workspaces}
        suggestedFolders={suggestedFolders}
        onRecheckAgents={refreshAgents}
        onPickFolder={openFolder}
        onComplete={handleOnboardingComplete}
      />
    );
  }

  return (
    <main className="flex h-screen w-screen flex-col bg-bg text-fg-secondary">
      <TopBar
        sessionName={activeSession?.name}
        workspaceName={activeSession ? folderNameOf(workspacePathOf(activeSession)) : activeWorkspace?.name}
        workspacePath={shownFolderPath}
        branch={workspaceDetails?.branch ?? undefined}
        pullRequest={pullRequest}
        onOpenPullRequest={openPullRequest}
        canGoBack={canGoBack}
        canGoForward={navigation.canGoForward}
        onBack={() => navigateTo(isNewSessionDraft ? lastViewedSessionId : navigation.back())}
        onForward={() => navigateTo(navigation.forward())}
        onToggleFiles={filesFolder ? () => sidePanel.toggle("files") : undefined}
        isFilesOpen={sidePanel.open === "files" && Boolean(filesFolder)}
        onToggleChanges={filesFolder && isRepository ? () => sidePanel.toggle("changes") : undefined}
        isChangesOpen={sidePanel.open === "changes" && Boolean(filesFolder) && isRepository}
        diffStats={diffStats}
        onOpenDiff={() => sidePanel.show("diff")}
        onPopout={activeSession ? handlePopout : undefined}
        onOpenSettings={() => setIsSettingsOpen(true)}
        backgroundTasks={{
          tasks: backgroundTasks.tasks,
          isOpen: backgroundTasks.isMenuOpen,
          onOpenChange: backgroundTasks.setMenuOpen,
          onOpenTask: backgroundTasks.open,
          onStopTask: backgroundTasks.stop,
        }}
      />

      <section className="flex flex-1 overflow-hidden">
        <Sidebar
          workspaces={workspaces}
          activeWorkspacePath={activeWorkspacePath}
          sessions={sessions}
          activeSessionId={activeSessionId}
          agents={agents}
          settings={state.settings}
          onNewSession={() => openNewSession()}
          onSelectSession={handleSelectSession}
          onNewSessionIn={openNewSession}
          defaultAgentId={defaultAgentId ?? undefined}
          onOpenFolder={() => void openFolder()}
          isSessionBusy={isSessionBusy}
          isSessionWaiting={isSessionWaiting}
          onStopSession={handleInterrupt}
          onDeleteSession={sessionActions.deleteSession}
          onRenameSession={sessionActions.renameSession}
          onPinSession={sessionActions.pinSession}
          onArchiveSession={(sessionId, isArchived) => void sessionActions.archiveSession(sessionId, isArchived)}
          footer={
            <ProfileFooter
              name={userProfile.name}
              email={userProfile.email}
              version={userProfile.version}
              onOpenSettings={() => setIsSettingsOpen(true)}
            />
          }
        />

        <article className={`${isDiffOpen && isDiffExpanded ? "hidden" : "flex"} flex-1 flex-col bg-bg relative overflow-hidden`}>
          {isDraggingFiles && <FileDropOverlay />}
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
          {!isActiveRunning && draftAgent?.install_plan && IS_MAIN_WINDOW && <AgentInstallPanel agent={draftAgent} />}
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
              onForkBranch={(messageId) => void forkSession(messageId)}
              onRewind={isAcp(activeSession) ? (messageId) => void rewind(activeSession, messageId) : undefined}
              header={
                <div className="rounded-xl border border-border bg-surface-1 px-4 py-3">
                  <WorkspaceSummary
                    name={folderNameOf(workspacePathOf(activeSession))}
                    path={shownFolderPath ?? activeSession.cwd}
                    details={workspaceDetails}
                  />
                </div>
              }
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
              disabled={isCreatingWorktree || (!isActiveRunning && (!isDraftAgentReady || (!isResumable && !canStartSession)))}
              placeholder={composerPlaceholder({
                isRunning: isActiveRunning,
                isCreatingWorktree,
                isResumable,
                canStartSession,
              })}
              onSendMessage={handleSendMessage}
              attachAsFiles={isActiveRunning ? isAcp(activeSession) : draftAgent?.transport === TRANSPORT_ACP}
              onAttach={pickFiles}
              handleRef={composerRef}
              commands={composerCommands}
              note={
                !isActiveRunning && draftAgent && agentCheck.isProbing(draftAgent.id)
                  ? `Loading ${draftAgent.name}'s models and commands…`
                  : undefined
              }
              contextUsage={isActiveRunning && isAcp(activeSession) ? acp.info[activeSessionId]?.usage : undefined}
              mentions={filesFolder ? { root: filesFolder.path, loadFiles: () => loadWorkspaceFiles(filesFolder.path) } : undefined}
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
                      options: pickableAgents.map((a) => ({ value: a.id, label: pickerLabelOf(a) })),
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
            pullRequests={repoPullRequests}
            onOpenPullRequest={openPullRequest}
            diffStats={diffStats}
            onOpenDiff={() => sidePanel.show("diff")}
          />
        )}
        {isDiffOpen && filesFolder && (
          <DiffView
            key={filesFolder.path}
            rootPath={filesFolder.path}
            version={sidePanel.changes.version}
            isExpanded={isDiffExpanded}
            onToggleExpanded={() => setExpandedDiffFolder(isDiffExpanded ? null : filesFolder.path)}
            onClose={sidePanel.close}
            onError={reportError}
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
          appearance={state.settings.appearance}
          onChangeAppearance={(appearance) => updateSettings({ appearance })}
          agents={agentsInUse}
          defaultAgentId={state.settings.defaultAgentId}
          recentFolders={workspaces}
          onChangeDefaultAgent={(defaultAgentId) => updateSettings({ defaultAgentId })}
          onRemoveRecentFolder={removeFolder}
          onRunOnboarding={handleRunOnboarding}
          onRecheckAgents={refreshAgents}
          onClose={() => setIsSettingsOpen(false)}
        />
      )}
    </main>
  );
}
