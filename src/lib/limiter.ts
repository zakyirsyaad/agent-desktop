/** Starts `task`, or waits for a free slot first; aborting `signal` gives up its place or its slot. */
export type Limited = <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

function aborted(): Error {
  return new DOMException('The read was called off', 'AbortError');
}

/**
 * Runs at most `max` tasks at once; the rest wait their turn in order. A task
 * whose signal is aborted leaves the queue, or frees its slot at once even
 * though what it started may still finish (its result is then dropped).
 */
export function createLimiter(max: number): Limited {
  let running = 0;
  const waiting: Array<() => void> = [];

  const release = () => {
    running -= 1;
    waiting.shift()?.();
  };

  return <T>(task: () => Promise<T>, signal?: AbortSignal) =>
    new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(aborted());
        return;
      }
      const start = () => {
        running += 1;
        let isReleased = false;
        const finish = () => {
          if (isReleased) return;
          isReleased = true;
          signal?.removeEventListener('abort', onAbortRunning);
          release();
        };
        const onAbortRunning = () => {
          finish();
          reject(aborted());
        };
        signal?.addEventListener('abort', onAbortRunning, { once: true });
        task().then(
          (value) => {
            finish();
            resolve(value);
          },
          (error: unknown) => {
            finish();
            reject(error);
          },
        );
      };
      if (running < max) {
        start();
        return;
      }
      const onAbortWaiting = () => {
        const index = waiting.indexOf(startWhenFree);
        if (index >= 0) waiting.splice(index, 1);
        reject(aborted());
      };
      const startWhenFree = () => {
        signal?.removeEventListener('abort', onAbortWaiting);
        start();
      };
      signal?.addEventListener('abort', onAbortWaiting, { once: true });
      waiting.push(startWhenFree);
    });
}
