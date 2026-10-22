import { useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore, GitBranch, MoreHorizontal, Pencil, Pin, PinOff, Square, Trash2 } from "lucide-react";
import type { Session } from "../../types";
import type { SessionNode } from "../../lib/session-helpers";
import { useDismiss } from "../../hooks/useDismiss";
import { AgentLogo } from "../AgentLogo";

const ROW_ACTION =
  "mr-1 rounded p-1 text-fg-subtle opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto hover:text-danger focus-ring";
const MENU_ITEM =
  "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg";

/** What every session row needs besides its own session. */
export interface SessionListContext {
  activeSessionId?: string;
  agentNameOf: (profileId: string) => string | undefined;
  isSessionBusy: (sessionId: string) => boolean;
  isSessionWaiting: (sessionId: string) => boolean;
  onSelectSession: (sessionId: string) => void;
  onStopSession?: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, name: string) => void;
  onPinSession?: (sessionId: string, isPinned: boolean) => void;
  onArchiveSession?: (sessionId: string, isArchived: boolean) => void;
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
        className="mr-1 rounded bg-danger-surface px-1.5 py-0.5 text-[10px] font-medium text-danger focus-ring"
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

/** A session's ⋯ menu: rename, pin and archive. */
function SessionMenu({ session, onRename, context }: {
  session: Session;
  onRename?: () => void;
  context: SessionListContext;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useDismiss(containerRef, isOpen, () => setIsOpen(false));
  const { onPinSession } = context;
  // Archiving ends the agent, so, like Delete, it waits until the agent is not working.
  const onArchiveSession = context.isSessionBusy(session.id) ? undefined : context.onArchiveSession;
  if (!onRename && !onPinSession && !onArchiveSession) return null;
  const pick = (action: () => void) => () => {
    setIsOpen(false);
    action();
  };
  const isArchived = Boolean(session.archivedAt);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label={`More actions for ${session.name}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className={`${ROW_ACTION} hover:text-fg-secondary ${isOpen ? "opacity-100" : ""}`}
      >
        <MoreHorizontal size={12} />
      </button>
      {isOpen && (
        <div
          role="menu"
          aria-label={`Actions for ${session.name}`}
          className="absolute right-0 top-full z-50 mt-1 w-40 rounded-lg border border-border bg-surface-3 p-1 shadow-popover"
        >
          {onRename && (
            <button type="button" role="menuitem" onClick={pick(onRename)} className={MENU_ITEM}>
              <Pencil size={12} aria-hidden="true" /> Rename
            </button>
          )}
          {onPinSession && !isArchived && (
            <button
              type="button"
              role="menuitem"
              onClick={pick(() => onPinSession(session.id, !session.pinned))}
              className={MENU_ITEM}
            >
              {session.pinned ? <PinOff size={12} aria-hidden="true" /> : <Pin size={12} aria-hidden="true" />}
              {session.pinned ? "Unpin" : "Pin"}
            </button>
          )}
          {onArchiveSession && (
            <button
              type="button"
              role="menuitem"
              onClick={pick(() => onArchiveSession(session.id, !isArchived))}
              className={MENU_ITEM}
            >
              {isArchived ? <ArchiveRestore size={12} aria-hidden="true" /> : <Archive size={12} aria-hidden="true" />}
              {isArchived ? "Unarchive" : "Archive"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The name field a session's row turns into while it is renamed. */
function RenameField({ session, onDone }: { session: Session; onDone: (name: string | null) => void }) {
  const [name, setName] = useState(session.name);
  // Enter, Escape and the blur that follows them finish once.
  const isDoneRef = useRef(false);
  const finish = (value: string | null) => {
    if (isDoneRef.current) return;
    isDoneRef.current = true;
    onDone(value);
  };
  return (
    <input
      autoFocus
      onFocus={(e) => e.target.select()}
      value={name}
      onChange={(e) => setName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(name);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={() => finish(name)}
      aria-label={`Rename ${session.name}`}
      className="mx-1 my-0.5 min-w-0 flex-1 rounded border border-border-strong bg-surface-2 px-1.5 py-1 text-xs text-fg focus-ring"
    />
  );
}

function SessionRow({ session, context }: { session: Session; context: SessionListContext }) {
  const [isRenaming, setIsRenaming] = useState(false);
  const { onStopSession, onDeleteSession, onRenameSession } = context;
  const isActive = session.id === context.activeSessionId;
  const isBusy = context.isSessionBusy(session.id);
  const isWaiting = context.isSessionWaiting(session.id);
  const agentName = context.agentNameOf(session.profileId);
  const status = isWaiting
    ? {
        label: "Waiting for your answer",
        title: "The agent waits for your answer",
        dot: "bg-status-attention",
        pulse: false,
      }
    : isBusy
      ? {
          label: "Agent working",
          title: "The agent is working",
          dot: "bg-status-running",
          pulse: true,
        }
      : session.hasUnread
        ? {
            label: "New activity",
            title: "The agent finished while you were in another session",
            dot: "bg-status-unread",
            pulse: false,
          }
        : null;

  if (isRenaming) {
    return (
      <div className="flex items-center">
        <RenameField
          session={session}
          onDone={(name) => {
            setIsRenaming(false);
            const trimmed = name?.trim();
            if (trimmed && trimmed !== session.name) onRenameSession?.(session.id, trimmed);
          }}
        />
      </div>
    );
  }

  return (
    <div
      data-testid={`session-row-${session.id}`}
      className={`group relative flex items-center rounded-md transition-colors ${
        isActive
          ? "bg-surface-hover text-fg font-medium"
          : "text-fg-muted hover:bg-surface-hover hover:text-fg-secondary"
      }`}
    >
      <button
        type="button"
        onClick={() => context.onSelectSession(session.id)}
        title={[session.name, agentName, session.worktree?.branch, status?.title].filter(Boolean).join(" · ")}
        className="flex-1 min-w-0 flex items-center px-2 py-1.5 pr-12 text-left"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <AgentLogo profileId={session.profileId} name={agentName ?? session.profileId} size={12} />
          {session.worktree && (
            <GitBranch size={11} aria-label="In its own worktree" className="shrink-0 text-fg-muted" />
          )}
          <span className={`truncate ${session.hasUnread && !isBusy ? "font-medium text-fg" : ""}`}>
            {session.name}
          </span>
        </span>
      </button>
      {/* One fixed slot at the row's edge: the dot, replaced by the actions on hover or focus. */}
      <div data-testid="session-row-trailing" className="absolute inset-y-0 right-1 flex items-center">
        {status && (
          <span
            role="status"
            aria-label={status.label}
            className={`pointer-events-none h-1.5 w-1.5 rounded-full shrink-0 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 ${status.dot} ${
              status.pulse ? "animate-pulse motion-reduce:animate-none" : ""
            }`}
          />
        )}
        <div className="absolute inset-y-0 right-0 flex items-center">
          <SessionMenu
            session={session}
            onRename={onRenameSession ? () => setIsRenaming(true) : undefined}
            context={context}
          />
          {isBusy && onStopSession && (
            <button
              type="button"
              aria-label="Stop session"
              title="Stop the agent's current turn"
              onClick={() => onStopSession(session.id)}
              className={ROW_ACTION}
            >
              <Square size={11} />
            </button>
          )}
          {!isBusy && onDeleteSession && <DeleteButton onDelete={() => onDeleteSession(session.id)} />}
        </div>
      </div>
    </div>
  );
}

/** Sessions with their forks nested beneath them, joined by a guide line. */
export function SessionTree({ nodes, label, context, isNested = false }: {
  nodes: SessionNode[];
  label: string;
  context: SessionListContext;
  isNested?: boolean;
}) {
  return (
    <ul
      aria-label={label}
      className={isNested ? "ml-3 mt-0.5 space-y-0.5 border-l border-border pl-1.5" : "space-y-0.5"}
    >
      {nodes.map(({ session, children }) => (
        <li key={session.id}>
          <SessionRow session={session} context={context} />
          {children.length > 0 && (
            <SessionTree nodes={children} label={`Forks of ${session.name}`} context={context} isNested />
          )}
        </li>
      ))}
    </ul>
  );
}
