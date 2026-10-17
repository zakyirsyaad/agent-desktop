import { useState } from 'react';
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
  const [listing, setListing] = useState<{ root: string; files: string[] } | null>(null);
  const [loadingRoot, setLoadingRoot] = useState<string | null>(null);

  const update = (text: string, caret: number) => {
    const found = source ? mentionAt(text, caret) : null;
    setMention(found);
    if (!found || !source || listing?.root === source.root || loadingRoot === source.root) return;
    const { root } = source;
    setLoadingRoot(root);
    source
      .loadFiles()
      .catch(() => [] as string[])
      .then((files) => {
        setListing({ root, files });
        setLoadingRoot((current) => (current === root ? null : current));
      });
  };

  const isCurrent = source !== undefined && listing?.root === source.root;
  const files = mention && isCurrent ? matchFiles(listing.files, mention.query) : [];
  return { mention, files, update, close: () => setMention(null) };
}
