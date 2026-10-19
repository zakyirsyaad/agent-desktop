import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import appPackage from "../../package.json";
import { SITE_TITLE } from "../lib/site";

export const dynamic = "force-static";
export const alt = SITE_TITLE;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// The dark theme's values from app/globals.css: the image is drawn outside the page's CSS.
const COLOR = { bg: "#0a0a0b", border: "#27272a", fg: "#fafafa", muted: "#a1a1aa", subtle: "#8b8b94" };

// The image renderer reads .woff, not the .woff2 the page uses, so it loads the static cuts.
const font = (weight: 500 | 600) =>
  readFile(
    join(process.cwd(), "node_modules/@fontsource/instrument-sans/files", `instrument-sans-latin-${weight}-normal.woff`),
  );

/** The card shown when the page is shared: symbol and wordmark, the tagline, the agents. */
export default async function OpenGraphImage() {
  const [medium, semibold] = await Promise.all([font(500), font(600)]);
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
            <path d="M6 7l10 7-10 7" />
            <path d="M18 19l10 7-10 7" />
            <path d="M30 33h5" />
          </svg>
          <span style={{ fontSize: 44, fontWeight: 600, letterSpacing: "-0.04em" }}>zorvo</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 84, fontWeight: 500, lineHeight: 1, letterSpacing: "-0.04em" }}>
            <span>Every coding agent.</span>
            <span>One desktop.</span>
          </div>
          <span style={{ fontSize: 30, fontWeight: 500, color: COLOR.muted }}>
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
            color: COLOR.subtle,
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
