import { useRef, useState } from "react";
import type { ContextUsage } from "../../types";
import { useDismiss } from "../../hooks/useDismiss";

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

const tokens = (n: number) => `${n.toLocaleString("en-US")} tokens`;

/** An amount in its currency, e.g. "$0.42"; an unknown currency code is written out. */
function money({ amount, currency }: NonNullable<ContextUsage["cost"]>): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** The ring and percentage, or the tokens in use when the window's size is unknown. */
function Gauge({ used, size }: ContextUsage) {
  // Without the window's size there is no percentage: show the tokens in use.
  if (size <= 0) {
    return (
      // A named image, not a live region: each usage update is not announced.
      <span role="img" aria-label={`Context used: ${COMPACT_NUMBER.format(used)} tokens`} title={`Context: ${tokens(used)}`}>
        {COMPACT_NUMBER.format(used)} tokens
      </span>
    );
  }
  const percent = Math.min(100, Math.round((used / size) * 100));
  return (
    <span
      role="meter"
      aria-label="Context used"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      title={`Context: ${used.toLocaleString("en-US")} of ${tokens(size)} (${percent}%)`}
      className={`flex items-center gap-1 tabular-nums ${toneFor(percent)}`}
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
    </span>
  );
}

/** How full the agent's context window is; a click shows the numbers behind it. */
export function ContextMeter({ used, size, cost }: ContextUsage) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useDismiss(containerRef, isOpen, () => setIsOpen(false));
  const hasWindow = size > 0;
  const percent = hasWindow ? Math.min(100, Math.round((used / size) * 100)) : null;
  const rows: [string, string][] = [
    ["Used", tokens(used)],
    ...(hasWindow
      ? ([
          ["Context window", tokens(size)],
          ["Share used", `${percent}%`],
          ["Left", tokens(Math.max(0, size - used))],
        ] as [string, string][])
      : []),
    ...(cost ? ([["Session cost", money(cost)]] as [string, string][]) : []),
  ];

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Context details"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className="rounded px-1 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 focus:outline-none focus:ring-1 focus:ring-neutral-700"
      >
        <Gauge used={used} size={size} />
      </button>
      {isOpen && (
        <div
          role="dialog"
          aria-label="Context usage"
          className="absolute bottom-full right-0 z-50 mb-2 w-56 rounded-lg border border-neutral-800 bg-[#181818] p-3 text-xs shadow-2xl"
        >
          <p className="mb-2 font-medium text-neutral-200">Context usage</p>
          <dl className="space-y-1">
            {rows.map(([name, value]) => (
              <div key={name} className="flex justify-between gap-3">
                <dt className="text-neutral-500">{name}</dt>
                <dd className="tabular-nums text-neutral-200">{value}</dd>
              </div>
            ))}
          </dl>
          {percent !== null && percent >= WARN_AT && (
            <p className="mt-2 text-[11px] text-amber-400">
              The window is nearly full; the agent may summarize or drop older context.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
