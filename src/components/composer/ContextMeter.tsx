import type { ContextUsage } from "../../types";

const COMPACT_NUMBER = new Intl.NumberFormat("en-US", { notation: "compact" });
const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const WARN_AT = 80;
const FULL_AT = 95;

function toneFor(percent: number): string {
  if (percent >= FULL_AT) return "text-rose-400";
  if (percent >= WARN_AT) return "text-amber-400";
  return "text-neutral-400";
}

/** How full the agent's context window is, as a small ring and a percentage. */
export function ContextMeter({ used, size }: ContextUsage) {
  const format = (n: number) => n.toLocaleString("en-US");
  // Without the window's size there is no percentage: show the tokens in use.
  if (size <= 0) {
    return (
      <span
        role="status"
        aria-label="Context used"
        title={`Context: ${format(used)} tokens`}
        className="px-1 text-[11px] text-neutral-400"
      >
        {COMPACT_NUMBER.format(used)} tokens
      </span>
    );
  }
  const percent = Math.min(100, Math.round((used / size) * 100));
  return (
    <div
      role="meter"
      aria-label="Context used"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      title={`Context: ${format(used)} of ${format(size)} tokens (${percent}%)`}
      className={`flex items-center gap-1 px-1 text-[11px] tabular-nums ${toneFor(percent)}`}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="-rotate-90">
        <circle cx="8" cy="8" r={RADIUS} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        {/* A round cap paints a dot even at length 0, so there is no arc at 0%. */}
        {percent > 0 && (
          <circle
            cx="8"
            cy="8"
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${(percent / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
          />
        )}
      </svg>
      <span>{percent}%</span>
    </div>
  );
}
