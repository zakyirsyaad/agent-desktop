import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AuthPanel, type AuthPanelProps } from "../components/AuthPanel";
import type { AuthMethod } from "../lib/acp-auth";

const terminal: AuthMethod = { id: "claude-ai-login", name: "Claude Subscription", kind: "terminal" };
const agent: AuthMethod = { id: "chat-gpt", name: "ChatGPT", kind: "agent" };
const explain: AuthMethod = { id: "api-key", name: "API Key", description: "Use an API key to authenticate", kind: "explain" };

function renderPanel(props: Partial<AuthPanelProps> = {}) {
  const onSignIn = vi.fn();
  render(
    <AuthPanel agentName="Claude Code" methods={[terminal]} status="idle" onSignIn={onSignIn} onDismiss={vi.fn()} {...props} />,
  );
  return { onSignIn };
}

describe("AuthPanel", () => {
  it("offers a button for a terminal method that signs in with its id", () => {
    const { onSignIn } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Sign in with Claude Subscription" }));

    expect(onSignIn).toHaveBeenCalledWith("claude-ai-login");
  });

  it("only explains a method that needs an API key", () => {
    renderPanel({ methods: [explain] });

    expect(screen.queryByRole("button", { name: /Sign in with API Key/ })).toBeNull();
    expect(screen.getByText("Use an API key to authenticate")).toBeTruthy();
  });

  it("points to the command line tool when no method has a button", () => {
    renderPanel({ methods: [explain] });

    expect(screen.getByText("Sign in with Claude Code's own command line tool, then try again.")).toBeTruthy();
  });

  it("hides the command line hint when a method has a button", () => {
    renderPanel({ methods: [explain, terminal] });

    expect(screen.queryByText(/own command line tool/)).toBeNull();
  });

  it("disables every sign-in button while signing in", () => {
    renderPanel({ methods: [agent, terminal], status: "signing-in" });

    const buttons = screen.getAllByRole("button", { name: /^Sign in with/ });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
