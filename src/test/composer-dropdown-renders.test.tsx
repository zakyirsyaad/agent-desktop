import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { ChatMessage } from "../types";
import type { ComposerControls } from "../lib/composer-controls";
import type { FakeTauriStore } from "./setup";

const { partRenders } = vi.hoisted(() => ({ partRenders: vi.fn() }));

// A message's tools are its own part: counting their renders counts the
// message list's work, not the composer's.
vi.mock("../components/chat/ToolsPart", () => ({
  ToolsPart: ({ tools }: { tools: { id: string; name: string }[] }) => {
    partRenders(tools[0]?.id);
    return <div>{tools.map((tool) => tool.name).join(", ")}</div>;
  },
}));

import { ChatCanvas } from "../components/ChatCanvas";
import { ComposerDock } from "../components/ComposerDock";
import App from "../App";

function fakeStore(): FakeTauriStore {
  return (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
}

function conversation(count: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ id: "u-0", role: "user", content: "go", timestamp: 1 }];
  for (let i = 0; i < count; i += 1) {
    messages.push({
      id: `a-${i}`,
      role: "agent",
      content: `reply ${i}`,
      timestamp: i + 2,
      isComplete: true,
      tools: [{ id: `t-${i}`, name: `Tool ${i}`, status: "completed" }],
    });
  }
  return messages;
}

const controls: ComposerControls = {
  permission: {
    options: [
      { value: "default", label: "Default" },
      { value: "yolo", label: "YOLO" },
    ],
    selected: "default",
    onChange: () => {},
  },
  model: {
    options: [
      { value: undefined, label: "Default model" },
      { value: "opus", label: "opus" },
    ],
    selected: undefined,
    onChange: () => {},
  },
  effort: {
    options: [
      { value: "low", label: "low" },
      { value: "high", label: "high" },
    ],
    selected: "low",
    onChange: () => {},
  },
};

function ChatAndComposer() {
  return (
    <div>
      <ChatCanvas messages={conversation(60)} />
      <ComposerDock
        controls={controls}
        onSendMessage={() => {}}
        folder={{
          folders: [{ name: "zorvo", path: "/Users/test/developer/zorvo" }],
          selectedPath: "/Users/test/developer/zorvo",
          onSelect: () => {},
        }}
        agent={{
          options: [{ value: "claude-acp", label: "Claude Code" }],
          selected: "claude-acp",
          onChange: () => {},
        }}
      />
    </div>
  );
}

describe("Composer dropdowns and the conversation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not re-render a message when each dropdown opens or closes", () => {
    render(<ChatAndComposer />);
    // One render per reply's tools part on the first pass.
    expect(partRenders).toHaveBeenCalledTimes(60);
    partRenders.mockClear();

    for (const name of [/^Folder:/, /^Agent:/, /^Permission mode:/, /^Model:/, /^Effort:/]) {
      const button = screen.getByRole("button", { name });
      fireEvent.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("false");
    }

    expect(partRenders).not.toHaveBeenCalled();
  });

  it("keeps the conversation still when the app's permission menu opens", async () => {
    const store = fakeStore();
    store.state.sessions = [
      {
        id: "s-1",
        name: "Parser work",
        profileId: "claude-acp",
        cwd: "/Users/test/developer/zorvo",
        status: "terminated",
        createdAt: 1,
        transport: "acp",
        acpSessionId: "acp-s-1",
      },
    ];
    store.transcripts["s-1"] = conversation(60);

    await act(async () => {
      render(<App />);
    });
    await screen.findByText("reply 59");

    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    await act(async () => {
      fireEvent.change(prompt, { target: { value: "continue" } });
      fireEvent.keyDown(prompt, { key: "Enter" });
    });

    const permission = await screen.findByRole("button", { name: /^Permission mode:/ });
    partRenders.mockClear();

    await act(async () => {
      fireEvent.click(permission);
    });
    expect(permission.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      fireEvent.click(permission);
    });
    expect(permission.getAttribute("aria-expanded")).toBe("false");

    expect(partRenders).not.toHaveBeenCalled();
  });
});