import { useEffect, useLayoutEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { PtyOutputStore } from "../lib/pty-output-store";
import { XTERM_OPTIONS } from "../lib/xterm-options";

export interface TerminalViewProps {
  sessionId: string;
  output: PtyOutputStore;
  /** False for an ended session: its last screen is shown, and nothing is sent. */
  isLive: boolean;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

/**
 * An agent's sign-in terminal. It replays the output so far, then follows new
 * output; keystrokes go straight to the agent's login program.
 */
export function TerminalView({ sessionId, output, isLive, onInput, onResize }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // App re-renders on every output chunk; callbacks are read through refs so
  // that never tears down the terminal.
  const callbacksRef = useRef({ onInput, onResize });
  useLayoutEffect(() => {
    callbacksRef.current = { onInput, onResize };
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal(XTERM_OPTIONS);
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    // Keystrokes are taken only once the replay is parsed: old output holds
    // terminal queries (cursor position, colours) that xterm would answer as
    // input, and those answers must not reach the live agent.
    let input: { dispose: () => void } | null = null;
    let isDisposed = false;
    // Replay and subscribe in the same task, so no chunk is missed or repeated.
    terminal.write(output.snapshot(sessionId), () => {
      if (isLive && !isDisposed) input = terminal.onData((data) => callbacksRef.current.onInput(data));
    });
    const unsubscribe = output.subscribe(sessionId, (data) => terminal.write(data));

    const fit = () => {
      try {
        fitAddon.fit();
      } catch {
        return; // Hidden or detached container: nothing to measure.
      }
      if (isLive && terminal.cols && terminal.rows) callbacksRef.current.onResize(terminal.cols, terminal.rows);
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(container);
    if (isLive) terminal.focus();

    return () => {
      isDisposed = true;
      unsubscribe();
      input?.dispose();
      observer?.disconnect();
      terminal.dispose();
    };
  }, [sessionId, output, isLive]);

  return (
    <div
      ref={containerRef}
      data-testid="terminal-view"
      aria-label="Agent terminal"
      className="flex-1 min-h-0 overflow-hidden bg-terminal-bg px-3 py-2"
    />
  );
}
