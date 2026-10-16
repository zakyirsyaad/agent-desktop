import { useEffect, useId } from "react";
import { Folder, RotateCcw, Trash2, X } from "lucide-react";
import { readyAgents, type AgentSummary } from "../lib/agent-readiness";
import type { FolderOption } from "./onboarding/types";

export interface SettingsPanelProps {
  agents: readonly AgentSummary[];
  defaultAgentId: string | null;
  recentFolders: readonly FolderOption[];
  onChangeDefaultAgent: (agentId: string) => void;
  onRemoveRecentFolder: (path: string) => void;
  onRunOnboarding: () => void;
  onClose: () => void;
}

const SECTION_HEADING =
  "mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500";

/** Calls `onEscape` for Escape presses anywhere in the document while mounted. */
function useEscapeKey(onEscape: () => void) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onEscape();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onEscape]);
}

interface RecentFolderListProps {
  folders: readonly FolderOption[];
  onRemove: (path: string) => void;
}

function RecentFolderList({ folders, onRemove }: RecentFolderListProps) {
  if (folders.length === 0) {
    return <p className="text-xs text-neutral-500">No recent folders yet.</p>;
  }
  return (
    <ul aria-label="Recent folders" className="flex flex-col gap-1">
      {folders.map((folder) => (
        <li
          key={folder.path}
          className="flex items-center gap-2.5 rounded-lg border border-[#262626] bg-[#121212] px-3 py-2"
        >
          <Folder size={14} className="shrink-0 text-neutral-500" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-neutral-100">{folder.name}</span>
            <span className="block truncate font-mono text-[11px] text-neutral-500">{folder.path}</span>
          </span>
          <button
            type="button"
            onClick={() => onRemove(folder.path)}
            aria-label={`Remove ${folder.name} from recent folders`}
            className="rounded p-1 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-red-400 focus:outline-none focus:ring-1 focus:ring-neutral-700"
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function SettingsPanel({
  agents,
  defaultAgentId,
  recentFolders,
  onChangeDefaultAgent,
  onRemoveRecentFolder,
  onRunOnboarding,
  onClose,
}: SettingsPanelProps) {
  const titleId = useId();
  const selectId = useId();
  const ready = readyAgents(agents);
  useEscapeKey(onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex w-full max-w-md flex-col gap-5 rounded-xl border border-[#262626] bg-[#0d0d0d] p-5 text-neutral-200 shadow-2xl"
      >
        <header className="flex items-center justify-between">
          <h2 id={titleId} className="text-base font-semibold text-neutral-100">
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="rounded p-1 text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-700"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        <section>
          <label htmlFor={selectId} className={`block ${SECTION_HEADING}`}>
            Default agent
          </label>
          {ready.length === 0 ? (
            <p className="text-xs text-neutral-500">No agents are installed yet.</p>
          ) : (
            <select
              id={selectId}
              value={defaultAgentId ?? ""}
              onChange={(event) => onChangeDefaultAgent(event.target.value)}
              className="w-full rounded-lg border border-[#262626] bg-[#121212] px-3 py-2 text-xs text-neutral-200 focus:border-neutral-700 focus:outline-none focus:ring-1 focus:ring-amber-500/20"
            >
              {defaultAgentId === null && (
                <option value="" disabled>
                  Choose an agent
                </option>
              )}
              {ready.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          )}
        </section>

        <section>
          <h3 className={SECTION_HEADING}>Recent folders</h3>
          <RecentFolderList folders={recentFolders} onRemove={onRemoveRecentFolder} />
        </section>

        <footer className="flex justify-end border-t border-neutral-800/60 pt-4">
          <button
            type="button"
            onClick={onRunOnboarding}
            className="flex items-center gap-1.5 rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
          >
            <RotateCcw size={13} aria-hidden="true" />
            Run setup again
          </button>
        </footer>
      </div>
    </div>
  );
}
