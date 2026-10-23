import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ChatCanvas } from "../components/ChatCanvas";
import type { ChatMessage, ToolExecution } from "../types";

/** Rows a diff or a text output renders before offering the rest. */
const MAX_RENDERED_ROWS = 400;

const DIFF_LINES = 400;
const OUTPUT_LINES = 60;

interface MessageSpec {
  role: "user" | "agent";
  tools: number;
  diffs: number;
  texts: number;
}

/**
 * The shape of the largest saved transcript on this machine: 15 messages,
 * 330 tools, 110 diffs of ~400 lines, 220 text outputs, and no `parts`.
 */
const LONG_SESSION: MessageSpec[] = [
  { role: "user", tools: 0, diffs: 0, texts: 0 },
  { role: "agent", tools: 3, diffs: 0, texts: 3 },
  { role: "agent", tools: 0, diffs: 0, texts: 0 },
  { role: "user", tools: 0, diffs: 0, texts: 0 },
  { role: "agent", tools: 5, diffs: 1, texts: 4 },
  { role: "user", tools: 0, diffs: 0, texts: 0 },
  { role: "agent", tools: 25, diffs: 20, texts: 5 },
  { role: "user", tools: 0, diffs: 0, texts: 0 },
  { role: "agent", tools: 3, diffs: 0, texts: 3 },
  { role: "agent", tools: 289, diffs: 89, texts: 200 },
  { role: "user", tools: 0, diffs: 0, texts: 0 },
  { role: "user", tools: 0, diffs: 0, texts: 0 },
  { role: "agent", tools: 1, diffs: 0, texts: 1 },
  { role: "agent", tools: 1, diffs: 0, texts: 1 },
  { role: "agent", tools: 3, diffs: 0, texts: 3 },
];

function diffOf(id: number): string {
  return Array.from({ length: DIFF_LINES }, (_, line) => `line ${line} of file ${id}`).join("\n");
}

function outputOf(id: number): string {
  return Array.from({ length: OUTPUT_LINES }, (_, line) => `output ${id} line ${line} ${"x".repeat(30)}`).join(
    "\n",
  );
}

/** Markdown of the length the saved transcript holds: about 39 KB across its agent replies. */
function agentText(index: number, paragraphs: number): string {
  return Array.from(
    { length: paragraphs },
    (_, paragraph) =>
      `### Step ${paragraph + 1}\n\nI checked the parser and changed line ${paragraph + 1}. ${"This keeps the output stable. ".repeat(8)}`,
  ).join("\n\n") + `\n\n\`\`\`ts\nconst value = ${index};\n\`\`\``;
}

function longSession(): ChatMessage[] {
  let toolIndex = 0;
  return LONG_SESSION.map((spec, index) => {
    if (spec.role === "user") {
      return { id: `m-${index}`, role: "user", content: `Message ${index}`, timestamp: index };
    }
    const tools: ToolExecution[] = [];
    for (let diff = 0; diff < spec.diffs; diff += 1) {
      toolIndex += 1;
      tools.push({
        id: `t-${toolIndex}`,
        name: `Edit file ${toolIndex}`,
        status: "completed",
        kind: "edit",
        details: [{ kind: "diff", path: `src/file-${toolIndex}.ts`, oldText: null, newText: diffOf(toolIndex) }],
      });
    }
    for (let text = 0; text < spec.texts; text += 1) {
      toolIndex += 1;
      tools.push({
        id: `t-${toolIndex}`,
        name: `Run command ${toolIndex}`,
        status: "completed",
        kind: "execute",
        details: [{ kind: "text", text: outputOf(toolIndex) }],
      });
    }
    return {
      id: `m-${index}`,
      role: "agent",
      content: tools.length > 0 ? agentText(index, spec.tools > 100 ? 40 : 2) : "",
      timestamp: index,
      tools: tools.length > 0 ? tools : undefined,
      isComplete: true,
    };
  });
}

function diffTool(id: string, path: string, newText = "a\nb"): ToolExecution {
  return {
    id,
    name: `Edit ${path}`,
    status: "completed",
    kind: "edit",
    details: [{ kind: "diff", path, oldText: null, newText }],
  };
}

describe("a long session", () => {
  it(
    "keeps a transcript shaped like the largest saved one under 5,000 elements",
    () => {
      const { container } = render(<ChatCanvas messages={longSession()} />);

      const elements = container.querySelectorAll("*").length;
      expect(
        elements,
        `${elements} elements for 15 messages, 330 tools, 110 diffs and 220 outputs`,
      ).toBeLessThan(5000);
      // The 110 diffs all belong to earlier turns, so none of their rows is laid out.
      expect(container.querySelectorAll("[data-line]")).toHaveLength(0);
    },
    60_000,
  );

  it("opens a diff only in the turn the user is watching", () => {
    render(
      <ChatCanvas
        messages={[
          { id: "u-1", role: "user", content: "first", timestamp: 1 },
          {
            id: "a-1",
            role: "agent",
            content: "",
            timestamp: 2,
            isComplete: true,
            tools: [diffTool("t-1", "src/old.ts")],
          },
          { id: "u-2", role: "user", content: "second", timestamp: 3 },
          {
            id: "a-2",
            role: "agent",
            content: "",
            timestamp: 4,
            isComplete: true,
            tools: [diffTool("t-2", "src/new.ts")],
          },
        ]}
      />,
    );

    expect(screen.getByRole("region", { name: "Changes to src/new.ts" })).toBeDefined();
    expect(screen.queryByRole("region", { name: "Changes to src/old.ts" })).toBeNull();

    const earlier = within(screen.getByTestId("chat-message-a-1"));
    fireEvent.click(earlier.getByRole("button", { name: "Edited a file" }));

    // The part opens, but its tool row stays closed until asked.
    expect(screen.queryByRole("region", { name: "Changes to src/old.ts" })).toBeNull();

    fireEvent.click(earlier.getByRole("button", { name: /Edit src\/old\.ts/ }));

    expect(screen.getByRole("region", { name: "Changes to src/old.ts" })).toBeDefined();
  });

  it("closes an auto-opened diff when its turn is no longer current", () => {
    const first: ChatMessage[] = [
      { id: "u-1", role: "user", content: "go", timestamp: 1 },
      {
        id: "a-1",
        role: "agent",
        content: "",
        timestamp: 2,
        isComplete: true,
        tools: [diffTool("t-1", "src/old.ts")],
      },
    ];
    const { rerender } = render(<ChatCanvas messages={first} />);

    expect(screen.getByRole("region", { name: "Changes to src/old.ts" })).toBeDefined();

    rerender(
      <ChatCanvas
        messages={[...first, { id: "u-2", role: "user", content: "next", timestamp: 3 }]}
      />,
    );

    expect(screen.queryByRole("region", { name: "Changes to src/old.ts" })).toBeNull();
    const earlier = within(screen.getByTestId("chat-message-a-1"));
    expect(earlier.getByRole("button", { name: "Edited a file" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a part the user opened after the turn ends", () => {
    const first: ChatMessage[] = [
      { id: "u-1", role: "user", content: "first", timestamp: 1 },
      {
        id: "a-1",
        role: "agent",
        content: "",
        timestamp: 2,
        isComplete: true,
        tools: [diffTool("t-1", "src/old.ts")],
      },
      { id: "u-2", role: "user", content: "second", timestamp: 3 },
    ];
    const { rerender } = render(<ChatCanvas messages={first} />);

    const earlier = within(screen.getByTestId("chat-message-a-1"));
    const summary = earlier.getByRole("button", { name: "Edited a file" });
    expect(summary.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");

    rerender(
      <ChatCanvas
        messages={[...first, { id: "u-3", role: "user", content: "third", timestamp: 4 }]}
      />,
    );

    expect(earlier.getByRole("button", { name: "Edited a file" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("renders at most 400 rows of a huge diff and offers the rest", () => {
    const lineCount = 1600;
    const newText = Array.from({ length: lineCount }, (_, line) => `line ${line}`).join("\n");
    render(
      <ChatCanvas
        messages={[
          { id: "u-1", role: "user", content: "go", timestamp: 1 },
          {
            id: "a-1",
            role: "agent",
            content: "",
            timestamp: 2,
            isComplete: true,
            tools: [diffTool("t-1", "src/big.ts", newText)],
          },
        ]}
      />,
    );

    const diff = screen.getByRole("region", { name: "Changes to src/big.ts" });
    expect(diff.querySelectorAll("[data-line]")).toHaveLength(MAX_RENDERED_ROWS);

    fireEvent.click(within(diff).getByRole("button", { name: `Show all ${lineCount} lines` }));

    expect(diff.querySelectorAll("[data-line]")).toHaveLength(lineCount);

    fireEvent.click(within(diff).getByRole("button", { name: "Show fewer lines" }));

    expect(diff.querySelectorAll("[data-line]")).toHaveLength(MAX_RENDERED_ROWS);
  });

  it("renders at most 400 lines of a long text output and offers the rest", () => {
    const text = Array.from({ length: 900 }, (_, line) => `output line ${line} ${"x".repeat(20)}`).join("\n");
    render(
      <ChatCanvas
        messages={[
          { id: "u-1", role: "user", content: "go", timestamp: 1 },
          {
            id: "a-1",
            role: "agent",
            content: "",
            timestamp: 2,
            isComplete: true,
            tools: [
              diffTool("t-1", "src/small.ts"),
              {
                id: "t-2",
                name: "Run the long command",
                status: "completed",
                kind: "execute",
                details: [{ kind: "text", text }],
              },
            ],
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Run the long command/ }));

    const output = screen.getByText(/output line 0 /).closest("pre");
    expect(output?.textContent?.split("\n")).toHaveLength(MAX_RENDERED_ROWS);
    expect(screen.queryByText(/output line 450 /)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show all 900 lines" }));

    expect(screen.getByText(/output line 450 /)).toBeDefined();
    expect(screen.getByRole("button", { name: "Show fewer lines" }).getAttribute("aria-expanded")).toBe("true");
  });
});
