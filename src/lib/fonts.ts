const FONT_LOADS = [
  '400 14px "Instrument Sans Variable"',
  '400 12px "Geist Mono Variable"',
] as const;

/**
 * Resolves once both bundled font families are loaded, or after `timeoutMs`,
 * whichever comes first. Never rejects, so a missing font cannot block startup.
 */
export async function loadAppFonts(timeoutMs = 1000): Promise<void> {
  const fonts = document.fonts;
  if (!fonts?.load) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  const loaded = Promise.allSettled(FONT_LOADS.map((font) => fonts.load(font))).then(
    () => undefined
  );
  try {
    await Promise.race([loaded, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
