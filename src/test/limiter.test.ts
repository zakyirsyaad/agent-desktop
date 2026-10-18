import { describe, expect, it } from "vitest";
import { createLimiter } from "../lib/limiter";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createLimiter", () => {
  it("runs at most `max` tasks at once and starts the next as one ends", async () => {
    const run = createLimiter(2);
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const started: number[] = [];
    const results = gates.map((gate, index) =>
      run(() => {
        started.push(index);
        return gate.promise;
      }),
    );

    await Promise.resolve();
    expect(started).toEqual([0, 1]);

    gates[0].resolve("a");
    await results[0];
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);

    gates[1].resolve("b");
    gates[2].resolve("c");
    expect(await Promise.all(results)).toEqual(["a", "b", "c"]);
  });

  it("frees a slot when a task fails", async () => {
    const run = createLimiter(1);
    const failing = run(() => Promise.reject(new Error("boom")));
    const next = run(() => Promise.resolve("ok"));

    await expect(failing).rejects.toThrow("boom");
    expect(await next).toBe("ok");
  });
});

describe("createLimiter with a signal", () => {
  it("frees the slot of an aborted task and skips an aborted waiter", async () => {
    const run = createLimiter(1);
    const first = new AbortController();
    const second = new AbortController();
    const hanging = run(() => new Promise<string>(() => {}), first.signal);
    const skipped = run(() => Promise.resolve("never"), second.signal);
    const third = run(() => Promise.resolve("ran"));

    second.abort();
    first.abort();

    await expect(hanging).rejects.toThrow();
    await expect(skipped).rejects.toThrow();
    expect(await third).toBe("ran");
  });
});
