import {
  useCallback,
  useRef,
  type KeyboardEvent,
  type RefObject,
  type TouchEvent,
  type WheelEvent,
} from "react";

/** How close to the bottom still counts as following new output. */
export const STICK_TO_BOTTOM_PX = 80;

const KEYS_THAT_MOVE_UP = new Set(["PageUp", "ArrowUp", "Home"]);

export interface StickToBottom {
  containerRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  onWheel: (event: WheelEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onTouchStart: (event: TouchEvent<HTMLDivElement>) => void;
  onTouchMove: (event: TouchEvent<HTMLDivElement>) => void;
  /** Brings the newest output into view and follows it again. */
  scrollToBottom: () => void;
  /** Follows grown content, unless the user scrolled away to read. */
  followNewContent: () => void;
}

/**
 * Keeps a scroll container at its newest output while the user stays there.
 * Any small move up leaves the bottom at once, so a streaming reply cannot
 * pull the view back down under a slow trackpad scroll. Only scrolling back
 * within {@link STICK_TO_BOTTOM_PX} of the bottom resumes following.
 */
export function useStickToBottom(): StickToBottom {
  const containerRef = useRef<HTMLDivElement>(null);
  const isFollowingRef = useRef(true);
  // The scrollTop this hook set itself: its scroll event is not the user's.
  const ownScrollTopRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const lastTouchYRef = useRef<number | null>(null);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    isFollowingRef.current = true;
    el.scrollTop = el.scrollHeight;
    ownScrollTopRef.current = el.scrollTop;
    lastScrollTopRef.current = el.scrollTop;
  }, []);

  const followNewContent = useCallback(() => {
    const el = containerRef.current;
    // Reading scrollHeight lays the whole list out: only a follower pays for it.
    if (!el || !isFollowingRef.current) return;
    el.scrollTop = el.scrollHeight;
    ownScrollTopRef.current = el.scrollTop;
    lastScrollTopRef.current = el.scrollTop;
  }, []);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const top = el.scrollTop;
    if (ownScrollTopRef.current !== null && top === ownScrollTopRef.current) {
      // The event for the hook's own assignment, after the content may have
      // grown; it says nothing about where the user wants the view.
      ownScrollTopRef.current = null;
      lastScrollTopRef.current = top;
      return;
    }
    ownScrollTopRef.current = null;
    if (top < lastScrollTopRef.current) isFollowingRef.current = false;
    else if (el.scrollHeight - top - el.clientHeight <= STICK_TO_BOTTOM_PX) isFollowingRef.current = true;
    lastScrollTopRef.current = top;
  }, []);

  const onWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) isFollowingRef.current = false;
  }, []);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (KEYS_THAT_MOVE_UP.has(event.key)) isFollowingRef.current = false;
  }, []);

  const onTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    lastTouchYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const onTouchMove = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const y = event.touches[0]?.clientY;
    if (y === undefined) return;
    const last = lastTouchYRef.current;
    // A finger moving down pulls earlier content into view.
    if (last !== null && y > last) isFollowingRef.current = false;
    lastTouchYRef.current = y;
  }, []);

  return {
    containerRef,
    onScroll,
    onWheel,
    onKeyDown,
    onTouchStart,
    onTouchMove,
    scrollToBottom,
    followNewContent,
  };
}