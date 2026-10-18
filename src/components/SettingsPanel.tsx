import { useEffect, useId, useRef, useState } from "react";
import { Folder, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { RECHECK_ERROR, readyAgents, type AgentSummary } from "../lib/agent-readiness";
import type { Appearance } from "../lib/appearance";
import { Button } from "./ui/Button";
import type { FolderOption } from "./onboarding/types";

export interface SettingsPanelProps {
  appearance: Appearance;
  onChangeAppearance: (appearance: Appearance) => void;
  agents: readonly AgentSummary[];
  defaultAgentId: string | null;
  recentFolders: readonly FolderOption[];
  onChangeDefaultAgent: (agentId: string) => void;
  onRemoveRecentFolder: (path: string) => void;
  onRunOnboarding: () => void;
  /** Detects the agents again, after one was installed while the app runs. */
  onRecheckAgents?: () => Promise<void>;
  onClose: () => void;
}

const SECTION_HEADING =
  "mb-2 text-[10px] font-semibold uppercase tracking-wider text-fg-subtle";

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
    return <p className="text-xs text-fg-subtle">No recent folders yet.</p>;
  }
  return (
    <ul aria-label="Recent folders" className="flex flex-col gap-1">
      {folders.map((folder) => (
        <li
          key={folder.path}
          className="flex items-center gap-2.5 rounded-lg border border-border bg-surface-2 px-3 py-2"
        >
          <Folder size={14} className="shrink-0 text-fg-subtle" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium text-fg">{folder.name}</span>
            <span className="block truncate font-mono text-[11px] text-fg-subtle">{folder.path}</span>
          </span>
          <button
            type="button"
            onClick={() => onRemove(folder.path)}
            aria-label={`Remove ${folder.name} from recent folders`}
            className="rounded p-1 text-fg-muted transition-colors hover:bg-surface-hover hover:text-danger focus-ring"
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function SettingsPanel({
  appearance,
  onChangeAppearance,
  agents,
  defaultAgentId,
  recentFolders,
  onChangeDefaultAgent,
  onRemoveRecentFolder,
  onRunOnboarding,
  onRecheckAgents,
  onClose,
}: SettingsPanelProps) {
  const [isChecking, setIsChecking] = useState(false);
  // Shown here: the app's own notice sits behind this dialog.
  const [checkError, setCheckError] = useState<string | null>(null);
  const titleId = useId();
  const selectId = useId();
  const appearanceId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const ready = readyAgents(agents);
  useEscapeKey(onClose);

  // Move keyboard focus into the modal when it opens.
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex w-full max-w-md flex-col gap-5 rounded-xl border border-border bg-surface-1 p-5 text-fg-secondary shadow-dialog"
      >
        <header className="flex items-center justify-between">
          <h2 id={titleId} className="text-base font-semibold text-fg">
            Settings
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="rounded p-1 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg-secondary focus-ring"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </header>

        <section>
          <label htmlFor={appearanceId} className={`block ${SECTION_HEADING}`}>
            Appearance
          </label>
          <select
            id={appearanceId}
            value={appearance}
            onChange={(event) => onChangeAppearance(event.target.value as Appearance)}
            className="w-full rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-xs text-fg-secondary focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus-ring"
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </section>

        <section>
          <label htmlFor={selectId} className={`block ${SECTION_HEADING}`}>
            Default agent
          </label>
          {ready.length === 0 ? (
            <p className="text-xs text-fg-subtle">No agents are installed yet.</p>
          ) : (
            <select
              id={selectId}
              value={defaultAgentId ?? ""}
              onChange={(event) => onChangeDefaultAgent(event.target.value)}
              className="w-full rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-xs text-fg-secondary focus-ring"
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
          {onRecheckAgents && (
            <Button
              aria-label="Check again for installed agents"
              disabled={isChecking}
              onClick={() => {
                setIsChecking(true);
                setCheckError(null);
                onRecheckAgents()
                  .catch(() => setCheckError(RECHECK_ERROR))
                  .finally(() => setIsChecking(false));
              }}
              icon={<RefreshCw size={12} className={isChecking ? "animate-spin" : undefined} aria-hidden="true" />}
              className="mt-2"
            >
              Check again
            </Button>
          )}
          {checkError && (
            <p role="alert" className="mt-1.5 text-[11px] text-danger">
              {checkError}
            </p>
          )}
        </section>

        <section>
          <h3 className={SECTION_HEADING}>Recent folders</h3>
          <RecentFolderList folders={recentFolders} onRemove={onRemoveRecentFolder} />
        </section>

        <footer className="flex justify-end border-t border-border pt-4">
          <Button onClick={onRunOnboarding} icon={<RotateCcw size={13} aria-hidden="true" />}>
            Run setup again
          </Button>
        </footer>
      </div>
    </div>
  );
}
