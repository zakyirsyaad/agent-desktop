/** Starts `task`, or waits for a free slot first; aborting `signal` gives up its place in line. */
export type Limited = <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

function aborted(): Error {
  return new DOMException('The read was called off', 'AbortError');
}

/**
 * Runs at most `max` tasks at once; the rest wait their turn in order. A waiting
 * task whose signal is aborted leaves the line. A running one is rejected at
 * once, but keeps its slot until what it started settles: the work (a git
 * process) still runs, and the cap is on that work, not on who waits for it.
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
        const onAbort = () => reject(aborted());
        signal?.addEventListener('abort', onAbort, { once: true });
        let work: Promise<T>;
        try {
          work = task();
        } catch (error) {
          work = Promise.reject(error);
        }
        work
          .then(resolve, reject)
          .finally(() => {
            signal?.removeEventListener('abort', onAbort);
            release();
          });
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
