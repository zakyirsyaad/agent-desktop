import { describe, it, expect, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDraftInstall } from "../hooks/useDraftInstall";
import { resetAgentInstalls } from "../lib/agent-installs";
import { makeProfile } from "./fixtures/agents";

const codex = makeProfile({
  id: "codex-acp",
  name: "Codex",
  detected: false,
  availability: "needs_runtime",
  install_plan: [{ kind: "agent", name: "Codex", version: "0.4.2", download_bytes: null }],
});
const qwen = makeProfile({ id: "qwen-code", name: "Qwen Code", detected: true, availability: "ready" });

describe("useDraftInstall", () => {
  afterEach(() => resetAgentInstalls());

  it("holds only Send while the draft's own agent is offered for install", () => {
    expect(renderHook(() => useDraftInstall([codex], codex, codex)).result.current).toBe(true);
  });

  it("holds nothing without an install panel, or when the message goes to another agent", () => {
    expect(renderHook(() => useDraftInstall([qwen], undefined, qwen)).result.current).toBe(false);
    // An ended chat offers its own agent's install while a new message would go to the draft's agent.
    expect(renderHook(() => useDraftInstall([codex, qwen], codex, qwen)).result.current).toBe(false);
    expect(renderHook(() => useDraftInstall([], undefined, undefined)).result.current).toBe(false);
  });
});
