import { useEffect, useState, type RefObject } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Where Tab must go to stay inside `container`, or null when it may move on as usual. */
function wrapTarget(container: HTMLElement, isBackward: boolean): HTMLElement | null {
  const focusables = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
  if (focusables.length === 0) return null;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (!(active instanceof Node) || !container.contains(active)) return isBackward ? last : first;
  if (isBackward && active === first) return last;
  if (!isBackward && active === last) return first;
  return null;
}

/**
 * Keeps Tab inside a modal while it is open, and gives focus back to what had
 * it before once the modal closes.
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>) {
  // Read as the modal first renders: its children may take focus before its own effects run.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const container = containerRef.current;
      if (event.key !== 'Tab' || !container) return;
      const target = wrapTarget(container, event.shiftKey);
      if (!target) return;
      event.preventDefault();
      target.focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [containerRef]);

  useEffect(
    () => () => {
      if (opener?.isConnected) opener.focus();
    },
    [opener],
  );
}
