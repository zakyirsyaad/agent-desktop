import { useState } from "react";
import { AuthPanel } from "./AuthPanel";
import { TerminalSignInDialog } from "./TerminalSignInDialog";
import type { useAgentSignIn } from "../hooks/useAgentSignIn";
import type { AgentProfile } from "../types";

export interface SignInLayerProps {
  signIn: ReturnType<typeof useAgentSignIn>;
  agents: AgentProfile[];
}

/** The sign-in panel above the chat, and an agent's terminal login over the app while it runs. */
export function SignInLayer({ signIn, agents }: SignInLayerProps) {
  const { auth, cancel, terminal } = signIn;
  const { authRequest } = auth;
  // The method the dialog's Try again runs once more.
  const [methodId, setMethodId] = useState<string | null>(null);

  const signInWith = (id: string) => {
    setMethodId(id);
    auth.signIn(id);
  };

  return (
    <>
      {authRequest && (
        <AuthPanel
          agentName={agents.find((a) => a.id === authRequest.profileId)?.name ?? authRequest.profileId}
          methods={authRequest.methods}
          status={authRequest.status}
          error={authRequest.error}
          onSignIn={signInWith}
          onDismiss={auth.dismiss}
        />
      )}
      {terminal.dialog && (
        <TerminalSignInDialog
          state={terminal.dialog}
          output={terminal.output}
          onClose={cancel}
          onTryAgain={() => {
            if (methodId) auth.signIn(methodId);
          }}
          onInput={terminal.sendInput}
          onResize={terminal.resize}
        />
      )}
    </>
  );
}
