import { useState } from "react";
import { Copy, Check } from "lucide-react";

/**
 * Custom lightweight Markdown renderer to support headings, code blocks with
 * copy button, inline code, ordered lists, and paragraphs with zero external runtime deps.
 */
export function MarkdownRenderer({ content }: { content: string }) {
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
