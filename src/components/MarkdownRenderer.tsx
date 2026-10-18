import { memo, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke } from "@tauri-apps/api/core";
import { Copy, Check } from "lucide-react";

const COPIED_FEEDBACK_MS = 2000;
const LANGUAGE_CLASS = /language-([\w-]+)/;

/** Fenced code with its language and a Copy button. */
function CodeBlock({ language, code }: { language?: string; code: string }) {
  const [isCopied, setIsCopied] = useState(false);
  const handleCopy = () => {
    if (!navigator?.clipboard?.writeText) return;
    navigator.clipboard.writeText(code);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), COPIED_FEEDBACK_MS);
  };
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-border bg-surface-1">
      <div className="flex items-center justify-between border-b border-border bg-surface-2 px-3 py-1.5 text-[11px] font-mono text-fg-muted">
        <span>{language || "text"}</span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label="Copy code"
          className="flex items-center gap-1 text-fg-muted hover:text-fg-secondary transition-colors"
        >
          {isCopied ? (
            <>
              <Check className="h-3 w-3 text-status-running" />
              <span className="text-status-running">Copied</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="p-3 font-mono text-xs text-fg-secondary overflow-x-auto">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** The text of a node's children, e.g. a code block's source. */
function textOf(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

/** What the app can open for a link: web pages and mail, in the user's apps. */
const OPENABLE_URL = /^(https?:|mailto:)/i;

/**
 * Links open in the user's browser; a click must never navigate the app's
 * webview away. Anything else (a file path an agent mentions, say) is shown
 * as text with its target on hover instead of a link that does nothing.
 */
function ExternalLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href || !OPENABLE_URL.test(href)) {
    return (
      <span title={href} className="text-fg-secondary underline decoration-dotted decoration-fg-subtle underline-offset-2">
        {children}
      </span>
    );
  }
  return (
    <a
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault();
        // The backend only refuses what OPENABLE_URL already excludes.
        invoke("open_external_url", { url: href }).catch(() => {});
      }}
      className="text-fg underline decoration-fg-subtle underline-offset-2 hover:decoration-fg-muted"
    >
      {children}
    </a>
  );
}

/** The app loads no remote images (see the CSP), so an image becomes a link to it. */
function ImageLink({ src, alt }: { src?: string; alt?: string }) {
  const label = `Image: ${alt || src || "untitled"}`;
  return <ExternalLink href={typeof src === "string" ? src : undefined}>{label}</ExternalLink>;
}

const COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="text-lg font-semibold tracking-tight text-fg pt-2">{children}</h1>,
  h2: ({ children }) => <h2 className="text-base font-semibold tracking-tight text-fg pt-1">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold tracking-tight text-fg-secondary">{children}</h3>,
  h4: ({ children }) => <h4 className="text-sm font-semibold text-fg-secondary">{children}</h4>,
  p: ({ children }) => <p className="text-sm leading-relaxed text-fg-secondary break-words">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-fg-secondary">{children}</ul>,
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5 text-sm leading-relaxed text-fg-secondary">{children}</ol>
  ),
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border-strong pl-3 text-fg-muted">{children}</blockquote>
  ),
  a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,
  img: ({ src, alt }) => <ImageLink src={typeof src === "string" ? src : undefined} alt={alt} />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs text-fg-secondary">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b border-border-strong px-2.5 py-1.5 font-semibold text-fg-secondary">{children}</th>,
  td: ({ children }) => <td className="border-b border-border px-2.5 py-1.5 align-top">{children}</td>,
  // Fenced code gets the code block; its <pre> wrapper is replaced, so it is unwrapped here.
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const language = LANGUAGE_CLASS.exec(className ?? "")?.[1];
    const text = textOf(children);
    if (language || text.includes("\n")) return <CodeBlock language={language} code={text.replace(/\n$/, "")} />;
    return (
      <code className="rounded bg-surface-2 border border-border px-1.5 py-0.5 font-mono text-xs text-fg-secondary">
        {children}
      </code>
    );
  },
};

const REMARK_PLUGINS = [remarkGfm];

/**
 * Agent replies as GitHub-flavored Markdown (tables, task lists, links,
 * strikethrough). Raw HTML is not rendered. Memoized on `content`, so a
 * message that did not change is not parsed again while another one streams.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="space-y-3 text-fg-secondary">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    </div>
  );
});
