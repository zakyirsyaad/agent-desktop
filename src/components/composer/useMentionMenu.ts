import { useRef, useState } from 'react';
import { matchFiles, mentionAt, type MentionQuery } from '../../lib/mentions';

/** Where @-mentions come from: a workspace and how to list its files. */
export interface MentionSource {
  /** The workspace folder; mentioned files are inserted as paths inside it. */
  root: string;
  /** The workspace's files relative to `root`; failures are the caller's to report. */
  loadFiles: () => Promise<string[]>;
}

export interface MentionMenuState {
  /** The @word being typed, or null when there is none. */
  mention: MentionQuery | null;
  /** The files offered for it. */
  files: string[];
  /** Follows the prompt's text and caret. */
  update: (text: string, caret: number) => void;
  close: () => void;
}

/**
 * The @-mention list: the workspace's files are read once per workspace,
 * the first time an @ is typed, and filtered as the user types.
 */
export function useMentionMenu(source: MentionSource | undefined): MentionMenuState {
  const [mention, setMention] = useState<MentionQuery | null>(null);
  // Kept per workspace: a list that arrives late for one cannot replace another's.
  const [listings, setListings] = useState<Readonly<Record<string, string[]>>>({});
  const requestedRef = useRef(new Set<string>());

  const update = (text: string, caret: number) => {
    const found = source ? mentionAt(text, caret) : null;
    setMention(found);
    if (!found || !source || requestedRef.current.has(source.root)) return;
    const { root } = source;
    requestedRef.current.add(root);
    source
      .loadFiles()
      .catch(() => [] as string[])
      .then((files) => setListings((prev) => ({ ...prev, [root]: files })));
  };

  const listing = source ? listings[source.root] : undefined;
  const files = mention && listing ? matchFiles(listing, mention.query) : [];
  return { mention, files, update, close: () => setMention(null) };
}
