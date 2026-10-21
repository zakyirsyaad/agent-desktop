/**
 * Format a timestamp as how long ago it was, e.g. "Just now", "2 minutes ago",
 * "5 hours ago", "3 days ago". A timestamp in the future reads as "Just now".
 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const diffSec = Math.floor((now - timestamp) / 1000);
  if (diffSec < 60) return "Just now";
  const ago = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return ago(diffMin, "minute");
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return ago(diffHour, "hour");
  return ago(Math.floor(diffHour / 24), "day");
}
