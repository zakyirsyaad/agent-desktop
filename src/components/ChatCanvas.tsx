import { useState } from "react";
import {
  Copy,
  Check,
  GitBranch,
  Volume2,
  Sparkles,
  User,
  Wrench,
  Clock,
} from "lucide-react";
import { ActionCard } from "./ActionCard";
import type { ActionCard as ActionCardType } from "../types";

export interface ToolExecution {
  id: string;
  name: string;
  args: string;
  status: "running" | "completed" | "failed";
}

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  content: string;
  timestamp: number;
  tools?: ToolExecution[];
  actionCard?: ActionCardType;
}

export interface ChatCanvasProps {
  messages: ChatMessage[];
  onSendPtyInput: (input: string) => void;
  onForkBranch?: (messageId: string) => void;
  onEditActionCard?: (cardId: string) => void;
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

/**
 * Custom lightweight Markdown renderer to support headings, code blocks with
 * copy button, inline code, ordered lists, and paragraphs with zero external runtime deps.
 */
function MarkdownRenderer({ content }: { content: string }) {
  const [copiedCodeIndex, setCopiedCodeIndex] = useState<number | null>(null);

  const handleCopyCode = (code: string, index: number) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(code);
      setCopiedCodeIndex(index);
      setTimeout(() => setCopiedCodeIndex(null), 2000);
    }
  };

  // Parse lines into tokens: codeblocks, headings, list items, paragraphs
  const lines = content.split("\n");
  const blocks: Array<
    | { type: "code"; code: string; language?: string }
    | { type: "h1" | "h2" | "h3"; text: string }
    | { type: "ol"; items: string[] }
    | { type: "ul"; items: string[] }
    | { type: "p"; text: string }
  > = [];

  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  let codeLang = "";
  let currentOlItems: string[] = [];
  let currentUlItems: string[] = [];

  const flushLists = () => {
    if (currentOlItems.length > 0) {
      blocks.push({ type: "ol", items: [...currentOlItems] });
      currentOlItems = [];
    }
    if (currentUlItems.length > 0) {
      blocks.push({ type: "ul", items: [...currentUlItems] });
      currentUlItems = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code block check
    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        // End code block
        blocks.push({
          type: "code",
          code: codeBuffer.join("\n"),
          language: codeLang || undefined,
        });
        codeBuffer = [];
        codeLang = "";
        inCodeBlock = false;
      } else {
        // Start code block
        flushLists();
        inCodeBlock = true;
        codeLang = line.trim().slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    // Ordered list item: "1. item text"
    const olMatch = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (olMatch) {
      if (currentUlItems.length > 0) {
        blocks.push({ type: "ul", items: [...currentUlItems] });
        currentUlItems = [];
      }
      currentOlItems.push(olMatch[2]);
      continue;
    }

    // Unordered list item: "- item" or "* item"
    const ulMatch = line.match(/^\s*[-*]\s+(.*)$/);
    if (ulMatch) {
      if (currentOlItems.length > 0) {
        blocks.push({ type: "ol", items: [...currentOlItems] });
        currentOlItems = [];
      }
      currentUlItems.push(ulMatch[1]);
      continue;
    }

    // If non-list line, flush pending lists
    flushLists();

    // Headings
    if (line.startsWith("# ")) {
      blocks.push({ type: "h1", text: line.slice(2).trim() });
    } else if (line.startsWith("## ")) {
      blocks.push({ type: "h2", text: line.slice(3).trim() });
    } else if (line.startsWith("### ")) {
      blocks.push({ type: "h3", text: line.slice(4).trim() });
    } else if (line.trim().length > 0) {
      blocks.push({ type: "p", text: line });
    }
  }

  // Handle any remaining blocks
  if (inCodeBlock && codeBuffer.length > 0) {
    blocks.push({
      type: "code",
      code: codeBuffer.join("\n"),
      language: codeLang || undefined,
    });
  }
  flushLists();

  /**
   * Helper to render inline code like `package.json` and bold text **bold**
   */
  const renderInlineFormatted = (text: string) => {
    const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
    return parts.map((part, index) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
        return (
          <code
            key={index}
            className="rounded bg-neutral-900 border border-neutral-800 px-1.5 py-0.5 font-mono text-xs text-amber-300"
          >
            {part.slice(1, -1)}
          </code>
        );
      }
      if (part.startsWith("**") && part.endsWith("**") && part.length >= 4) {
        return (
          <strong key={index} className="font-semibold text-neutral-100">
            {part.slice(2, -2)}
          </strong>
        );
      }
      return part;
    });
  };

  return (
    <div className="space-y-3 text-neutral-200">
      {blocks.map((block, idx) => {
        if (block.type === "code") {
          return (
            <div
              key={idx}
              className="my-3 overflow-hidden rounded-xl border border-neutral-800 bg-[#0c0c0c]"
            >
              <div className="flex items-center justify-between border-b border-neutral-800/80 bg-neutral-900/60 px-3 py-1.5 text-[11px] font-mono text-neutral-400">
                <span>{block.language || "text"}</span>
                <button
                  type="button"
                  onClick={() => handleCopyCode(block.code, idx)}
                  aria-label="Copy code"
                  className="flex items-center gap-1 text-neutral-400 hover:text-neutral-200 transition-colors"
                >
                  {copiedCodeIndex === idx ? (
                    <>
                      <Check className="h-3 w-3 text-emerald-400" />
                      <span className="text-emerald-400">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
              <pre className="p-3 font-mono text-xs text-neutral-300 overflow-x-auto">
                <code>{block.code}</code>
              </pre>
            </div>
          );
        }

        if (block.type === "h1") {
          return (
            <h1
              key={idx}
              className="text-lg font-semibold tracking-tight text-neutral-100 pt-2"
            >
              {renderInlineFormatted(block.text)}
            </h1>
          );
        }

        if (block.type === "h2") {
          return (
            <h2
              key={idx}
              className="text-base font-semibold tracking-tight text-neutral-100 pt-1"
            >
              {renderInlineFormatted(block.text)}
            </h2>
          );
        }

        if (block.type === "h3") {
          return (
            <h3
              key={idx}
              className="text-sm font-semibold tracking-tight text-neutral-200"
            >
              {renderInlineFormatted(block.text)}
            </h3>
          );
        }

        if (block.type === "ol") {
          return (
            <ol
              key={idx}
              className="my-2 list-decimal space-y-1 pl-5 text-sm leading-relaxed text-neutral-300"
            >
              {block.items.map((item, itemIdx) => (
                <li key={itemIdx}>{renderInlineFormatted(item)}</li>
              ))}
            </ol>
          );
        }

        if (block.type === "ul") {
          return (
            <ul
              key={idx}
              className="my-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-neutral-300"
            >
              {block.items.map((item, itemIdx) => (
                <li key={itemIdx}>{renderInlineFormatted(item)}</li>
              ))}
            </ul>
          );
        }

        return (
          <p
            key={idx}
            className="text-sm leading-relaxed text-neutral-300 break-words"
          >
            {renderInlineFormatted(block.text)}
          </p>
        );
      })}
    </div>
  );
}

export function ChatCanvas({
  messages,
  onSendPtyInput,
  onForkBranch,
  onEditActionCard,
}: ChatCanvasProps) {
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  const handleCopyMessage = (id: string, content: string) => {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(content);
      setCopiedMessageId(id);
      setTimeout(() => setCopiedMessageId(null), 2000);
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
                    Claude Code
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
                  onApprove={(key) => onSendPtyInput(key)}
                  onReject={(key) => onSendPtyInput(key)}
                  onEdit={() =>
                    onEditActionCard && onEditActionCard(msg.actionCard!.id)
                  }
                />
              )}
            </div>

            {/* Message Action Bar at bottom of Agent message */}
            {!isUser && (
              <div className="flex items-center gap-3 mt-2 px-1 text-xs text-neutral-400">
                <button
                  type="button"
                  onClick={() => handleCopyMessage(msg.id, msg.content)}
                  aria-label="Copy message"
                  className="flex items-center gap-1 hover:text-neutral-200 transition-colors"
                >
                  {copiedMessageId === msg.id ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                      <span className="text-emerald-400">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>Copy</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => onForkBranch && onForkBranch(msg.id)}
                  aria-label="Fork branch"
                  className="flex items-center gap-1 hover:text-neutral-200 transition-colors"
                >
                  <GitBranch className="h-3.5 w-3.5" />
                  <span>Fork</span>
                </button>

                <button
                  type="button"
                  aria-label="Read aloud"
                  className="flex items-center gap-1 hover:text-neutral-200 transition-colors"
                >
                  <Volume2 className="h-3.5 w-3.5" />
                </button>

                <span className="text-neutral-400">
                  {formatRelativeTime(msg.timestamp)}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
