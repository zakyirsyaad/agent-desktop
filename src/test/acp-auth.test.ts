import { describe, it, expect } from "vitest";
import { parseAuthRequired } from "../lib/acp-auth";

const codexMethods = [
  { id: "api-key", name: "API Key", description: "Use an API key to authenticate", _meta: { "api-key": { provider: "openai" } } },
  { id: "chat-gpt", name: "ChatGPT", description: "Use ChatGPT to authenticate" },
];

describe("parseAuthRequired", () => {
  it("reads the agent's sign-in methods from an auth-required error", () => {
    const methods = parseAuthRequired(`ACP_AUTH_REQUIRED:${JSON.stringify(codexMethods)}`);

    expect(methods).toEqual([
      { id: "api-key", name: "API Key", description: "Use an API key to authenticate", kind: "explain" },
      { id: "chat-gpt", name: "ChatGPT", description: "Use ChatGPT to authenticate", kind: "agent" },
    ]);
  });

  it("explains methods the user must set up in a terminal through _meta", () => {
    const qwen = [{ id: "openai", name: "Use OpenAI API key", _meta: { type: "terminal", args: ["--auth-type=openai"] } }];

    expect(parseAuthRequired(`ACP_AUTH_REQUIRED:${JSON.stringify(qwen)}`)?.[0].kind).toBe("explain");
  });

  it("marks a type terminal method as a terminal sign-in", () => {
    const claude = [
      { id: "claude-ai-login", name: "Claude Subscription", type: "terminal", args: ["--cli", "auth", "login", "--claudeai"] },
    ];

    expect(parseAuthRequired(`ACP_AUTH_REQUIRED:${JSON.stringify(claude)}`)).toEqual([
      { id: "claude-ai-login", name: "Claude Subscription", kind: "terminal" },
    ]);
  });

  it("returns null for any other error, and no methods for a malformed list", () => {
    expect(parseAuthRequired("session/new failed: boom")).toBeNull();
    expect(parseAuthRequired(new Error("x"))).toBeNull();
    expect(parseAuthRequired("ACP_AUTH_REQUIRED:not json")).toEqual([]);
  });
});
