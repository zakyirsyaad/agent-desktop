import { useCallback, useEffect, useState } from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ChatMessage, Session } from "../types";
import { TRANSPORT_ACP } from "../types";
import { ptySessionControls } from "../lib/composer-controls";
import {
  POPOUT_ACTION_EVENT,
  POPOUT_CLOSED_EVENT,
  POPOUT_READY_EVENT,
  SESSION_SNAPSHOT_EVENT,
  type PopoutAction,
  type SessionSnapshotPayload,
} from "../lib/popout-bridge";
import { folderNameOf } from "../lib/session-helpers";
import { useAgentProfiles } from "../hooks/useDiscovery";
import { TopBar } from "./TopBar";
import { ChatCanvas } from "./ChatCanvas";
import { ComposerDock } from "./ComposerDock";
import { TerminalDrawer } from "./TerminalDrawer";

export interface PopoutAppProps {
  sessionId: string;
}

/**
 * A single session in its own window. It never writes state: the main window
 * owns parsing and persistence, sends snapshots here, and performs the actions
 * this window forwards.
 */
export function PopoutApp({ sessionId }: PopoutAppProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const { agents } = useAgentProfiles(() => {});

  useEffect(() => {
    let isCancelled = false;
    let unlisten: UnlistenFn | null = null;
    listen<SessionSnapshotPayload>(SESSION_SNAPSHOT_EVENT, ({ payload }) => {
      if (payload.sessionId !== sessionId) return;
      setSession(payload.session);
      setMessages(payload.messages);
    })
      .then((stop) => {
        if (isCancelled) stop();
        else unlisten = stop;
        // Ask for the first snapshot only once we are listening for it.
        return emit(POPOUT_READY_EVENT, { sessionId });
      })
      .catch(() => {});
    return () => {
      isCancelled = true;
      unlisten?.();
    };
  }, [sessionId]);

  // Tell the main window to stop syncing this session once the window goes away.
  useEffect(() => {
    const announceClosed = () => {
      emit(POPOUT_CLOSED_EVENT, { sessionId }).catch(() => {});
    };
    window.addEventListener('pagehide', announceClosed);
    return () => {
      window.removeEventListener('pagehide', announceClosed);
      announceClosed();
    };
  }, [sessionId]);

  const forward = useCallback(
    (action: PopoutAction) => {
      emit(POPOUT_ACTION_EVENT, { sessionId, action }).catch(() => {});
    },
    [sessionId],
  );

  const agent = agents.find((a) => a.id === session?.profileId);
  const isRunning = session?.status === "running";
  // An ACP session's live modes belong to the main window; change them there.
  const isAcp = session?.transport === TRANSPORT_ACP;

  return (
    <main className="flex h-screen w-screen flex-col bg-[#0a0a0a] text-neutral-200">
      <TopBar
        sessionName={session?.name}
        workspaceName={session ? folderNameOf(session.cwd) : undefined}
        isTerminalOpen={isTerminalOpen}
        onToggleTerminal={() => setIsTerminalOpen((prev) => !prev)}
      />
      <article className="flex-1 flex flex-col bg-[#000000] relative overflow-hidden">
        {messages.length > 0 ? (
          <ChatCanvas
            messages={messages}
            agentName={agent?.name}
            onSendPtyInput={(key) => forward({ kind: "resolve-card", key, status: "approved" })}
            onApproveAction={(key, cardId) => forward({ kind: "resolve-card", cardId, key, status: "approved" })}
            onRejectAction={(key, cardId) => forward({ kind: "resolve-card", cardId, key, status: "rejected" })}
            onChooseOption={(cardId, optionId) => forward({ kind: "choose-option", cardId, optionId })}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-neutral-500">
            {session ? "No messages yet." : "Connecting to the main window…"}
          </div>
        )}
        <div className="p-4 flex justify-center">
          <ComposerDock
            controls={agent && session && !isAcp ? ptySessionControls(agent, session) : undefined}
            optionsLocked
            disabled={!isRunning}
            placeholder={isRunning ? undefined : "This session is not running"}
            onSendMessage={(text) => forward({ kind: "send", text })}
          />
        </div>
        <TerminalDrawer
          isOpen={isTerminalOpen}
          sessionId={sessionId}
          sessionName={session?.name}
          isLive={isRunning && !isAcp}
          onClose={() => setIsTerminalOpen(false)}
        />
      </article>
    </main>
  );
}
