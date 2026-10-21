import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Sparkles, User } from "lucide-react";
import { ActionCard } from "./ActionCard";
import { ElicitationCard } from "./chat/ElicitationCard";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MessageActionBar } from "./MessageActionBar";
import { UserMessageBar } from "./chat/UserMessageBar";
import { AttachmentChips } from "./composer/AttachmentChips";
import { ToolCallList } from "./chat/ToolCallList";
import { PlanList, ThinkingBlock, WorkingIndicator } from "./chat/ReplyExtras";
import { useReadAloud } from "../hooks/useReadAloud";
import { formatRelativeTime } from "../lib/relative-time";
import type { ChatMessage, ElicitationAnswer } from "../types";

export type { ChatMessage, ToolExecution } from "../types";

/** Header label for agent messages when the host does not name the agent. */
const DEFAULT_AGENT_NAME = "Agent";
const COPIED_FEEDBACK_MS = 2000;

/** How close to the bottom still counts as "following" new output. */
const STICK_TO_BOTTOM_PX = 80;

/** No label for a message replayed from the agent's history, which gives no per-message time. */
function timeLabelOf(message: ChatMessage): string | undefined {
  return message.hasKnownTime === false ? undefined : formatRelativeTime(message.timestamp);
}

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
  const visibleMessages = messages.filter(hasSomethingToShow);
  const lastMessage = visibleMessages[visibleMessages.length - 1];

  // Follow new output to the bottom while the user is there; once they scroll
  // up to read, leave the view alone.
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const handleScroll = () => {
    const el = containerRef.current;
    if (el) isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_PX;
  };
  // A message the user just sent, or another conversation opened, always
  // brings the view down to the newest output. The view itself stays mounted,
  // so switching conversations does not stop Read aloud.
  const lastIdRef = useRef(lastMessage?.id);
  const conversationRef = useRef(conversationId);
  useLayoutEffect(() => {
    const el = containerRef.current;
    const isNewUserMessage = lastMessage?.role === "user" && lastMessage.id !== lastIdRef.current;
    const isOtherConversation = conversationId !== conversationRef.current;
    lastIdRef.current = lastMessage?.id;
    conversationRef.current = conversationId;
    if (isNewUserMessage || isOtherConversation) isAtBottomRef.current = true;
    if (el && isAtBottomRef.current) el.scrollTop = el.scrollHeight;
    // lastMessage derives from messages, so messages is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, isWorking, conversationId]);

  const handleCopyMessage = (id: string, content: string) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(content);
      setCopiedMessageId(id);
      setTimeout(() => setCopiedMessageId(null), COPIED_FEEDBACK_MS);
    }
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      data-testid="chat-canvas-container"
      className="flex-1 overflow-y-auto px-6 py-6 space-y-6"
    >
      {header && <div className="mx-auto w-full max-w-3xl">{header}</div>}
      {visibleMessages.map((msg) => {
        const isUser = msg.role === "user";

        return (
          <div
            key={msg.id}
            data-testid={`chat-message-${msg.id}`}
            className={`flex flex-col ${
              isUser ? "items-end" : "items-start"
            } w-full max-w-3xl mx-auto`}
          >
            {/* Header info */}
            <div className="flex items-center gap-2 mb-1.5 px-1">
              {isUser ? (
                <>
                  <span className="text-xs text-fg-muted">You</span>
                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-hover text-fg-secondary">
                    <User className="h-3 w-3" />
                  </div>
                </>
              ) : (
                <>
                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-2 border border-border text-fg-muted">
                    <Sparkles className="h-3 w-3" />
                  </div>
                  <span className="text-xs font-medium text-fg-secondary">
                    {agentName}
                  </span>
                </>
              )}
            </div>

            {/* The user's message sits in a bubble; the agent's reply sits on the background. */}
            <div
              className={`w-full text-left ${
                isUser
                  ? "rounded-2xl p-4 bg-surface-2 border border-border text-fg max-w-xl"
                  : "px-1 text-fg-secondary"
              }`}
            >
              {msg.thinking && (
                // A reply is done once its turn ended or anything came after it.
                <ThinkingBlock text={msg.thinking} isDone={Boolean(msg.isComplete) || msg !== lastMessage} />
              )}
              {msg.plan && msg.plan.length > 0 && <PlanList entries={msg.plan} />}
              {msg.tools && msg.tools.length > 0 && <ToolCallList tools={msg.tools} />}

              {/* Message Markdown Body */}
              {msg.content && <MarkdownRenderer content={msg.content} />}
              {msg.attachments && msg.attachments.length > 0 && (
                <div className={msg.content ? "mt-2" : undefined}>
                  <AttachmentChips paths={msg.attachments} />
                </div>
              )}

              {/* The agent's permission request, answered with one of its options */}
              {msg.actionCard && (
                <ActionCard
                  card={msg.actionCard}
                  onChoose={
                    onChooseOption ? (optionId) => onChooseOption(msg.actionCard!.id, optionId) : undefined
                  }
                />
              )}

              {/* The agent's request for input or to open a page; keyed so typed values never move between cards */}
              {msg.elicitation && (
                <ElicitationCard
                  key={msg.elicitation.key}
                  card={msg.elicitation}
                  agentName={agentName}
                  onAnswer={onAnswerElicitation}
                  onReopen={onReopenElicitationUrl}
                />
              )}
            </div>

            {isUser && (
              <UserMessageBar
                timeLabel={timeLabelOf(msg)}
                copied={copiedMessageId === msg.id}
                onCopy={() => handleCopyMessage(msg.id, msg.content)}
                onRewind={onRewind ? () => onRewind(msg.id) : undefined}
              />
            )}

            {/* Message Action Bar at bottom of Agent message */}
            {!isUser && (
              <MessageActionBar
                copied={copiedMessageId === msg.id}
                timeLabel={timeLabelOf(msg)}
                onCopy={() => handleCopyMessage(msg.id, msg.content)}
                onFork={onForkBranch ? () => onForkBranch(msg.id) : undefined}
                readAloud={
                  readAloud.supported
                    ? {
                        speaking: readAloud.speakingMessageId === msg.id,
                        onToggle: () => readAloud.toggle(msg.id, msg.content),
                      }
                    : undefined
                }
              />
            )}
          </div>
        );
      })}
      {isWorking && <WorkingIndicator />}
    </div>
  );
}
