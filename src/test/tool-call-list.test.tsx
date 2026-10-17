import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ToolCallList } from "../components/chat/ToolCallList";
import type { ToolExecution } from "../types";

const editTool: ToolExecution = {
  id: "t-1",
  name: "Edit src/app.ts",
  args: "",
  status: "completed",
  kind: "edit",
  details: [{ kind: "diff", path: "/repo/src/app.ts", oldText: "keep\nconst a = 1;\n", newText: "keep\nconst a = 2;\n" }],
};

describe("ToolCallList", () => {
  it("shows a tool's diff with removed and added lines, open by default", () => {
    render(<ToolCallList tools={[editTool]} />);

    const diff = screen.getByRole("region", { name: "Changes to /repo/src/app.ts" });
    expect(within(diff).getByText("const a = 1;").closest("[data-line]")?.getAttribute("data-line")).toBe("removed");
    expect(within(diff).getByText("const a = 2;").closest("[data-line]")?.getAttribute("data-line")).toBe("added");
    expect(within(diff).getByText("keep").closest("[data-line]")?.getAttribute("data-line")).toBe("context");
    expect(screen.getByText("Edit src/app.ts").closest("details")?.open).toBe(true);
  });

  it("labels a new file and counts its lines", () => {
    render(
      <ToolCallList
        tools={[{ ...editTool, details: [{ kind: "diff", path: "/repo/new.ts", oldText: null, newText: "a\nb\n" }] }]}
      />
    );

    expect(screen.getByText("New file")).toBeDefined();
    expect(screen.getByText("+2")).toBeDefined();
  });

  it("keeps a tool's text output collapsed until asked", () => {
    render(
      <ToolCallList
        tools={[{ ...editTool, name: "Run npm test", kind: "execute", details: [{ kind: "text", text: "12 passed" }] }]}
      />
    );

    expect(screen.getByText("12 passed")).toBeDefined();
    expect(screen.getByText("Run npm test").closest("details")?.open).toBe(false);
  });

  it("shows a plain row for a tool without details", () => {
    render(<ToolCallList tools={[{ ...editTool, details: undefined }]} />);

    expect(screen.getByText("Edit src/app.ts").closest("details")).toBeNull();
  });
});
