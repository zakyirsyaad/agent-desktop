import { useCallback, useEffect, useState } from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ChatMessage, Session } from "../types";
import {
  POPOUT_ACTION_EVENT,
  POPOUT_CLOSED_EVENT,
  POPOUT_READY_EVENT,
  SESSION_SNAPSHOT_EVENT,
  type PopoutAction,
  type SessionLiveStatus,
  type SessionSnapshotPayload,
  IDLE_STATUS,
} from "../lib/popout-bridge";
import { folderNameOf } from "../lib/session-helpers";
import { useAgentProfiles } from "../hooks/useDiscovery";
import { TopBar } from "./TopBar";
import { ChatCanvas } from "./ChatCanvas";
import { ComposerDock } from "./ComposerDock";

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
  const [status, setStatus] = useState<SessionLiveStatus>(IDLE_STATUS);
  const { agents } = useAgentProfiles(() => {});

  useEffect(() => {
    let isCancelled = false;
    let unlisten: UnlistenFn | null = null;
    listen<SessionSnapshotPayload>(SESSION_SNAPSHOT_EVENT, ({ payload }) => {
      if (payload.sessionId !== sessionId) return;
      setSession(payload.session);
      setMessages(payload.messages);
      setStatus(payload.status ?? IDLE_STATUS);
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

  return (
    <main className="flex h-screen w-screen flex-col bg-bg text-fg-secondary">
      <TopBar
        sessionName={session?.name}
        workspaceName={session ? folderNameOf(session.cwd) : undefined}
      />
      <article className="flex-1 flex flex-col bg-bg relative overflow-hidden">
        {messages.length > 0 ? (
          <ChatCanvas
            messages={messages}
            agentName={agent?.name}
            onChooseOption={(cardId, optionId) => forward({ kind: "choose-option", cardId, optionId })}
            isWorking={status.isBusy && !status.isWaiting}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-fg-subtle">
            {session ? "No messages yet." : "Connecting to the main window…"}
          </div>
        )}
        <div className="p-4 flex justify-center">
          <ComposerDock
            disabled={!isRunning}
            placeholder={isRunning ? undefined : "This session is not running"}
            onSendMessage={(text) => forward({ kind: "send", text })}
            isThinking={status.isBusy}
            onStop={() => forward({ kind: "stop" })}
            contextUsage={status.contextUsage}
          />
        </div>
      </article>
    </main>
  );
}
