import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { ChatMessage } from "../types";

const { partRenders } = vi.hoisted(() => ({ partRenders: vi.fn() }));

vi.mock("../components/chat/ToolsPart", () => ({
  ToolsPart: ({ tools }: { tools: { id: string; name: string }[] }) => {
    partRenders(tools[0]?.id);
    return <div data-testid="tool-part">{tools.map((tool) => tool.name).join(", ")}</div>;
  },
}));

import { ChatCanvas } from "../components/ChatCanvas";

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

describe("ChatCanvas rendering", () => {
  it("re-renders only the message that changed in a long conversation", () => {
    const messages = conversation(200);
    const { rerender } = render(<ChatCanvas messages={messages} />);
    expect(partRenders).toHaveBeenCalledTimes(200);
    partRenders.mockClear();

    const changed = [...messages];
    changed[changed.length - 1] = { ...changed[changed.length - 1], content: "reply 199, still streaming" };
    rerender(<ChatCanvas messages={changed} />);

    expect(partRenders).toHaveBeenCalledTimes(1);
    expect(partRenders).toHaveBeenCalledWith("t-199");
  });

  it("re-renders only the changed message on a streamed chunk", () => {
    const messages = conversation(200);
    const { rerender } = render(<ChatCanvas messages={messages} isWorking />);
    partRenders.mockClear();

    const changed = [...messages];
    changed[changed.length - 1] = { ...changed[changed.length - 1], content: "reply 199, still streaming" };
    rerender(<ChatCanvas messages={changed} isWorking />);

    expect(partRenders).toHaveBeenCalledTimes(1);
  });
});
