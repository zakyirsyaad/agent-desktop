import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MessageRow } from "./chat/MessageRow";
import { WorkingIndicator } from "./chat/ReplyExtras";
import { useLatest } from "../hooks/useLatest";
import { useReadAloud } from "../hooks/useReadAloud";
import { useStickToBottom } from "../hooks/useStickToBottom";
import type { ChatMessage, ElicitationAnswer } from "../types";

export type { ChatMessage, ToolExecution } from "../types";

/** Header label for agent messages when the host does not name the agent. */
const DEFAULT_AGENT_NAME = "Agent";
const COPIED_FEEDBACK_MS = 2000;

/** An agent reply with no text, reasoning, plan, tools or card is noise, not a message. */
function hasSomethingToShow(msg: ChatMessage): boolean {
  if (msg.role === "user") return true;
  return Boolean(
    msg.content.trim() || msg.thinking || msg.plan?.length || msg.tools?.length || msg.actionCard || msg.elicitation,
  );
}

export interface ChatCanvasProps {
  messages: ChatMessage[];
  /** Display name of the agent behind this conversation, e.g. "Claude Code". */
  agentName?: string;
  onForkBranch?: (messageId: string) => void;
  /** Answers an ACP permission card with one of the agent's options. */
  onChooseOption?: (cardId: string, optionId: string) => void;
  /** Answers an agent's request for input or to open a page. */
  onAnswerElicitation?: (key: string, answer: ElicitationAnswer) => void;
  /** Opens an agent's page again after the user opened it once. */
  onReopenElicitationUrl?: (key: string) => void;
  /** True while the agent works on its turn: shown under the last message. */
  isWorking?: boolean;
  /** Which conversation is shown; switching starts at its newest output. */
  conversationId?: string;
  /** Starts again from before one of your messages; Rewind is offered only when given. */
  onRewind?: (messageId: string) => void;
  /** Shown above the conversation, e.g. the folder and branch the session works in. */
  header?: ReactNode;
}

export function ChatCanvas({
  messages,
  agentName = DEFAULT_AGENT_NAME,
  onForkBranch,
  onChooseOption,
  onAnswerElicitation,
  onReopenElicitationUrl,
  isWorking = false,
  conversationId,
  onRewind,
  header,
}: ChatCanvasProps) {
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const readAloud = useReadAloud();
  const visibleMessages = useMemo(() => messages.filter(hasSomethingToShow), [messages]);
  const lastMessage = visibleMessages[visibleMessages.length - 1];
  // While a turn runs, its replies (one or more, after the last user message)
  // are still being written: copying or forking them makes no sense yet.
  let lastUserIndex = -1;
  for (let i = visibleMessages.length - 1; i >= 0; i -= 1) {
    if (visibleMessages[i].role === "user") {
      lastUserIndex = i;
      break;
    }
  }
  const runningTurnStartsAt = isWorking ? lastUserIndex + 1 : visibleMessages.length;

  // Follow new output to the bottom while the user is there; once they scroll
  // up to read, leave the view alone.
  const stickToBottom = useStickToBottom();
  // A message the user just sent, or another conversation opened, always
  // brings the view down to the newest output. The view itself stays mounted,
  // so switching conversations does not stop Read aloud.
  const lastIdRef = useRef(lastMessage?.id);
  const conversationRef = useRef(conversationId);
  useLayoutEffect(() => {
    const isNewUserMessage = lastMessage?.role === "user" && lastMessage.id !== lastIdRef.current;
    const isOtherConversation = conversationId !== conversationRef.current;
    lastIdRef.current = lastMessage?.id;
    conversationRef.current = conversationId;
    if (isNewUserMessage || isOtherConversation) stickToBottom.scrollToBottom();
    else stickToBottom.followNewContent();
    // lastMessage derives from messages, so messages is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, isWorking, conversationId, stickToBottom.scrollToBottom, stickToBottom.followNewContent]);

  const onForkRef = useLatest(onForkBranch);
  const onRewindRef = useLatest(onRewind);
  const onChooseOptionRef = useLatest(onChooseOption);
  const onAnswerElicitationRef = useLatest(onAnswerElicitation);
  const onReopenElicitationUrlRef = useLatest(onReopenElicitationUrl);

  const handleCopyMessage = useCallback((id: string, content: string) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(content);
      setCopiedMessageId(id);
      setTimeout(() => setCopiedMessageId(null), COPIED_FEEDBACK_MS);
    }
  }, []);
  // These take the message id, so every row gets the same function and an
  // unchanged row is not re-rendered when the host makes a new closure.
  const handleFork = useCallback((id: string) => onForkRef.current?.(id), [onForkRef]);
  const handleRewind = useCallback((id: string) => onRewindRef.current?.(id), [onRewindRef]);
  const handleChooseOption = useCallback(
    (cardId: string, optionId: string) => onChooseOptionRef.current?.(cardId, optionId),
    [onChooseOptionRef],
  );
  const handleAnswerElicitation = useCallback(
    (key: string, answer: ElicitationAnswer) => onAnswerElicitationRef.current?.(key, answer),
    [onAnswerElicitationRef],
  );
  const handleReopenElicitationUrl = useCallback(
    (key: string) => onReopenElicitationUrlRef.current?.(key),
    [onReopenElicitationUrlRef],
  );
  const { toggle: toggleReadAloud } = readAloud;
  const handleToggleReadAloud = useCallback(
    (id: string, content: string) => toggleReadAloud(id, content),
    [toggleReadAloud],
  );

  return (
    <div
      ref={stickToBottom.containerRef}
      onScroll={stickToBottom.onScroll}
      onWheel={stickToBottom.onWheel}
      onKeyDown={stickToBottom.onKeyDown}
      onTouchStart={stickToBottom.onTouchStart}
      onTouchMove={stickToBottom.onTouchMove}
      data-testid="chat-canvas-container"
      className="flex-1 overflow-y-auto px-6 py-6 space-y-6"
    >
      {header && <div className="mx-auto w-full max-w-3xl">{header}</div>}
      {visibleMessages.map((msg, index) => (
        <MessageRow
          key={msg.id}
          message={msg}
          agentName={agentName}
          isLast={msg === lastMessage}
          showActions={msg.role !== "user" && index < runningTurnStartsAt}
          copied={copiedMessageId === msg.id}
          speaking={readAloud.speakingMessageId === msg.id}
          readAloudSupported={readAloud.supported}
          onCopy={handleCopyMessage}
          onFork={onForkBranch ? handleFork : undefined}
          onRewind={onRewind ? handleRewind : undefined}
          onToggleReadAloud={handleToggleReadAloud}
          onChooseOption={onChooseOption ? handleChooseOption : undefined}
          onAnswerElicitation={onAnswerElicitation ? handleAnswerElicitation : undefined}
          onReopenElicitationUrl={onReopenElicitationUrl ? handleReopenElicitationUrl : undefined}
        />
      ))}
      {isWorking && <WorkingIndicator />}
    </div>
  );
}
