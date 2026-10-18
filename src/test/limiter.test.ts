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
  it("rejects an aborted task at once and skips an aborted waiter", async () => {
    const run = createLimiter(1);
    const first = new AbortController();
    const second = new AbortController();
    let finishFirst: (value: string) => void = () => {};
    const running = run(() => new Promise<string>((resolve) => { finishFirst = resolve; }), first.signal);
    let skippedRan = false;
    const skipped = run(() => {
      skippedRan = true;
      return Promise.resolve("never");
    }, second.signal);
    const third = run(() => Promise.resolve("ran"));

    second.abort();
    first.abort();
    await expect(running).rejects.toThrow();
    await expect(skipped).rejects.toThrow();
    finishFirst("late");

    expect(await third).toBe("ran");
    expect(skippedRan).toBe(false);
  });
});

describe("createLimiter edge cases", () => {
  it("frees the slot of a task that throws before returning a promise", async () => {
    const run = createLimiter(1);
    const throwing = run(() => {
      throw new Error("sync boom");
    });
    await expect(throwing).rejects.toThrow("sync boom");

    expect(await run(() => Promise.resolve("next"))).toBe("next");
  });

  it("keeps an aborted running task's slot until what it started settles", async () => {
    const run = createLimiter(1);
    const controller = new AbortController();
    let finishFirst: (value: string) => void = () => {};
    const first = run(() => new Promise<string>((resolve) => { finishFirst = resolve; }), controller.signal);
    let secondStarted = false;
    const second = run(() => {
      secondStarted = true;
      return Promise.resolve("second");
    });

    controller.abort();
    await expect(first).rejects.toThrow();
    await Promise.resolve();
    // The first git process may still be running: the second waits for it.
    expect(secondStarted).toBe(false);

    finishFirst("late");
    expect(await second).toBe("second");
  });
});
