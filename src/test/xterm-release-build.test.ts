// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild, type ESBuildOptions } from "vite";
import { describe, expect, it } from "vitest";
import viteConfig from "../../vite.config";

const XTERM = join(__dirname, "..", "..", "node_modules", "@xterm", "xterm", "lib", "xterm.mjs");
const RELEASE_TARGET = viteConfig.build?.target as string;

type XtermModule = typeof import("@xterm/xterm");

/**
 * xterm as a release build ships it: Vite re-minifies the dependency with esbuild,
 * for the build target, using the `esbuild` minify flags from vite.config.ts.
 */
async function releaseXterm(esbuild: ESBuildOptions | undefined): Promise<XtermModule> {
  const { code } = await transformWithEsbuild(readFileSync(XTERM, "utf8"), "xterm.mjs", {
    target: RELEASE_TARGET,
    format: "esm",
    minifyWhitespace: true,
    minifyIdentifiers: esbuild?.minifyIdentifiers ?? true,
    minifySyntax: esbuild?.minifySyntax ?? true,
  });
  const file = join(mkdtempSync(join(tmpdir(), "xterm-release-")), "xterm.mjs");
  writeFileSync(file, code);
  return import(/* @vite-ignore */ pathToFileURL(file).href);
}

/** How long a parse may take before the terminal counts as stuck. */
const PARSE_TIMEOUT_MS = 1000;

/**
 * What the terminal answers when an agent asks whether it supports synchronized
 * output. A broken parser never calls back, so the answer is whatever arrived in time.
 */
async function answerToModeQuery({ Terminal }: XtermModule): Promise<string> {
  const terminal = new Terminal({ allowProposedApi: true });
  const answers: string[] = [];
  terminal.onData((data) => answers.push(data));
  await new Promise<void>((resolve) => {
    setTimeout(resolve, PARSE_TIMEOUT_MS);
    terminal.write("\x1b[?2026$p", resolve);
  });
  terminal.dispose();
  return answers.join("");
}

describe("xterm in a release build", () => {
  // xtermjs/xterm.js#5800: esbuild's syntax minifier, downlevelling xterm's `||=`
  // for an older target, drops a variable that DECRQM needs. The first mode query
  // (Oh-My-Pi sends one at start) then throws, and the terminal stops drawing.
  it("still answers a terminal mode query", async () => {
    const xterm = await releaseXterm(viteConfig.esbuild || undefined);
    expect(await answerToModeQuery(xterm)).toBe("\x1b[?2026;2$y");
  });
});
