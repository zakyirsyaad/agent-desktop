import { readFile } from "node:fs/promises";
import { ImageResponse } from "next/og";
import appPackage from "../../package.json";
import { SYMBOL_PATHS } from "../components/ui/ZorvoSymbol";
import { OG_COLORS as COLOR } from "../lib/og-colors";
import { SITE_TITLE } from "../lib/site";

export const dynamic = "force-static";
export const alt = SITE_TITLE;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// The image renderer reads .woff, not the .woff2 the page uses, so it loads the static cuts.
// `new URL(literal, import.meta.url)` makes the bundler copy each file into the build, so
// the path holds whatever directory the build runs from.
const FONTS = {
  500: new URL("../node_modules/@fontsource/instrument-sans/files/instrument-sans-latin-500-normal.woff", import.meta.url),
  600: new URL("../node_modules/@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff", import.meta.url),
};

/** The card shown when the page is shared: symbol and wordmark, the tagline, the agents. */
export default async function OpenGraphImage() {
  const [medium, semibold] = await Promise.all([readFile(FONTS[500]), readFile(FONTS[600])]);
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 80,
          background: COLOR.bg,
          color: COLOR.fg,
          fontFamily: "Instrument Sans",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <svg width="56" height="56" viewBox="0 0 40 40" fill="none" stroke={COLOR.fg} strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round">
            {SYMBOL_PATHS.prompts.map((d) => (
              <path key={d} d={d} />
            ))}
            <path d={SYMBOL_PATHS.cursor} />
          </svg>
          <span style={{ fontSize: 44, fontWeight: 600, letterSpacing: "-0.04em" }}>zorvo</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 84, fontWeight: 500, lineHeight: 1, letterSpacing: "-0.04em" }}>
            <span>Every coding agent.</span>
            <span>One desktop.</span>
          </div>
          <span style={{ fontSize: 30, fontWeight: 500, color: COLOR["fg-muted"] }}>
            Claude Code, Codex, Qwen and Aider in one native app.
          </span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            paddingTop: 28,
            borderTop: `1px solid ${COLOR.border}`,
            fontSize: 24,
            fontWeight: 500,
            color: COLOR["fg-subtle"],
          }}
        >
          <span>Free for macOS · No lock-in, no API keys</span>
          <span>v{appPackage.version}</span>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Instrument Sans", data: medium, weight: 500, style: "normal" },
        { name: "Instrument Sans", data: semibold, weight: 600, style: "normal" },
      ],
    },
  );
}
