import { KeyRound, LogIn, X } from "lucide-react";
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
 * in the agent (a browser sign-in) get a button; methods that need a secret
 * are only explained, since the app never asks for API keys.
 */
export function AuthPanel({ agentName, methods, status, error, onSignIn, onDismiss }: AuthPanelProps) {
  const title = `Sign in to ${agentName}`;
  return (
    <section
      aria-label={title}
      className="mx-6 mt-3 rounded-lg border border-amber-800/50 bg-amber-950/20 px-4 py-3 text-xs text-neutral-200"
    >
      <header className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 font-medium text-amber-300">
          <KeyRound size={13} />
          {title}
        </h2>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss sign-in"
          className="rounded p-0.5 text-neutral-400 hover:text-neutral-100"
        >
          <X size={13} />
        </button>
      </header>

      {status === "signed-in" ? (
        <p className="mt-2 text-emerald-300">Signed in to {agentName}. Send your message again.</p>
      ) : (
        <>
          <p className="mt-1.5 text-neutral-400">{agentName} needs you to sign in before it can start.</p>
          {methods.length === 0 && (
            <p className="mt-2 text-neutral-300">Sign in with {agentName}&apos;s own command line tool, then try again.</p>
          )}
          <ul className="mt-2 space-y-1.5">
            {methods.map((method) => (
              <li key={method.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="font-medium text-neutral-200">{method.name}</span>
                  {method.description && <p className="text-neutral-500">{method.description}</p>}
                </div>
                {!method.needsSecret && (
                  <button
                    type="button"
                    disabled={status === "signing-in"}
                    onClick={() => onSignIn(method.id)}
                    className="flex shrink-0 items-center gap-1 rounded-md bg-neutral-200 px-2.5 py-1 font-medium text-neutral-900 hover:bg-white disabled:opacity-50"
                  >
                    <LogIn size={12} />
                    Sign in with {method.name}
                  </button>
                )}
              </li>
            ))}
          </ul>
          {status === "signing-in" && <p className="mt-2 text-neutral-400">Finish signing in in the window that opened…</p>}
          {status === "failed" && <p className="mt-2 text-rose-300">Sign-in failed: {error}</p>}
        </>
      )}
    </section>
  );
}
