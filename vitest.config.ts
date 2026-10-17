import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

// Test-only settings stay out of vite.config.ts, so dev and build never load vitest.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      // Agent worktrees under .claude/ hold copies of the tests; run only this checkout's.
      exclude: [...configDefaults.exclude, ".claude/**"],
    },
  }),
);
