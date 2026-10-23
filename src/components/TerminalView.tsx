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
  // The keystroke listener, kept apart from the mount effect so that a session
  // ending or starting can drop or add it without rebuilding the terminal.
  const inputRef = useRef<{ dispose: () => void } | null>(null);
  // Puts a terminal that is already mounted to use once its session is live.
  const goLiveRef = useRef<() => void>(() => {});
  // App re-renders on every output chunk; callbacks, autoFocus and isLive are
  // read through refs so that a change never tears down the terminal.
  const callbacksRef = useRef({ onInput, onResize, autoFocus, isLive });
  useLayoutEffect(() => {
    callbacksRef.current = { onInput, onResize, autoFocus, isLive };
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
    let isDisposed = false;
    let isReplayed = false;
    const attachInput = () => {
      if (isReplayed && !isDisposed && !inputRef.current) {
        inputRef.current = terminal.onData((data) => callbacksRef.current.onInput(data));
      }
    };
    // Replay and subscribe in the same task, so no chunk is missed or repeated.
    // autoFocus and isLive are read when they are needed, not as dependencies:
    // a session that ends keeps its terminal, with its scroll position and selection.
    terminal.write(output.snapshot(sessionId), () => {
      isReplayed = true;
      if (callbacksRef.current.isLive) attachInput();
    });
    const unsubscribe = output.subscribe(sessionId, (data) => terminal.write(data));

    const fit = () => {
      try {
        fitAddon.fit();
      } catch {
        return; // Hidden or detached container: nothing to measure.
      }
      if (callbacksRef.current.isLive && terminal.cols && terminal.rows) callbacksRef.current.onResize(terminal.cols, terminal.rows);
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    observer?.observe(container);
    const focusIfWanted = () => {
      if (callbacksRef.current.autoFocus) terminal.focus();
    };
    if (callbacksRef.current.isLive) focusIfWanted();
    goLiveRef.current = () => {
      attachInput();
      fit();
      focusIfWanted();
    };

    return () => {
      isDisposed = true;
      goLiveRef.current = () => {};
      unsubscribe();
      inputRef.current?.dispose();
      inputRef.current = null;
      observer?.disconnect();
      terminalRef.current = null;
      terminal.dispose();
    };
  }, [sessionId, output]);

  // A session's liveness changes without rebuilding the terminal: a shell that
  // exits keeps its last screen, and a sign-in that starts becomes typeable.
  const wasLiveRef = useRef(isLive);
  useEffect(() => {
    if (wasLiveRef.current === isLive) return;
    wasLiveRef.current = isLive;
    if (isLive) {
      goLiveRef.current();
      return;
    }
    inputRef.current?.dispose();
    inputRef.current = null;
  }, [isLive]);

  return (
    <div
      ref={containerRef}
      data-testid="terminal-view"
      aria-label={label}
      className="flex-1 min-h-0 overflow-hidden bg-terminal-bg px-3 py-2"
    />
  );
}
