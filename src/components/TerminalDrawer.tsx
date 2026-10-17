import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Terminal as TerminalIcon, X, Trash2, Copy, Check } from "lucide-react";
import type { PtyOutputPayload } from "../types";
import { XTERM_OPTIONS } from "../lib/xterm-options";

export const NO_SESSION_MESSAGE = "No running session. Start one to see its terminal.";

export interface TerminalDrawerProps {
  isOpen: boolean;
  sessionId: string;
  sessionName?: string;
  /** True while the session's agent process is running. */
  isLive?: boolean;
  /** Shown instead of a terminal when there is none to show. */
  emptyMessage?: string;
  onClose: () => void;
  onSendInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

export function TerminalDrawer({
  isOpen,
  sessionId,
  sessionName,
  isLive = false,
  emptyMessage = NO_SESSION_MESSAGE,
  onClose,
  onSendInput,
  onResize,
}: TerminalDrawerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [copied, setCopied] = useState(false);
  // Without a running session there is nothing to attach to: xterm would still
  // emit query replies as input, and those must not reach an unknown session.
  const hasTerminal = isLive && sessionId !== "";

  // Parents pass fresh callback identities on every render (App re-renders per PTY chunk).
  // Read them through refs so a re-render never disposes the terminal and its scrollback.
  const onSendInputRef = useRef(onSendInput);
  const onResizeRef = useRef(onResize);
  useLayoutEffect(() => {
    onSendInputRef.current = onSendInput;
    onResizeRef.current = onResize;
  });

  useEffect(() => {
    if (!isOpen || !hasTerminal || !containerRef.current) return;

    const terminal = new Terminal(XTERM_OPTIONS);

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    // Open terminal inside DOM container
    terminal.open(containerRef.current);
    (containerRef.current as HTMLElement & { _xterm?: Terminal })._xterm = terminal;
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Resize handling with ResizeObserver and FitAddon
    const handleResize = () => {
      try {
        fitAddon.fit();
        const { cols, rows } = terminal;
        if (cols && rows) {
          const onResizeLatest = onResizeRef.current;
          if (onResizeLatest) {
            onResizeLatest(cols, rows);
          } else {
            invoke("resize_session", { sessionId, cols, rows }).catch(() => {});
          }
        }
      } catch {
        // Safe catch for detached or hidden DOM elements
      }
    };

    // Dispatch initial resize immediately on drawer open
    handleResize();

    // Handle user keystrokes in terminal emulator
    const onDataDisposable = terminal.onData((data) => {
      const onSendInputLatest = onSendInputRef.current;
      if (onSendInputLatest) {
        onSendInputLatest(data);
      } else {
        invoke("send_input", { sessionId, data }).catch(() => {});
      }
    });

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && containerRef.current) {
      resizeObserver = new ResizeObserver(() => {
        handleResize();
      });
      resizeObserver.observe(containerRef.current);
    }

    // Subscribe to Tauri pty-output event
    let isCancelled = false;
    let unlistenOutput: UnlistenFn | null = null;

    listen<PtyOutputPayload>("pty-output", (event) => {
      if (event.payload?.session_id === sessionId) {
        terminal.write(event.payload.data);
      }
    })
      .then((unlisten) => {
        if (isCancelled) {
          unlisten();
        } else {
          unlistenOutput = unlisten;
        }
      })
      .catch(() => {});

    return () => {
      isCancelled = true;
      if (unlistenOutput) {
        unlistenOutput();
      }
      onDataDisposable.dispose();
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [isOpen, sessionId, hasTerminal]);

  if (!isOpen) return null;

  const handleClear = () => {
    terminalRef.current?.clear();
  };

  const handleCopy = async () => {
    try {
      const term = terminalRef.current;
      if (!term) return;

      term.selectAll();
      const selection = term.getSelection();
      term.clearSelection();

      if (selection) {
        await navigator.clipboard.writeText(selection);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      // Clipboard write failed or denied
    }
  };

  return (
    <div
      data-testid="raw-terminal-drawer"
      className="flex flex-col h-72 border-t border-neutral-800 bg-[#000000] z-20 transition-all select-none"
    >
      {/* Terminal Drawer Header Bar */}
      <div className="flex h-9 items-center justify-between border-b border-neutral-800/80 bg-[#0a0a0a] px-3 text-xs">
        <div className="flex items-center space-x-2">
          <TerminalIcon size={14} className="text-amber-400" />
          <span className="font-mono font-medium text-neutral-200">Terminal</span>
          {sessionName && <span className="truncate font-mono text-neutral-500">{sessionName}</span>}
          {isLive && (
            <span className="flex h-2 w-2 relative" role="status" aria-label="Agent running">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
          )}
        </div>

        {/* Drawer Action Controls */}
        <div className="flex items-center space-x-1">
          <button
            type="button"
            onClick={handleClear}
            disabled={!hasTerminal}
            className="flex items-center gap-1 rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors disabled:opacity-40 disabled:hover:bg-transparent focus:outline-none focus:ring-1 focus:ring-neutral-700"
            aria-label="Clear output"
            title="Clear terminal output"
          >
            <Trash2 size={13} />
            <span className="text-[11px]">Clear</span>
          </button>

          <button
            type="button"
            onClick={handleCopy}
            disabled={!hasTerminal}
            className="flex items-center gap-1 rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors disabled:opacity-40 disabled:hover:bg-transparent focus:outline-none focus:ring-1 focus:ring-neutral-700"
            aria-label="Copy output"
            title="Copy terminal contents"
          >
            {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
            <span className="text-[11px]">{copied ? "Copied" : "Copy"}</span>
          </button>

          <div className="h-3.5 w-px bg-neutral-800 mx-1" />

          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 transition-colors focus:outline-none focus:ring-1 focus:ring-neutral-700"
            aria-label="Close drawer"
            title="Close terminal drawer"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Terminal Viewport Container */}
      {hasTerminal ? (
        <div
          ref={containerRef}
          data-testid="xterm-terminal-container"
          className="flex-1 w-full overflow-hidden p-2 bg-[#000000]"
        />
      ) : (
        <div className="flex flex-1 items-center justify-center gap-2 bg-[#000000] text-xs text-neutral-500">
          <TerminalIcon size={14} className="text-neutral-600" aria-hidden="true" />
          <span>{emptyMessage}</span>
        </div>
      )}
    </div>
  );
}
