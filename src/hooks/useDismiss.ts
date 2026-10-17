import { useEffect, type RefObject } from 'react';
import { useLatest } from './useLatest';

/** Closes a popover on a click outside `ref` or on Escape, while it is open. */
export function useDismiss(ref: RefObject<HTMLElement | null>, isOpen: boolean, onClose: () => void): void {
  const onCloseRef = useLatest(onClose);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onCloseRef.current();
    };
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen, ref, onCloseRef]);
}
