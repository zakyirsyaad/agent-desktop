import { KeyRound, LogIn, X } from "lucide-react";
import { Button } from "./ui/Button";
import type { AuthMethod } from "../lib/acp-auth";

export type AuthStatus = "idle" | "signing-in" | "signed-in" | "failed";

export interface AuthPanelProps {
  agentName: string;
  methods: AuthMethod[];
  status: AuthStatus;
  error?: string;
  onSignIn: (methodId: string) => void;
  onDismiss: () => void;
}

/**
 * Shown when an agent needs a sign-in before it can start. Methods that run
 * in the agent (a browser sign-in) or in a terminal get a button; methods that
 * need a secret are only explained, since the app never asks for API keys.
 */
export function AuthPanel({ agentName, methods, status, error, onSignIn, onDismiss }: AuthPanelProps) {
  const hasButton = methods.some((method) => method.kind !== "explain");
  const title = `Sign in to ${agentName}`;
  return (
    <section
      aria-label={title}
      className="mx-6 mt-3 rounded-lg border border-attention-border bg-attention-surface px-4 py-3 text-xs text-fg-secondary"
    >
      <header className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 font-medium text-status-attention">
          <KeyRound size={13} />
          {title}
        </h2>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss sign-in"
          className="rounded p-0.5 text-fg-muted hover:text-fg"
        >
          <X size={13} />
        </button>
      </header>

      {status === "signed-in" ? (
        <p className="mt-2 text-status-running">Signed in to {agentName}. Send your message again.</p>
      ) : (
        <>
          <p className="mt-1.5 text-fg-muted">{agentName} needs you to sign in before it can start.</p>
          {!hasButton && (
            <p className="mt-2 text-fg-secondary">Sign in with {agentName}&apos;s own command line tool, then try again.</p>
          )}
          <ul className="mt-2 space-y-1.5">
            {methods.map((method) => (
              <li key={method.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="font-medium text-fg-secondary">{method.name}</span>
                  {method.description && <p className="text-fg-subtle">{method.description}</p>}
                </div>
                {method.kind !== "explain" && (
                  <Button
                    variant="primary"
                    disabled={status === "signing-in"}
                    onClick={() => onSignIn(method.id)}
                    icon={<LogIn size={12} />}
                    className="shrink-0"
                  >
                    Sign in with {method.name}
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {status === "signing-in" && <p className="mt-2 text-fg-muted">Finish signing in in the window that opened…</p>}
          {status === "failed" && <p className="mt-2 text-danger">Sign-in failed: {error}</p>}
        </>
      )}
    </section>
  );
}
