import { useState } from "react";
import { Check, Sparkles, User, Wrench, Clock } from "lucide-react";
import { ActionCard } from "./ActionCard";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MessageActionBar } from "./MessageActionBar";
import { useReadAloud } from "../hooks/useReadAloud";
import type { ChatMessage } from "../types";

export type { ChatMessage, ToolExecution } from "../types";

/** Header label for agent messages when the host does not name the agent. */
const DEFAULT_AGENT_NAME = "Agent";
const COPIED_FEEDBACK_MS = 2000;

export interface ChatCanvasProps {
  messages: ChatMessage[];
  /** Display name of the agent behind this conversation, e.g. "Aider". */
  agentName?: string;
  onSendPtyInput: (input: string) => void;
  onApproveAction?: (key: string, cardId?: string) => void;
  onRejectAction?: (key: string, cardId?: string) => void;
  onForkBranch?: (messageId: string) => void;
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
}: ChatCanvasProps) {
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const readAloud = useReadAloud();

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
      data-testid="chat-canvas-container"
      className="flex-1 overflow-y-auto px-6 py-6 space-y-6"
    >
      {messages.map((msg) => {
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

            {/* Bubble content */}
            <div
              className={`w-full rounded-2xl p-4 text-left transition-colors ${
                isUser
                  ? "bg-[#18181b] border border-neutral-800 text-neutral-100 max-w-xl"
                  : "bg-[#080808] border border-neutral-800/80 text-neutral-200"
              }`}
            >
              {/* Tool Execution Chips */}
              {msg.tools && msg.tools.length > 0 && (
                <div className="mb-4 space-y-2">
                  {msg.tools.map((tool) => (
                    <div
                      key={tool.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-neutral-800/80 bg-neutral-950/60 px-3 py-1.5 font-mono text-xs text-neutral-300"
                    >
                      <div className="flex items-center gap-2 overflow-hidden">
                        <Wrench className="h-3.5 w-3.5 text-neutral-500 shrink-0" />
                        <span className="truncate">
                          Tool: {tool.name}({tool.args})
                        </span>
                      </div>
                      <div className="shrink-0">
                        {tool.status === "completed" && (
                          <span className="inline-flex items-center gap-1 rounded bg-emerald-950/60 border border-emerald-800/50 px-2 py-0.5 text-[11px] text-emerald-400">
                            <Check className="h-3 w-3" />
                            Completed
                          </span>
                        )}
                        {tool.status === "running" && (
                          <span className="inline-flex items-center gap-1 rounded bg-amber-950/60 border border-amber-800/50 px-2 py-0.5 text-[11px] text-amber-400 animate-pulse">
                            <Clock className="h-3 w-3" />
                            Running
                          </span>
                        )}
                        {tool.status === "failed" && (
                          <span className="inline-flex items-center gap-1 rounded bg-rose-950/60 border border-rose-800/50 px-2 py-0.5 text-[11px] text-rose-400">
                            Failed
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Message Markdown Body */}
              <MarkdownRenderer content={msg.content} />

              {/* Interactive Action Card if approval request */}
              {msg.actionCard && (
                <ActionCard
                  card={msg.actionCard}
                  onApprove={(key) => handleApprove(key, msg.actionCard!.id)}
                  onReject={(key) => handleReject(key, msg.actionCard!.id)}
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
    </div>
  );
}
