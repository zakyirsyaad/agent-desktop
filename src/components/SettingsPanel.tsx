import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Folder, RotateCcw, Trash2, X } from "lucide-react";
import { readyAgents, type AgentSummary } from "../lib/agent-readiness";
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
  onClose: () => void;
  /** The tab shown when the panel opens; General unless asked. */
  initialTab?: SettingsTab;
  /** The Agents tab's content: the agent catalog. */
  agentsPanel: ReactNode;
  /** Agents in use with an update, counted on the Agents tab. */
  updateCount: number;
}

export type SettingsTab = "general" | "agents";

const TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
];

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

interface SettingsTabsProps {
  selected: SettingsTab;
  onSelect: (tab: SettingsTab) => void;
  idOf: (tab: SettingsTab, part: "tab" | "panel") => string;
  updateCount: number;
}

/** The tab strip: a click picks a tab, Left and Right move between them (and wrap). */
function SettingsTabs({ selected, onSelect, idOf, updateCount }: SettingsTabsProps) {
  const tabRefs = useRef(new Map<SettingsTab, HTMLButtonElement>());

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = TABS.findIndex((tab) => tab.id === selected);
    const next = TABS[(index + step + TABS.length) % TABS.length].id;
    onSelect(next);
    tabRefs.current.get(next)?.focus();
  };

  return (
    <div role="tablist" aria-label="Settings sections" onKeyDown={handleKeyDown} className="flex gap-1 border-b border-border">
      {TABS.map((tab) => {
        const isSelected = tab.id === selected;
        const count = tab.id === "agents" ? updateCount : 0;
        return (
          <button
            key={tab.id}
            ref={(element) => {
              if (element) tabRefs.current.set(tab.id, element);
              else tabRefs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            id={idOf(tab.id, "tab")}
            aria-selected={isSelected}
            // Only the selected tab's panel is rendered, so only it is named here.
            aria-controls={isSelected ? idOf(tab.id, "panel") : undefined}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            className={`-mb-px flex items-center gap-1.5 rounded-t-md border-b-2 px-3 py-2 text-xs font-medium transition-colors focus-ring ${
              isSelected ? "border-primary text-fg" : "border-transparent text-fg-muted hover:text-fg-secondary"
            }`}
          >
            {tab.label}
            {count > 0 && (
              <>
                <span aria-hidden="true" className="rounded-full bg-primary px-1.5 text-[10px] leading-4 text-on-primary">
                  {count}
                </span>
                <span className="sr-only">{`, ${count} ${count === 1 ? "update" : "updates"}`}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

interface GeneralTabProps {
  appearance: Appearance;
  onChangeAppearance: (appearance: Appearance) => void;
  agents: readonly AgentSummary[];
  defaultAgentId: string | null;
  recentFolders: readonly FolderOption[];
  onChangeDefaultAgent: (agentId: string) => void;
  onRemoveRecentFolder: (path: string) => void;
  onRunOnboarding: () => void;
}

function GeneralTab({
  appearance,
  onChangeAppearance,
  agents,
  defaultAgentId,
  recentFolders,
  onChangeDefaultAgent,
  onRemoveRecentFolder,
  onRunOnboarding,
}: GeneralTabProps) {
  const selectId = useId();
  const appearanceId = useId();
  const ready = readyAgents(agents);
  return (
    <div className="flex flex-col gap-5">
      <section>
        <label htmlFor={appearanceId} className={`block ${SECTION_HEADING}`}>
          Appearance
        </label>
        <select
          id={appearanceId}
          value={appearance}
          onChange={(event) => onChangeAppearance(event.target.value as Appearance)}
          className="w-full rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-xs text-fg-secondary focus-ring"
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
  );
}

export function SettingsPanel({
  onClose,
  initialTab = "general",
  agentsPanel,
  updateCount,
  ...general
}: SettingsPanelProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const titleId = useId();
  const tabsId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const idOf = (id: SettingsTab, part: "tab" | "panel") => `${tabsId}-${id}-${part}`;
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
        className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-4 rounded-xl border border-border bg-surface-1 p-5 text-fg-secondary shadow-dialog"
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

        <SettingsTabs selected={tab} onSelect={setTab} idOf={idOf} updateCount={updateCount} />

        <div
          role="tabpanel"
          id={idOf(tab, "panel")}
          aria-labelledby={idOf(tab, "tab")}
          className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1"
        >
          {tab === "general" ? <GeneralTab {...general} /> : agentsPanel}
        </div>
      </div>
    </div>
  );
}
