import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  EllipsisVertical,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Link,
  type LucideIcon,
} from "lucide-react";
import type { PullRequestSummary } from "../../hooks/useRepoPullRequests";
import { useDismiss } from "../../hooks/useDismiss";

/** How many of the newest pull requests show before "Show all". */
const SHOWN_AT_FIRST = 5;

const MENU_ITEM =
  "flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-neutral-300 transition-colors hover:bg-neutral-800/60 hover:text-neutral-100";

const STATE_LOOK: Record<string, { icon: LucideIcon; name: string; style: string }> = {
  open: { icon: GitPullRequest, name: "Open", style: "text-emerald-400" },
  draft: { icon: GitPullRequestDraft, name: "Draft", style: "text-neutral-400" },
  merged: { icon: GitMerge, name: "Merged", style: "text-purple-400" },
  closed: { icon: GitPullRequestClosed, name: "Closed", style: "text-rose-400" },
};

/** "repo #N", the repository read from the pull request's link; just "#N" when the link has none. */
export function repoLabelOf({ number, url }: PullRequestSummary): string {
  const repo = /\/([^/]+)\/pull\/\d+/.exec(url)?.[1];
  return repo ? `${repo} #${number}` : `#${number}`;
}

/** Room the menu needs below its button before it opens upward instead. */
const MENU_HEIGHT_PX = 76;
const MENU_GAP_PX = 4;

/** Where the menu sits on screen: fixed, so the panel's scrolling list cannot clip it. */
type MenuPlace = { right: number } & ({ top: number } | { bottom: number });

function menuPlaceFor(button: HTMLElement): MenuPlace {
  const rect = button.getBoundingClientRect();
  const right = window.innerWidth - rect.right;
  const hasRoomBelow = rect.bottom + MENU_GAP_PX + MENU_HEIGHT_PX <= window.innerHeight;
  return hasRoomBelow
    ? { right, top: rect.bottom + MENU_GAP_PX }
    : { right, bottom: window.innerHeight - rect.top + MENU_GAP_PX };
}

/** A pull request's ⋮ menu: open it in the browser, or copy its link. */
function RowMenu({ pullRequest, onOpen }: { pullRequest: PullRequestSummary; onOpen: (url: string) => void }) {
  const [place, setPlace] = useState<MenuPlace | null>(null);
  const isOpen = place !== null;
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = () => setPlace(null);
  useDismiss(containerRef, isOpen, close);
  // A fixed menu would drift from its row as the list scrolls.
  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [isOpen]);
  const toggle = () => setPlace((current) => (current || !buttonRef.current ? null : menuPlaceFor(buttonRef.current)));
  const pick = (action: () => void) => () => {
    close();
    action();
  };
  const copyLink = () => {
    navigator.clipboard?.writeText(pullRequest.url).catch(() => {});
  };

  return (
    <div ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`More actions for #${pullRequest.number}`}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={toggle}
        className={`rounded p-1 text-neutral-500 opacity-0 hover:text-neutral-200 focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-neutral-600 group-hover:opacity-100 ${isOpen ? "opacity-100" : ""}`}
      >
        <EllipsisVertical size={12} />
      </button>
      {place && (
        <div
          role="menu"
          aria-label={`Actions for #${pullRequest.number}`}
          style={place}
          className="fixed z-50 w-40 rounded-lg border border-neutral-800 bg-[#181818] p-1 shadow-2xl"
        >
          <button type="button" role="menuitem" onClick={pick(() => onOpen(pullRequest.url))} className={MENU_ITEM}>
            <ExternalLink size={12} aria-hidden="true" /> Open in browser
          </button>
          <button type="button" role="menuitem" onClick={pick(copyLink)} className={MENU_ITEM}>
            <Link size={12} aria-hidden="true" /> Copy link
          </button>
        </div>
      )}
    </div>
  );
}

function PullRequestRow({ pullRequest, onOpen }: { pullRequest: PullRequestSummary; onOpen: (url: string) => void }) {
  const state = pullRequest.isDraft && pullRequest.state === "open" ? "draft" : pullRequest.state;
  const look = STATE_LOOK[state] ?? STATE_LOOK.open;
  const Icon = look.icon;
  return (
    <div className="group flex items-center gap-1 rounded-md px-1.5 text-neutral-400 hover:bg-neutral-900/60 hover:text-neutral-200">
      <Icon size={13} role="img" aria-label={look.name} className={`shrink-0 ${look.style}`} />
      <button
        type="button"
        onClick={() => onOpen(pullRequest.url)}
        title={pullRequest.title}
        className="min-w-0 flex-1 py-1 pl-1 text-left"
      >
        <span className="block truncate text-neutral-200">{pullRequest.title}</span>
        <span className="block truncate text-[10px] text-neutral-500">{repoLabelOf(pullRequest)}</span>
      </button>
      <RowMenu pullRequest={pullRequest} onOpen={onOpen} />
    </div>
  );
}

/**
 * The pull requests the user opened in this repository, like the Changes
 * card of Claude Code Desktop: the newest few, oldest of them first, and
 * all of them on request. It folds away to a single line.
 */
export function PullRequestList({ pullRequests, onOpen }: {
  /** Newest first, as gh lists them. */
  pullRequests: readonly PullRequestSummary[];
  onOpen: (url: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isShowingAll, setIsShowingAll] = useState(false);
  const shown = (isShowingAll ? pullRequests : pullRequests.slice(0, SHOWN_AT_FIRST)).slice().reverse();
  const hasMore = pullRequests.length > SHOWN_AT_FIRST;

  return (
    <section className="border-b border-neutral-800/60 p-1.5">
      <button
        type="button"
        onClick={() => setIsExpanded((open) => !open)}
        aria-expanded={isExpanded}
        className="flex w-full items-center gap-1 rounded px-1.5 py-1 text-left text-[11px] font-medium text-neutral-400 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-700"
      >
        <ChevronRight size={11} aria-hidden="true" className={`transition-transform ${isExpanded ? "rotate-90" : ""}`} />
        Pull requests <span className="text-neutral-600">({pullRequests.length})</span>
      </button>
      {isExpanded && pullRequests.length === 0 && (
        <p className="px-2 py-1 text-[11px] text-neutral-500">No pull requests of yours here yet.</p>
      )}
      {isExpanded && pullRequests.length > 0 && (
        <>
          <ul aria-label="Pull requests" className="space-y-0.5">
            {shown.map((pullRequest) => (
              <li key={pullRequest.number}>
                <PullRequestRow pullRequest={pullRequest} onOpen={onOpen} />
              </li>
            ))}
          </ul>
          {hasMore && (
            <button
              type="button"
              onClick={() => setIsShowingAll((all) => !all)}
              className="mt-0.5 px-2 py-1 text-[11px] text-neutral-500 hover:text-neutral-200 focus:outline-none focus:ring-1 focus:ring-neutral-700"
            >
              {isShowingAll ? "Show less" : `Show all (${pullRequests.length})`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
