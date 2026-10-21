import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "../lib/relative-time";

const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
const secondsAgo = (seconds: number) => NOW - seconds * 1000;

describe("formatRelativeTime", () => {
  it("says Just now under a minute", () => {
    expect(formatRelativeTime(secondsAgo(59), NOW)).toBe("Just now");
  });

  it("turns a minute at 60 seconds", () => {
    expect(formatRelativeTime(secondsAgo(60), NOW)).toBe("1 minute ago");
  });

  it("keeps counting minutes up to 59", () => {
    expect(formatRelativeTime(secondsAgo(59 * 60), NOW)).toBe("59 minutes ago");
  });

  it("turns an hour at 60 minutes", () => {
    expect(formatRelativeTime(secondsAgo(60 * 60), NOW)).toBe("1 hour ago");
  });

  it("keeps counting hours up to 23", () => {
    expect(formatRelativeTime(secondsAgo(23 * 60 * 60), NOW)).toBe("23 hours ago");
  });

  it("turns a day at 24 hours", () => {
    expect(formatRelativeTime(secondsAgo(24 * 60 * 60), NOW)).toBe("1 day ago");
  });

  it("pluralizes minutes and days", () => {
    expect(formatRelativeTime(secondsAgo(5 * 60), NOW)).toBe("5 minutes ago");
    expect(formatRelativeTime(secondsAgo(3 * 24 * 60 * 60), NOW)).toBe("3 days ago");
  });

  it("says Just now for a timestamp in the future", () => {
    expect(formatRelativeTime(NOW + 60_000, NOW)).toBe("Just now");
  });
});