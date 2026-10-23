import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { Plus, X } from "lucide-react";
import { TerminalView } from "../TerminalView";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { tabLabel } from "../../lib/terminal-labels";
import type { WorkspaceTerminals, WorkspaceTerminalTab } from "../../hooks/useWorkspaceTerminals";

const START_HEIGHT = 280;
const MIN_HEIGHT = 120;
const MAX_HEIGHT_RATIO = 0.7;
const KEY_STEP = 24;

export interface TerminalDrawerProps {
  folderPath: string;
  folderName: string;
  /** The folder's current branch, read at render. */
  branch?: string;
  terminals: WorkspaceTerminals;
  onHide: () => void;
}

function maxHeight(): number {
  return Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * MAX_HEIGHT_RATIO));
}

function clampHeight(height: number): number {
  return Math.min(maxHeight(), Math.max(MIN_HEIGHT, height));
}

/**
 * The shells of one folder, in a drawer under the chat. The caller keys nothing
 * on the folder: switching sessions only changes `folderPath`.
 */
export function TerminalDrawer({ folderPath, folderName, branch, terminals, onHide }: TerminalDrawerProps) {
  const tabs = terminals.tabsFor(folderPath);
  const [height, setHeight] = useState(START_HEIGHT);
  const [activeByFolder, setActiveByFolder] = useState<Record<string, string>>({});
  const activeTab = pickActive(tabs, activeByFolder[folderPath]);
  // The tab whose view takes keyboard focus when it mounts: set by an action in
  // the drawer (opening it, New terminal, picking a tab, Start a new shell),
  // never by a session switch. The view reads it only on mount.
  const [focusTabId, setFocusTabId] = useState<string | null>(() => pickActive(tabs, undefined)?.id ?? null);
  const folderRef = useRef(folderPath);
  useEffect(() => {
    folderRef.current = folderPath;
  }, [folderPath]);
  useEffect(() => {
    if (focusTabId && activeTab?.id === focusTabId) setFocusTabId(null);
  }, [focusTabId, activeTab?.id]);

  const labelOf = (tab: WorkspaceTerminalTab) => tabLabel(folderName, branch, tab.number);

  const select = (id: string) => {
    setActiveByFolder((current) => ({ ...current, [folderPath]: id }));
    setFocusTabId(id);
  };

  const openShell = async () => {
    const forFolder = folderPath;
    const id = await terminals.open(forFolder);
    if (!id) return;
    setActiveByFolder((current) => ({ ...current, [forFolder]: id }));
    // Opened for a folder you have left since: it shows without taking focus.
    if (folderRef.current === forFolder) setFocusTabId(id);
  };

  return (
    <section
      aria-label="Terminal"
      style={{ height, maxHeight: `${MAX_HEIGHT_RATIO * 100}vh` }}
      className="flex shrink-0 flex-col border-t border-border bg-terminal-bg"
    >
      <ResizeHandle height={height} onChange={(next) => setHeight(clampHeight(next))} />
      <div className="flex items-center gap-1 border-b border-border px-2">
        <div role="tablist" aria-label="Terminals" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => (
            <TabItem
              key={tab.id}
              label={labelOf(tab)}
              selected={tab.id === activeTab?.id}
              onSelect={() => select(tab.id)}
              onClose={() => terminals.close(tab.id)}
            />
          ))}
        </div>
        {activeTab && (
          <IconButton label="New terminal" onClick={openShell}>
            <Plus size={14} aria-hidden />
          </IconButton>
        )}
        <IconButton label="Hide terminal" onClick={onHide}>
          <X size={14} aria-hidden />
        </IconButton>
      </div>
      <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
        {activeTab ? (
          <>
            <div className="min-h-0 flex-1">
              <TerminalView
                key={activeTab.id}
                sessionId={activeTab.id}
                output={terminals.output}
                isLive={activeTab.status === "live"}
                onInput={(data) => terminals.send(activeTab.id, data)}
                onResize={(cols, rows) => terminals.resize(activeTab.id, cols, rows)}
                autoFocus={activeTab.id === focusTabId}
                label={labelOf(activeTab)}
              />
            </div>
            {activeTab.status === "exited" && (
              <div className="flex items-center gap-3 border-t border-border px-3 py-2 text-xs text-fg-muted">
                <span>The shell exited.</span>
                <Button onClick={openShell}>Start a new shell</Button>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-xs text-fg-muted">
            <p>No terminal in {folderName}.</p>
            <Button onClick={openShell}>New terminal</Button>
          </div>
        )}
      </div>
    </section>
  );
}

/** The tab you picked for the folder, else its newest one. */
function pickActive(tabs: WorkspaceTerminalTab[], pickedId: string | undefined): WorkspaceTerminalTab | undefined {
  return tabs.find((tab) => tab.id === pickedId) ?? tabs.at(-1);
}

interface TabItemProps {
  label: string;
  selected: boolean;
  onSelect: () => void;
  onClose: () => void;
}

function TabItem({ label, selected, onSelect, onClose }: TabItemProps) {
  return (
    <div className={`flex shrink-0 items-center rounded-md ${selected ? "bg-surface-hover" : ""}`}>
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        onClick={onSelect}
        className={`focus-ring rounded-md px-2 py-1 text-xs ${selected ? "text-fg" : "text-fg-muted hover:text-fg"}`}
      >
        {label}
      </button>
      <IconButton label={`Close ${label}`} onClick={onClose} className="h-6 w-6">
        <X size={12} aria-hidden />
      </IconButton>
    </div>
  );
}

interface ResizeHandleProps {
  height: number;
  onChange: (height: number) => void;
}

function ResizeHandle({ height, onChange }: ResizeHandleProps) {
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowUp") onChange(height + KEY_STEP);
    else if (event.key === "ArrowDown") onChange(height - KEY_STEP);
    else return;
    event.preventDefault();
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startY: event.clientY, startHeight: height };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag) onChange(drag.startHeight + (drag.startY - event.clientY));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize terminal"
      aria-valuemin={MIN_HEIGHT}
      aria-valuemax={maxHeight()}
      aria-valuenow={height}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="focus-ring h-1.5 shrink-0 cursor-row-resize touch-none bg-border opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100"
    />
  );
}
