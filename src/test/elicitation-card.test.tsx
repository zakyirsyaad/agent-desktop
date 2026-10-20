import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ElicitationCard } from "../components/chat/ElicitationCard";
import type { ElicitationCard as ElicitationCardData, ElicitationField } from "../types";

function formCard(
  fields: ElicitationField[],
  extra: Partial<ElicitationCardData> = {},
): ElicitationCardData {
  return {
    key: "e1",
    sessionId: "s1",
    mode: "form",
    message: "Tell me more",
    status: "pending",
    timestamp: 1,
    fields,
    ...extra,
  };
}

function urlCard(extra: Partial<ElicitationCardData> = {}): ElicitationCardData {
  return {
    key: "u1",
    sessionId: "s1",
    mode: "url",
    message: "Sign in please",
    status: "pending",
    timestamp: 1,
    url: "https://example.com/login?x=1",
    host: "example.com",
    ...extra,
  };
}

const valueOf = (el: HTMLElement) => (el as HTMLInputElement).value;
const checkedOf = (el: HTMLElement) => (el as HTMLInputElement).checked;

const choices = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ value: `v${i}`, title: `Option ${i}` }));

describe("ElicitationCard", () => {
  it("renders every field kind with defaults", () => {
    const fields: ElicitationField[] = [
      { name: "email", title: "Email", required: true, kind: { type: "text", format: "email" }, default: "a@b.co", description: "Work address" },
      { name: "count", title: "Count", required: false, kind: { type: "number", integer: true }, default: 3 },
      { name: "agree", title: "Agree", required: false, kind: { type: "boolean" }, default: true },
      { name: "few", title: "Few", required: false, kind: { type: "select", options: choices(3) }, default: "v1" },
      { name: "many", title: "Many", required: false, kind: { type: "select", options: choices(6) } },
      { name: "tags", title: "Tags", required: false, kind: { type: "multiSelect", options: choices(2) }, default: ["v0"] },
      { name: "day", title: "Day", required: false, kind: { type: "text", format: "date" }, default: "2026-10-20" },
      { name: "when", title: "When", required: false, kind: { type: "text", format: "date-time" } },
    ];
    const { container } = render(
      <ElicitationCard
        card={formCard(fields, { message: "See https://evil.example/x now" })}
        agentName="Claude Code"
      />,
    );
    expect(screen.getByText("Claude Code asks for input")).toBeTruthy();
    expect(valueOf(screen.getByLabelText(/Email/))).toBe(String("a@b.co"));
    expect(screen.getByLabelText(/Email/).getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Work address")).toBeTruthy();
    expect(valueOf(screen.getByLabelText(/Count/))).toBe(String(3));
    expect(checkedOf(screen.getByLabelText(/Agree/))).toBe(true);
    expect(checkedOf(screen.getByRole("radio", { name: "Option 1" }))).toBe(true);
    expect(screen.getByRole("radiogroup", { name: /Few/ })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: /Many/ })).toBeTruthy();
    expect(checkedOf(screen.getByRole("checkbox", { name: "Option 0" }))).toBe(true);
    expect(checkedOf(screen.getByRole("checkbox", { name: "Option 1" }))).toBe(false);
    expect(valueOf(screen.getByLabelText(/Day/))).toBe(String("2026-10-20"));
    expect(container.querySelector('input[type="datetime-local"]')).not.toBeNull();
    expect(screen.getByText("See https://evil.example/x now")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows client errors and keeps typed values", () => {
    const onAnswer = vi.fn();
    const fields: ElicitationField[] = [
      { name: "name", title: "Name", required: false, kind: { type: "text", minLength: 2 } },
    ];
    render(<ElicitationCard card={formCard(fields)} agentName="A" onAnswer={onAnswer} />);
    const input = screen.getByLabelText(/Name/);
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Use at least 2 characters.");
    expect(valueOf(input)).toBe("x");
    fireEvent.change(input, { target: { value: "xy" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onAnswer).toHaveBeenCalledWith("e1", { action: "accept", content: { name: "xy" } });
  });

  it("shows backend errors from the card and keeps values when the card returns to pending", () => {
    const fields: ElicitationField[] = [
      { name: "name", title: "Name", required: false, kind: { type: "text" } },
    ];
    const { rerender } = render(<ElicitationCard card={formCard(fields)} agentName="A" />);
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "typed" } });
    rerender(<ElicitationCard card={formCard(fields, { status: "submitted", fields: undefined })} agentName="A" />);
    rerender(
      <ElicitationCard
        card={formCard(fields, { errors: { name: "Use the format the agent asked for." } })}
        agentName="A"
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("Use the format the agent asked for.");
    expect(valueOf(screen.getByLabelText(/Name/))).toBe(String("typed"));
  });

  it("decline and dismiss send their actions", () => {
    const onAnswer = vi.fn();
    render(<ElicitationCard card={formCard([])} agentName="A" onAnswer={onAnswer} />);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(onAnswer).toHaveBeenLastCalledWith("e1", { action: "decline" });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onAnswer).toHaveBeenLastCalledWith("e1", { action: "cancel" });
  });

  it("url card shows the full url, host and warnings", () => {
    const onAnswer = vi.fn();
    render(
      <ElicitationCard card={urlCard({ warnings: ["punycode", "ip-address", "user-info"] })} agentName="Codex" onAnswer={onAnswer} />,
    );
    expect(screen.getByText("Codex wants to open a page")).toBeTruthy();
    expect(screen.getByText("https://example.com/login?x=1", { exact: false })).toBeTruthy();
    expect(screen.getByText("example.com").tagName).toBe("STRONG");
    expect(screen.getByText("This address uses look-alike characters.")).toBeTruthy();
    expect(screen.getByText("This address is a bare IP address.")).toBeTruthy();
    expect(screen.getByText("This address hides a name before the @.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open in browser" }));
    expect(onAnswer).toHaveBeenCalledWith("u1", { action: "accept" });
  });

  it("blocked url offers no open", () => {
    render(<ElicitationCard card={urlCard({ blocked: "Zorvo only opens https addresses." })} agentName="A" />);
    expect(screen.queryByRole("button", { name: "Open in browser" })).toBeNull();
    expect(screen.getByText("Zorvo only opens https addresses.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
  });

  it("unsupported field offers no submit", () => {
    const fields: ElicitationField[] = [
      { name: "x", required: false, kind: { type: "unsupported", rawType: "object" } },
    ];
    render(<ElicitationCard card={formCard(fields)} agentName="A" />);
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    expect(
      screen.getByText("This form has a field Zorvo cannot show. You can decline or dismiss it."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decline" })).toBeTruthy();
  });

  it("answered cards show a summary", () => {
    const onReopen = vi.fn();
    const lines: [ElicitationCardData["status"], string][] = [
      ["submitted", "You sent the form."],
      ["declined", "You declined."],
      ["dismissed", "You dismissed this request."],
      ["unanswered", "This request was not answered."],
      ["completed", "Finished in your browser."],
      ["opened", "Opened in your browser."],
    ];
    for (const [status, text] of lines) {
      const { unmount } = render(
        <ElicitationCard card={formCard([], { status, fields: undefined })} agentName="A" onReopen={onReopen} />,
      );
      expect(screen.getByText(text)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
      unmount();
    }
    render(<ElicitationCard card={urlCard({ status: "opened" })} agentName="A" onReopen={onReopen} />);
    fireEvent.click(screen.getByRole("button", { name: "Open again" }));
    expect(onReopen).toHaveBeenCalledWith("u1");
  });

  it("privacy: typed values leave the card once it is answered", () => {
    const fields: ElicitationField[] = [
      { name: "name", title: "Name", required: false, kind: { type: "text" } },
    ];
    const onAnswer = vi.fn();
    const { container, rerender } = render(
      <ElicitationCard card={formCard(fields)} agentName="A" onAnswer={onAnswer} />,
    );
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "secret-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onAnswer).toHaveBeenCalled();
    rerender(
      <ElicitationCard card={formCard(fields, { status: "submitted", fields: undefined })} agentName="A" onAnswer={onAnswer} />,
    );
    expect(container.textContent).not.toContain("secret-value");
    expect(container.querySelector("input")).toBeNull();
  });

  it.each(["declined", "dismissed"] as const)(
    "privacy: typed values are gone when a %s card is shown pending again",
    (status) => {
      const fields: ElicitationField[] = [
        { name: "name", title: "Name", required: false, kind: { type: "text" } },
      ];
      const { rerender } = render(<ElicitationCard card={formCard(fields)} agentName="A" />);
      fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "secret-value" } });
      rerender(<ElicitationCard card={formCard(fields, { status, fields: undefined })} agentName="A" />);
      rerender(<ElicitationCard card={formCard(fields)} agentName="A" />);
      expect(valueOf(screen.getByLabelText(/Name/))).toBe("");
    },
  );

  it("keeps typed values across a submitted to pending round trip", () => {
    const fields: ElicitationField[] = [
      { name: "name", title: "Name", required: false, kind: { type: "text" } },
    ];
    const { rerender } = render(<ElicitationCard card={formCard(fields)} agentName="A" />);
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "secret-value" } });
    rerender(<ElicitationCard card={formCard(fields, { status: "submitted", fields: undefined })} agentName="A" />);
    rerender(<ElicitationCard card={formCard(fields)} agentName="A" />);
    expect(valueOf(screen.getByLabelText(/Name/))).toBe("secret-value");
  });

  it("offers no Open again on an opened card without onReopen", () => {
    render(<ElicitationCard card={urlCard({ status: "opened" })} agentName="A" />);
    expect(screen.queryByRole("button", { name: "Open again" })).toBeNull();
  });
});
