import { useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import type { Ref } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { PtyOutputStore } from "../lib/pty-output-store";
import { XTERM_OPTIONS } from "../lib/xterm-options";

/** What a parent can ask of a mounted terminal. */
export interface TerminalViewHandle {
  /** Moves keyboard focus into the terminal without rebuilding it. */
  focus: () => void;
}

export interface TerminalViewProps {
  sessionId: string;
  output: PtyOutputStore;
  /** False for an ended session: its last screen is shown, and nothing is sent. */
  isLive: boolean;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  /** Take keyboard focus when the terminal mounts. False keeps focus where it is, e.g. on a composer. Changes later do not rebuild the terminal. */
  autoFocus?: boolean;
  /** Accessible name of the terminal. */
  label?: string;
  ref?: Ref<TerminalViewHandle>;
}

/**
 * An agent's sign-in terminal. It replays the output so far, then follows new
 * output; keystrokes go straight to the agent's login program.
 */
export function TerminalView({
  sessionId,
  output,
  isLive,
  onInput,
  onResize,
  autoFocus = true,
  label = "Agent terminal",
  ref,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  // autoFocus only decides the focus at mount; this is the way to focus a terminal that is already there.
  useImperativeHandle(ref, () => ({ focus: () => terminalRef.current?.focus() }), []);
  // App re-renders on every output chunk; callbacks and autoFocus are read
  // through refs so that a change never tears down the terminal.
  const callbacksRef = useRef({ onInput, onResize, autoFocus });
  useLayoutEffect(() => {
    callbacksRef.current = { onInput, onResize, autoFocus };
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = new Terminal(XTERM_OPTIONS);
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;

    // Keystrokes are taken only once the replay is parsed: old output holds
    // terminal queries (cursor position, colours) that xterm would answer as
    // input, and those answers must not reach the live agent.
    let input: { dispose: () => void } | null = null;
    let isDisposed = false;
    // Replay and subscribe in the same task, so no chunk is missed or repeated.
    // autoFocus is read only when the terminal mounts: a later change does not rebuild it.
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
    if (isLive && callbacksRef.current.autoFocus) terminal.focus();

    return () => {
      isDisposed = true;
      unsubscribe();
      input?.dispose();
      observer?.disconnect();
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [sessionId, output, isLive]);

  return (
    <div
      ref={containerRef}
      data-testid="terminal-view"
      aria-label={label}
      className="flex-1 min-h-0 overflow-hidden bg-terminal-bg px-3 py-2"
    />
  );
}
