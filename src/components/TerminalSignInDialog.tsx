import { useEffect, useId, useRef } from "react";
import { X } from "lucide-react";
import { useFocusTrap } from "../hooks/useFocusTrap";
import type { TerminalSignInState } from "../hooks/useTerminalSignIn";
import type { PtyOutputStore } from "../lib/pty-output-store";
import { TerminalView } from "./TerminalView";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";

export interface TerminalSignInDialogProps {
  state: TerminalSignInState;
  output: PtyOutputStore;
  onClose: () => void;
  /** Absent when the method cannot be run again: a failed sign-in then offers Close only. */
  onTryAgain?: () => void;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
}

function statusText({ phase, agentName, error }: TerminalSignInState): string {
  switch (phase) {
    case "starting":
      return `Starting ${agentName}…`;
    case "running":
      return "Finish signing in in the terminal. Zorvo continues when it closes.";
    case "checking":
      return "Checking your sign-in…";
    case "failed":
      return error ?? "";
  }
}

/** An agent's terminal login, shown over the app until it finishes or is cancelled. */
export function TerminalSignInDialog({
  state,
  output,
  onClose,
  onTryAgain,
  onInput,
  onResize,
}: TerminalSignInDialogProps) {
  const titleId = useId();
  const isFailed = state.phase === "failed";
  const dialogRef = useRef<HTMLDivElement>(null);
  // The button that takes focus: Try again after a failure, else Cancel or Close.
  const primaryRef = useRef<HTMLButtonElement>(null);
  const canTryAgain = onTryAgain !== undefined;
  useFocusTrap(dialogRef);

  // While the login runs, its terminal has focus.
  useEffect(() => {
    if (state.phase !== "running") primaryRef.current?.focus();
  }, [state.phase, canTryAgain]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay px-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex h-[28rem] w-full max-w-2xl flex-col gap-3 rounded-xl border border-border bg-surface-1 p-5 text-fg-secondary shadow-dialog"
      >
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-fg">
              Sign in to {state.agentName}
            </h2>
            <p className="truncate text-xs text-fg-subtle">{state.methodName}</p>
          </div>
          <IconButton label="Cancel sign-in" onClick={onClose}>
            <X size={15} aria-hidden="true" />
          </IconButton>
        </header>

        <p role="status" className={`text-xs ${isFailed ? "text-danger" : "text-fg-muted"}`}>
          {statusText(state)}
        </p>

        <div className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
          <TerminalView
            sessionId={state.terminalId}
            output={output}
            isLive={state.phase === "running"}
            onInput={onInput}
            onResize={onResize}
          />
        </div>

        <footer className="flex justify-end gap-2">
          {isFailed ? (
            <>
              <Button ref={canTryAgain ? undefined : primaryRef} onClick={onClose}>
                Close
              </Button>
              {canTryAgain && (
                <Button ref={primaryRef} variant="primary" onClick={onTryAgain}>
                  Try again
                </Button>
              )}
            </>
          ) : (
            <Button ref={primaryRef} onClick={onClose}>
              Cancel
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}
