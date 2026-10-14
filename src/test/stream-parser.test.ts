import { describe, it, expect, beforeEach } from "vitest";
import { StreamParser } from "../lib/stream-parser";

describe("StreamParser", () => {
  let parser: StreamParser;

  beforeEach(() => {
    parser = new StreamParser();
  });

  describe("ANSI escape code stripping", () => {
    it("strips SGR color and formatting escape codes to yield clean text", () => {
      const input = "\u001b[31mRed text\u001b[0m and \u001b[1;32mBold Green\u001b[0m";
      const events = parser.feed(input);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "text",
        content: "Red text and Bold Green",
      });
    });

    it("strips cursor movement and clear line escape codes", () => {
      const input = "Loading...\u001b[2K\u001b[1GDone!";
      const events = parser.feed(input);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "text",
        content: "Loading...Done!",
      });
    });

    it("strips OSC (Operating System Command) sequences like terminal title changes", () => {
      const input = "\u001b]0;Claude Code Terminal\u0007Hello from CLI";
      const events = parser.feed(input);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "text",
        content: "Hello from CLI",
      });
    });
  });

  describe("Fragmented / Partial chunk handling", () => {
    it("buffers incomplete ANSI sequences across chunks and strips cleanly when completed", () => {
      // Chunk 1 ends in a split escape sequence: \u001b[3
      const chunk1 = "Hello \u001b[3";
      // Chunk 2 finishes: 1mWorld\u001b[0m!
      const chunk2 = "1mWorld\u001b[0m!";

      const events1 = parser.feed(chunk1);
      const events2 = parser.feed(chunk2);

      // In chunk 1, "Hello " should be emitted, and the partial escape buffered
      expect(events1).toEqual([
        {
          type: "text",
          content: "Hello ",
        },
      ]);

      // In chunk 2, the buffer resolves and "World!" is emitted
      expect(events2).toEqual([
        {
          type: "text",
          content: "World!",
        },
      ]);
    });

    it("buffers across multiple split chunks", () => {
      const e1 = parser.feed("Status: \u001b");
      const e2 = parser.feed("[");
      const e3 = parser.feed("3");
      const e4 = parser.feed("2mOK\u001b[0m");

      expect(e1).toEqual([{ type: "text", content: "Status: " }]);
      expect(e2).toEqual([]);
      expect(e3).toEqual([]);
      expect(e4).toEqual([{ type: "text", content: "OK" }]);
    });

    it("buffers standalone ESC at end of chunk", () => {
      const chunk1 = "Starting \u001b";
      const chunk2 = "[32mProcess\u001b[0m";

      const events1 = parser.feed(chunk1);
      const events2 = parser.feed(chunk2);

      expect(events1).toEqual([
        {
          type: "text",
          content: "Starting ",
        },
      ]);
      expect(events2).toEqual([
        {
          type: "text",
          content: "Process",
        },
      ]);
    });
  });

  describe("Approval request detection", () => {
    it("detects 'Allow this action? [y/n]' and emits approval_request event", () => {
      const input = "Bash command pending.\nAllow this action? [y/n] ";
      const events = parser.feed(input);

      const approvalEvent = events.find((e) => e.type === "approval_request");
      expect(approvalEvent).toBeDefined();
      expect(approvalEvent?.content).toContain("Allow this action?");
    });

    it("detects 'Run command?' prompt pattern", () => {
      const input = "File edit proposed.\nRun command? (y/n): ";
      const events = parser.feed(input);

      const approvalEvent = events.find((e) => e.type === "approval_request");
      expect(approvalEvent).toBeDefined();
      expect(approvalEvent?.type).toBe("approval_request");
    });

    it("supports custom approval pattern in constructor or configuration", () => {
      const customParser = new StreamParser({
        approvalPattern: "Do you authorize this\\?",
      });
      const input = "Do you authorize this? [yes/no]";
      const events = customParser.feed(input);

      const approvalEvent = events.find((e) => e.type === "approval_request");
      expect(approvalEvent).toBeDefined();
      expect(approvalEvent?.type).toBe("approval_request");
    });

    it("extracts clean content without ANSI codes for approval_request", () => {
      const input = "\u001b[1;33mAllow this action?\u001b[0m [y/n] ";
      const events = parser.feed(input);

      const approval = events.find((e) => e.type === "approval_request");
      expect(approval).toBeDefined();
      expect(approval?.content).toBe("Allow this action? [y/n]");
    });
  });

  describe("Tool execution detection", () => {
    it("detects tool starts like 'Running Bash(...)'", () => {
      const input = "Running Bash(npm test)\nOutput:";
      const events = parser.feed(input);

      const toolEvent = events.find((e) => e.type === "tool_start");
      expect(toolEvent).toBeDefined();
      expect(toolEvent?.content).toBe("Bash(npm test)");
      expect(toolEvent?.metadata?.tool).toBe("Bash");
    });

    it("detects tool starts like 'Tool: Edit(src/lib/stream-parser.ts)' or 'Running Edit(...)'", () => {
      const input = "Tool: Edit(src/lib/stream-parser.ts)\nApplying diff...";
      const events = parser.feed(input);

      const toolEvent = events.find((e) => e.type === "tool_start");
      expect(toolEvent).toBeDefined();
      expect(toolEvent?.metadata?.tool).toBe("Edit");
    });

    it("does not misclassify inline function calls in prose as tool execution", () => {
      const input = "We should use parseInt(str, 10) or Array.from(items) here.";
      const events = parser.feed(input);

      const toolEvent = events.find((e) => e.type === "tool_start");
      expect(toolEvent).toBeUndefined();
      expect(events).toEqual([
        {
          type: "text",
          content: input,
        },
      ]);
    });
  });

  describe("reset()", () => {
    it("clears internal incomplete buffer", () => {
      parser.feed("Beginning \u001b[3");
      parser.reset();
      // After reset, previous partial escape is dropped, doesn't corrupt subsequent feeds
      const events = parser.feed("Fresh text");
      expect(events).toEqual([
        {
          type: "text",
          content: "Fresh text",
        },
      ]);
    });
  });
});
