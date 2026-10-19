interface ZorvoSymbolProps {
  /** Rendered size in px. Under 32px uses the small variant: no cursor, heavier stroke. */
  size: number;
  className?: string;
}

/** The double-prompt symbol from docs/brand/assets, drawn in currentColor. Decorative: label the link around it. */
export function ZorvoSymbol({ size, className }: ZorvoSymbolProps) {
  const isSmall = size < 32;
  return (
    <svg
      width={size}
      height={size}
      viewBox={isSmall ? "-3 0 40 40" : "0 0 40 40"}
      fill="none"
      stroke="currentColor"
      strokeWidth={isSmall ? 6 : 3.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d="M6 7l10 7-10 7" />
      <path d="M18 19l10 7-10 7" />
      {!isSmall && <path d="M30 33h5" />}
    </svg>
  );
}

/** Symbol and `zorvo` wordmark, linking to the top of the page. */
export function ZorvoLockup() {
  return (
    <a
      href="#top"
      aria-label="Zorvo home"
      className="focus-ring inline-flex items-center gap-[7px] rounded-sm text-fg no-underline"
    >
      <ZorvoSymbol size={24} />
      <span className="text-[20px] leading-5 font-semibold tracking-[-0.04em]">zorvo</span>
    </a>
  );
}
