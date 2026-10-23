import { useCallback, useEffect, useState } from "react";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
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
import { currentPlan } from "../lib/plan";
import { MAIN_WINDOW_LABEL } from "../lib/window-mode";
import { useAgentProfiles } from "../hooks/useDiscovery";
import { TopBar } from "./TopBar";
import { ChatCanvas } from "./ChatCanvas";
import { ComposerDock } from "./ComposerDock";
import { RemovedAgentPanel } from "./RemovedAgentPanel";
import { HistoryElsewhereNote } from "./chat/HistoryElsewhereNote";

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
  const [removedAgentName, setRemovedAgentName] = useState<string | null>(null);
  const { agents } = useAgentProfiles(() => {});

  useEffect(() => {
    let isCancelled = false;
    let unlisten: UnlistenFn | null = null;
    listen<SessionSnapshotPayload>(SESSION_SNAPSHOT_EVENT, ({ payload }) => {
      if (payload.sessionId !== sessionId) return;
      setSession(payload.session);
      setMessages(payload.messages);
      setStatus(payload.status ?? IDLE_STATUS);
      setRemovedAgentName(payload.removedAgentName ?? null);
    })
      .then((stop) => {
        if (isCancelled) stop();
        else unlisten = stop;
        // Ask for the first snapshot only once we are listening for it.
        return emitTo(MAIN_WINDOW_LABEL, POPOUT_READY_EVENT, { sessionId });
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
      emitTo(MAIN_WINDOW_LABEL, POPOUT_CLOSED_EVENT, { sessionId }).catch(() => {});
    };
    window.addEventListener('pagehide', announceClosed);
    return () => {
      window.removeEventListener('pagehide', announceClosed);
      announceClosed();
    };
  }, [sessionId]);

  const forward = useCallback(
    (action: PopoutAction) => {
      // Only the main window gets it: an answer can hold what the user typed.
      emitTo(MAIN_WINDOW_LABEL, POPOUT_ACTION_EVENT, { sessionId, action }).catch(() => {});
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
        plan={currentPlan(messages)}
      />
      <article className="flex-1 flex flex-col bg-bg relative overflow-hidden">
        {messages.length > 0 || session?.historyElsewhere ? (
          <ChatCanvas
            messages={messages}
            agentName={agent?.name}
            header={
              session?.historyElsewhere ? (
                <HistoryElsewhereNote agentName={agent?.name ?? "the agent"} />
              ) : undefined
            }
            onChooseOption={(cardId, optionId) => forward({ kind: "choose-option", cardId, optionId })}
            onAnswerElicitation={(key, answer) => forward({ kind: "answer-elicitation", key, answer })}
            onReopenElicitationUrl={(key) => forward({ kind: "reopen-elicitation-url", key })}
            isWorking={status.isBusy && !status.isWaiting}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-fg-subtle">
            {session ? "No messages yet." : "Connecting to the main window…"}
          </div>
        )}
        <div className="p-4 flex justify-center">
          {removedAgentName ? (
            <RemovedAgentPanel agentName={removedAgentName} onAdd={() => forward({ kind: "add-agent" })} />
          ) : (
            <ComposerDock
              disabled={!isRunning}
              placeholder={isRunning ? undefined : "This session is not running"}
              onSendMessage={(text) => forward({ kind: "send", text })}
              isThinking={status.isBusy}
              onStop={() => forward({ kind: "stop" })}
              contextUsage={status.contextUsage}
            />
          )}
        </div>
      </article>
    </main>
  );
}
