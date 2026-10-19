import { describe, expect, it } from "vitest";
import { mergeObserved } from "./registry-history.mjs";

const entry = (id, version) => ({
  id,
  name: id,
  version,
  distribution: { npx: { package: `${id}@${version}` } },
});

const NOW = 1_000_000;

describe("mergeObserved", () => {
  it("keeps an existing date", () => {
    const history = { agents: { a: { "1.0.0": { first_seen: 5, entry: entry("a", "1.0.0") } } } };
    const merged = mergeObserved(history, [entry("a", "1.0.0")], NOW, () => 1);
    expect(merged.agents.a["1.0.0"].first_seen).toBe(5);
  });

  it("dates a new version by its publish time when that is earlier", () => {
    const merged = mergeObserved({ agents: {} }, [entry("a", "2.0.0")], NOW, () => 400);
    expect(merged.agents.a["2.0.0"].first_seen).toBe(400);
  });

  it("dates a version without a publish time today", () => {
    const merged = mergeObserved({ agents: {} }, [entry("a", "2.0.0")], NOW, () => null);
    expect(merged.agents.a["2.0.0"].first_seen).toBe(NOW);
    const later = mergeObserved({ agents: {} }, [entry("a", "2.0.0")], NOW, () => NOW + 50);
    expect(later.agents.a["2.0.0"].first_seen).toBe(NOW);
  });

  it("does not mutate its input", () => {
    const history = { agents: { a: { "1.0.0": { first_seen: 5, entry: entry("a", "1.0.0") } } } };
    const snapshot = structuredClone(history);
    const merged = mergeObserved(history, [entry("a", "2.0.0")], NOW, () => null);
    expect(history).toEqual(snapshot);
    expect(merged).not.toBe(history);
  });
});
