import {
  ChevronLeft,
  ChevronRight,
  Folder,
  ExternalLink,
  MoreHorizontal,
  Terminal
} from "lucide-react";

export interface TopBarProps {
  sessionName?: string;
  workspaceName?: string;
  isTerminalOpen: boolean;
  onToggleTerminal: () => void;
  onOpenFolder?: () => void;
  onOpenSettings?: () => void;
}

export function TopBar({
  sessionName = "New session (fork)",
  workspaceName = "ai-perpetual-trading",
  isTerminalOpen,
  onToggleTerminal,
  onOpenFolder,
  onOpenSettings,
}: TopBarProps) {
  return (
    <header className="flex h-11 w-full items-center justify-between border-b border-neutral-800/80 bg-[#000000] px-3.5 text-xs select-none">
      {/* Left: macOS Traffic Lights + Window Navigation */}
      <div className="flex items-center space-x-3">
        <div className="flex items-center space-x-2" aria-label="Window controls">
          <span className="h-3 w-3 rounded-full bg-[#ff5f56] transition-opacity hover:opacity-80 inline-block shadow-sm" />
          <span className="h-3 w-3 rounded-full bg-[#ffbd2e] transition-opacity hover:opacity-80 inline-block shadow-sm" />
          <span className="h-3 w-3 rounded-full bg-[#27c93f] transition-opacity hover:opacity-80 inline-block shadow-sm" />
        </div>

        <div className="flex items-center space-x-0.5 text-neutral-500 pl-2">
          <button
            type="button"
            className="rounded p-1 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-700"
            aria-label="Back"
          >
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            className="rounded p-1 text-neutral-600 hover:bg-neutral-900 hover:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-neutral-700"
            aria-label="Forward"
            disabled
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>

      {/* Center: Session Breadcrumb & Workspace Badge */}
      <div className="flex items-center space-x-2 text-center overflow-hidden max-w-md">
        <span className="truncate font-medium text-neutral-200">
          {sessionName}
        </span>
        <span className="text-neutral-600">/</span>
        <span className="rounded-md bg-neutral-900/90 border border-neutral-800 px-2 py-0.5 text-[11px] font-mono text-neutral-400 truncate">
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

        <button
          type="button"
          onClick={onOpenFolder}
          className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-700"
          aria-label="Open workspace directory"
        >
          <Folder size={14} />
        </button>

        <button
          type="button"
          className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-700"
          aria-label="Popout window"
        >
          <ExternalLink size={14} />
        </button>

        <button
          type="button"
          onClick={onOpenSettings}
          className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-700"
          aria-label="More options"
        >
          <MoreHorizontal size={15} />
        </button>
      </div>
    </header>
  );
}
