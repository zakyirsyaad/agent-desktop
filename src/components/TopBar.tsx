import {
  ChevronLeft,
  ChevronRight,
  Folder,
  ExternalLink,
  MoreHorizontal,
  Terminal
} from "lucide-react";

/**
 * Left inset reserved for the native macOS traffic lights.
 *
 * The window uses `titleBarStyle: Overlay` with a hidden title, so the real
 * close/minimise/zoom buttons float over this header. Nothing may be rendered
 * under them, and the inset replaces the fake circles that used to stand in for
 * them. The value is wider than the buttons themselves so a click just past
 * them does not hit an interactive control.
 */
export const TOP_BAR_TRAFFIC_LIGHT_INSET_PX = 78;

export interface TopBarProps {
  sessionName?: string;
  workspaceName?: string;
  isTerminalOpen: boolean;
  onToggleTerminal: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  /** Opens this session in its own window; the button is hidden when absent. */
  onPopout?: () => void;
  onOpenFolder?: () => void;
  onOpenSettings?: () => void;
}

export function TopBar({
  sessionName = "New session (fork)",
  workspaceName = "ai-perpetual-trading",
  isTerminalOpen,
  onToggleTerminal,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
  onPopout,
  onOpenFolder,
  onOpenSettings,
}: TopBarProps) {
  return (
    <header
      data-tauri-drag-region
      style={{ paddingLeft: TOP_BAR_TRAFFIC_LIGHT_INSET_PX }}
      className="flex h-11 w-full items-center justify-between border-b border-neutral-800/80 bg-[#000000] px-3.5 text-xs select-none"
    >
      {/* Left: session navigation. The traffic lights above are the OS's own. */}
      <div data-tauri-drag-region className="flex items-center space-x-0.5 text-neutral-500">
        <button
          type="button"
          onClick={canGoBack ? onBack : undefined}
          disabled={!canGoBack}
          className={`rounded p-1 focus:outline-none focus:ring-1 focus:ring-neutral-700 ${
            canGoBack
              ? "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
              : "text-neutral-600"
          }`}
          aria-label="Back"
        >
          <ChevronLeft size={15} />
        </button>
        <button
          type="button"
          onClick={canGoForward ? onForward : undefined}
          disabled={!canGoForward}
          className={`rounded p-1 focus:outline-none focus:ring-1 focus:ring-neutral-700 ${
            canGoForward
              ? "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
              : "text-neutral-600"
          }`}
          aria-label="Forward"
        >
          <ChevronRight size={15} />
        </button>
      </div>

      {/* Center: Session Breadcrumb & Workspace Badge */}
      <div
        data-tauri-drag-region
        className="flex items-center space-x-2 text-center overflow-hidden max-w-md"
      >
        <span data-tauri-drag-region className="truncate font-medium text-neutral-200">
          {sessionName}
        </span>
        <span data-tauri-drag-region className="text-neutral-600">
          /
        </span>
        <span
          data-tauri-drag-region
          className="rounded-md bg-neutral-900/90 border border-neutral-800 px-2 py-0.5 text-[11px] font-mono text-neutral-400 truncate"
        >
          {workspaceName}
        </span>
      </div>

      {/* Right: Actions (Terminal toggle, popout, folder, overflow) */}
      <div className="flex items-center space-x-1 text-neutral-400">
        <button
          type="button"
          onClick={onToggleTerminal}
          aria-label="Toggle terminal drawer"
          aria-pressed={isTerminalOpen}
          className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-xs font-semibold transition-all focus:outline-none focus:ring-1 focus:ring-neutral-700 ${
            isTerminalOpen
              ? "bg-amber-500/15 border border-amber-500/40 text-amber-300"
              : "bg-neutral-900 border border-neutral-800/80 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
          }`}
        >
          <Terminal size={13} className={isTerminalOpen ? "text-amber-400" : "text-neutral-400"} />
          <span>&gt;_</span>
        </button>

        {onOpenFolder && (
          <button
            type="button"
            onClick={onOpenFolder}
            className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-700"
            aria-label="Open workspace directory"
          >
            <Folder size={14} />
          </button>
        )}

        {onPopout && (
          <button
            type="button"
            onClick={onPopout}
            className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-700"
            aria-label="Popout window"
          >
            <ExternalLink size={14} />
          </button>
        )}

        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-700"
            aria-label="More options"
          >
            <MoreHorizontal size={15} />
          </button>
        )}
      </div>
    </header>
  );
}
