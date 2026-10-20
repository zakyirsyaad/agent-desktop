import type { CatalogAgent } from "../../types";

/** Builds a catalog agent with every field, overriding only what a test cares about. */
export function makeCatalogAgent(overrides: Partial<CatalogAgent> & Pick<CatalogAgent, "id" | "name">): CatalogAgent {
  return {
    description: null,
    distribution: "npx",
    listed: true,
    version: null,
    updateVersion: null,
    status: "ready",
    availableFrom: null,
    location: null,
    ...overrides,
  };
}

/** What the fake `get_agent_catalog` returns, sorted by id like the backend. */
export const fakeCatalog: CatalogAgent[] = [
  makeCatalogAgent({ id: "claude-acp", name: "Claude Code", version: "1.2.0", updateVersion: "1.3.0", status: "by_zorvo" }),
  makeCatalogAgent({ id: "codex-acp", name: "Codex", version: "0.9.0", status: "by_zorvo" }),
  makeCatalogAgent({ id: "gemini", name: "Gemini CLI", description: "Google's coding agent", status: "not_installed" }),
  makeCatalogAgent({ id: "qwen-code", name: "Qwen Code", version: "0.4.0", status: "ready" }),
];
