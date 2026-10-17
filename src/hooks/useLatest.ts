import { useLayoutEffect, useRef } from 'react';

/**
 * Keeps a ref pointing at the latest value, so long-lived callbacks (timers,
 * event listeners) can read it without being re-created on every render.
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
