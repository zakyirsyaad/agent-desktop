import { useRef, useState } from "react";
import { Bot, Plus } from "lucide-react";
import type { AgentProfile } from "../../types";
import { useDismiss } from "../../hooks/useDismiss";

export interface NewSessionMenuProps {
  folderName: string;
  /** Installed agents only; the default comes first. */
  agents: readonly AgentProfile[];
  defaultAgentId?: string;
  onPick: (agentId: string) => void;
}

/** The default agent first, then the rest in their usual order. */
function defaultFirst(agents: readonly AgentProfile[], defaultAgentId?: string): AgentProfile[] {
  const fallback = agents.find((agent) => agent.id === defaultAgentId);
  return fallback ? [fallback, ...agents.filter((agent) => agent !== fallback)] : [...agents];
}

/** A workspace's + button: it asks which agent the new session runs. */
export function NewSessionMenu({ folderName, agents, defaultAgentId, onPick }: NewSessionMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useDismiss(containerRef, isOpen, () => setIsOpen(false));

  const choices = defaultFirst(agents, defaultAgentId);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label={`New session in ${folderName}`}
        title={`New session in ${folderName}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className="rounded p-1 text-neutral-500 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-600"
      >
        <Plus size={13} />
      </button>
      {isOpen && (
        <div
          role="menu"
          aria-label={`Agent for the new session in ${folderName}`}
          className="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border border-neutral-800 bg-[#181818] p-1 shadow-2xl"
        >
          <p className="px-2.5 pb-1 pt-1 text-[11px] text-neutral-500">New session with</p>
          {choices.length === 0 && (
            <p className="px-2.5 py-1.5 text-xs text-neutral-500">No agent is installed.</p>
          )}
          {choices.map((agent) => (
            <button
              key={agent.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setIsOpen(false);
                onPick(agent.id);
              }}
              className="flex w-full items-center justify-between gap-2 rounded px-2.5 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-neutral-800/60 hover:text-neutral-100"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Bot size={12} aria-hidden="true" className="shrink-0 text-emerald-400" />
                <span className="truncate">{agent.name}</span>
              </span>
              {agent.id === defaultAgentId && <span className="shrink-0 text-[10px] text-neutral-500">Default</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
