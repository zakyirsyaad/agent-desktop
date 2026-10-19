import { describe, it, expect, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useDraftInstall } from "../hooks/useDraftInstall";
import { resetAgentInstalls } from "../lib/agent-installs";
import { makeProfile } from "./fixtures/agents";

const codex = makeProfile({
  id: "codex-acp",
  name: "Codex",
  transport: "acp",
  detected: false,
  availability: "needs_runtime",
  install_plan: [{ kind: "agent", name: "Codex", version: "0.4.2", download_bytes: null }],
});
const readyCodex = makeProfile({ ...codex, detected: true, availability: "ready", install_plan: null });

describe("useDraftInstall", () => {
  afterEach(() => resetAgentInstalls());

  it("offers the install in a draft whose agent is not installed, and holds only Send", () => {
    const { result } = renderHook(() => useDraftInstall([codex], codex, true));
    expect(result.current).toEqual({ showsPanel: true, needsInstall: true });
  });

  it("offers nothing outside a draft or for a ready agent", () => {
    expect(renderHook(() => useDraftInstall([codex], codex, false)).result.current).toEqual({
      showsPanel: false,
      needsInstall: false,
    });
    expect(renderHook(() => useDraftInstall([readyCodex], readyCodex, true)).result.current).toEqual({
      showsPanel: false,
      needsInstall: false,
    });
    expect(renderHook(() => useDraftInstall([], undefined, true)).result.current).toEqual({
      showsPanel: false,
      needsInstall: false,
    });
  });
});
