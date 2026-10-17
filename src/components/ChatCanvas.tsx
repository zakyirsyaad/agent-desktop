import { useLayoutEffect, useRef, useState } from "react";
import { Sparkles, User } from "lucide-react";
import { ActionCard } from "./ActionCard";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MessageActionBar } from "./MessageActionBar";
import { AttachmentChips } from "./composer/AttachmentChips";
import { ToolCallList } from "./chat/ToolCallList";
import { PlanList, ThinkingBlock, WorkingIndicator } from "./chat/ReplyExtras";
import { useReadAloud } from "../hooks/useReadAloud";
import type { ChatMessage } from "../types";

export type { ChatMessage, ToolExecution } from "../types";

/** Header label for agent messages when the host does not name the agent. */
const DEFAULT_AGENT_NAME = "Agent";
const COPIED_FEEDBACK_MS = 2000;

/** How close to the bottom still counts as "following" new output. */
const STICK_TO_BOTTOM_PX = 80;

/** An agent reply with no text, reasoning, plan, tools or card is noise, not a message. */
function hasSomethingToShow(msg: ChatMessage): boolean {
  if (msg.role === "user") return true;
  return Boolean(
    msg.content.trim() || msg.thinking || msg.plan?.length || msg.tools?.length || msg.actionCard,
  );
}

export interface ChatCanvasProps {
  messages: ChatMessage[];
  /** Display name of the agent behind this conversation, e.g. "Aider". */
  agentName?: string;
  onSendPtyInput: (input: string) => void;
  onApproveAction?: (key: string, cardId?: string) => void;
  onRejectAction?: (key: string, cardId?: string) => void;
  onForkBranch?: (messageId: string) => void;
  /** Answers an ACP permission card with one of the agent's options. */
  onChooseOption?: (cardId: string, optionId: string) => void;
  /** True while the agent works on its turn: shown under the last message. */
  isWorking?: boolean;
  /** Which conversation is shown; switching starts at its newest output. */
  conversationId?: string;
}

/**
 * Format relative timestamp (e.g. "Just now", "2 minutes ago", "5 hours ago")
 */
function formatRelativeTime(timestamp: number): string {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 60) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} hours ago`;
  const diffDays = Math.floor(diffHour / 24);
  return `${diffDays}d ago`;
}

export function ChatCanvas({
  messages,
  agentName = DEFAULT_AGENT_NAME,
  onSendPtyInput,
  onApproveAction,
  onRejectAction,
  onForkBranch,
  onChooseOption,
  isWorking = false,
  conversationId,
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

  const handleApprove = (key: string, cardId: string) => {
    if (onApproveAction) {
      onApproveAction(key, cardId);
    } else {
      onSendPtyInput(key);
    }
  };

  const handleReject = (key: string, cardId: string) => {
    if (onRejectAction) {
      onRejectAction(key, cardId);
    } else {
      onSendPtyInput(key);
    }
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      data-testid="chat-canvas-container"
      className="flex-1 overflow-y-auto px-6 py-6 space-y-6"
    >
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
                  <span className="text-xs text-neutral-400">You</span>
                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-neutral-800 text-neutral-300">
                    <User className="h-3 w-3" />
                  </div>
                </>
              ) : (
                <>
                  <div className="flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900 border border-neutral-800 text-amber-500">
                    <Sparkles className="h-3 w-3" />
                  </div>
                  <span className="text-xs font-medium text-neutral-300">
                    {agentName}
                  </span>
                </>
              )}
            </div>

            {/* The user's message sits in a bubble; the agent's reply sits on the background. */}
            <div
              className={`w-full text-left ${
                isUser
                  ? "rounded-2xl p-4 bg-[#18181b] border border-neutral-800 text-neutral-100 max-w-xl"
                  : "px-1 text-neutral-200"
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

              {/* Interactive Action Card if approval request */}
              {msg.actionCard && (
                <ActionCard
                  card={msg.actionCard}
                  onApprove={(key) => handleApprove(key, msg.actionCard!.id)}
                  onReject={(key) => handleReject(key, msg.actionCard!.id)}
                  onChoose={
                    onChooseOption ? (optionId) => onChooseOption(msg.actionCard!.id, optionId) : undefined
                  }
                />
              )}
            </div>

            {/* Message Action Bar at bottom of Agent message */}
            {!isUser && (
              <MessageActionBar
                copied={copiedMessageId === msg.id}
                timeLabel={formatRelativeTime(msg.timestamp)}
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
