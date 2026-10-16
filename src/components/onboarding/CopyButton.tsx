import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";

const COPY_FEEDBACK_MS = 1500;

type CopyState = "idle" | "copied" | "failed";

const STATE_TEXT: Record<CopyState, string> = {
  idle: "Copy",
  copied: "Copied",
  failed: "Copy failed",
};

export interface CopyButtonProps {
  text: string;
  label: string;
}

export function CopyButton({ text, label }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state === "idle") return undefined;
    const timer = setTimeout(() => setState("idle"), COPY_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label}
      className="flex shrink-0 items-center gap-1 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
    >
      {state === "copied" ? (
        <Check size={12} className="text-emerald-400" aria-hidden="true" />
      ) : (
        <Copy size={12} aria-hidden="true" />
      )}
      <span aria-live="polite">{STATE_TEXT[state]}</span>
    </button>
  );
}
