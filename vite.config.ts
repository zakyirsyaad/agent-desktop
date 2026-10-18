import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  // xterm 6 ships minified code whose `||=` esbuild's syntax minifier breaks while
  // lowering it for the build target: the first terminal mode query then throws
  // and the terminal stops drawing (xtermjs/xterm.js#5800). Whitespace and
  // identifiers are still minified.
  esbuild: {
    minifySyntax: false,
  },
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
