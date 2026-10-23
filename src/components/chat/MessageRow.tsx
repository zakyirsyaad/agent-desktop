import { memo } from "react";
import { Sparkles, User } from "lucide-react";
import { ActionCard } from "../ActionCard";
import { ElicitationCard } from "./ElicitationCard";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { MessageActionBar } from "../MessageActionBar";
import { UserMessageBar } from "./UserMessageBar";
import { AttachmentChips } from "../composer/AttachmentChips";
import { ToolsPart } from "./ToolsPart";
import { PlanUpdatedRow, ThinkingBlock } from "./ReplyExtras";
import { partsOf } from "../../lib/acp-events";
import { formatRelativeTime } from "../../lib/relative-time";
import type { ChatMessage, ElicitationAnswer } from "../../types";

/** No label for a message replayed from the agent's history, which gives no per-message time. */
function timeLabelOf(message: ChatMessage): string | undefined {
  return message.hasKnownTime === false ? undefined : formatRelativeTime(message.timestamp);
}

export interface MessageRowProps {
  message: ChatMessage;
  agentName: string;
  /** True for the newest visible message: its reasoning is not done yet. */
  isLast: boolean;
  /** True for the turn the user is watching: its diffs open themselves. */
  isCurrentTurn: boolean;
  /** True once the agent's turn has ended: only then are its actions offered. */
  showActions: boolean;
  copied: boolean;
  speaking: boolean;
  readAloudSupported: boolean;
  onCopy: (messageId: string, content: string) => void;
  onFork?: (messageId: string) => void;
  onRewind?: (messageId: string) => void;
  onToggleReadAloud: (messageId: string, content: string) => void;
  onChooseOption?: (cardId: string, optionId: string) => void;
  onAnswerElicitation?: (key: string, answer: ElicitationAnswer) => void;
  onReopenElicitationUrl?: (key: string) => void;
}

/**
 * One message and its controls. Memoized so a streamed chunk re-renders only
 * the reply it belongs to, not every row above it in a long conversation.
 * Every prop is stable for a message that did not change: the message object,
 * booleans, and callbacks that take the message id.
 */
export const MessageRow = memo(function MessageRow({
  message,
  agentName,
  isLast,
  isCurrentTurn,
  showActions,
  copied,
  speaking,
  readAloudSupported,
  onCopy,
  onFork,
  onRewind,
  onToggleReadAloud,
  onChooseOption,
  onAnswerElicitation,
  onReopenElicitationUrl,
}: MessageRowProps) {
  const isUser = message.role === "user";
  const toolsById = new Map((message.tools ?? []).map((tool) => [tool.id, tool]));
  // Older transcripts have no parts; render them with the same tool rows as a
  // reply saved with parts, without rewriting the saved data.
  const parts = partsOf(message);

  return (
    <div
      data-testid={`chat-message-${message.id}`}
      className={`flex flex-col ${isUser ? "items-end" : "items-start"} w-full max-w-3xl mx-auto`}
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
            <span className="text-xs font-medium text-fg-secondary">{agentName}</span>
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
        {message.thinking && (
          // A reply is done once its turn ended or anything came after it.
          <ThinkingBlock text={message.thinking} isDone={Boolean(message.isComplete) || !isLast} />
        )}
        {message.plan && message.plan.length > 0 && <PlanUpdatedRow entries={message.plan} />}
        {message.attachments && message.attachments.length > 0 && (
          <div className={parts.length > 0 ? "mb-2" : undefined}>
            <AttachmentChips paths={message.attachments} />
          </div>
        )}
        {parts.length > 0 && (
          <div className="space-y-4">
            {parts.map((part, index) => {
              if (part.kind === "text") return <MarkdownRenderer key={index} content={part.text} />;
              const tools = part.toolIds.flatMap((id) => toolsById.get(id) ?? []);
              if (tools.length === 0) return null;
              return <ToolsPart key={index} tools={tools} isCurrentTurn={isCurrentTurn} />;
            })}
          </div>
        )}

        {/* The agent's permission request, answered with one of its options */}
        {message.actionCard && (
          <ActionCard
            card={message.actionCard}
            onChoose={
              onChooseOption ? (optionId) => onChooseOption(message.actionCard!.id, optionId) : undefined
            }
          />
        )}

        {/* The agent's request for input or to open a page; keyed so typed values never move between cards */}
        {message.elicitation && (
          <ElicitationCard
            key={message.elicitation.key}
            card={message.elicitation}
            agentName={agentName}
            onAnswer={onAnswerElicitation}
            onReopen={onReopenElicitationUrl}
          />
        )}
      </div>

      {isUser && (
        <UserMessageBar
          timeLabel={timeLabelOf(message)}
          copied={copied}
          onCopy={() => onCopy(message.id, message.content)}
          onRewind={onRewind ? () => onRewind(message.id) : undefined}
        />
      )}

      {/* Message Action Bar at bottom of Agent message, once its turn has ended */}
      {!isUser && showActions && (
        <MessageActionBar
          copied={copied}
          timeLabel={timeLabelOf(message)}
          onCopy={() => onCopy(message.id, message.content)}
          onFork={onFork ? () => onFork(message.id) : undefined}
          readAloud={
            readAloudSupported
              ? { speaking, onToggle: () => onToggleReadAloud(message.id, message.content) }
              : undefined
          }
        />
      )}
    </div>
  );
});
