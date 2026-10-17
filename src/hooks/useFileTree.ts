import { useCallback, useEffect, useRef, useState } from 'react';
import {
  errorMessage,
  listDirectory,
  ROOT_FOLDER,
  type ChildrenByFolder,
  type DirEntryInfo,
} from '../lib/files';
import { useLatest } from './useLatest';

type PathFlags = Readonly<Record<string, true>>;

interface TreeState {
  children: ChildrenByFolder;
  errors: Readonly<Record<string, string>>;
  loading: PathFlags;
  expanded: PathFlags;
}

export interface FileTree {
  /** Listings loaded so far, keyed by folder relative path (`""` is the root). */
  children: ChildrenByFolder;
  /** Load error per folder, shown inline under that folder. */
  errors: Readonly<Record<string, string>>;
  isLoading: (folder: string) => boolean;
  isExpanded: (folder: string) => boolean;
  /** Expands a folder (loading it on first expand) or collapses it. */
  toggleFolder: (folder: string) => void;
  /** Reloads the root and every expanded folder; other cached folders reload on expand. */
  refresh: () => void;
}

const EMPTY_STATE: TreeState = { children: {}, errors: {}, loading: {}, expanded: {} };

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

function startLoading(state: TreeState, folder: string): TreeState {
  return { ...state, loading: { ...state.loading, [folder]: true }, errors: without(state.errors, folder) };
}

function finishLoading(state: TreeState, folder: string, entries: DirEntryInfo[]): TreeState {
  return { ...state, loading: without(state.loading, folder), children: { ...state.children, [folder]: entries } };
}

function failLoading(state: TreeState, folder: string, message: string): TreeState {
  return {
    ...state,
    loading: without(state.loading, folder),
    children: without(state.children, folder),
    errors: { ...state.errors, [folder]: message },
  };
}

/** Lazily loaded folder tree of one workspace, backed by `list_directory`. */
export function useFileTree(rootPath: string): FileTree {
  const [state, setState] = useState<TreeState>(EMPTY_STATE);
  const stateRef = useLatest(state);
  // Bumped whenever the root changes or the tree refreshes, so a listing that
  // arrives late for an older generation cannot overwrite newer data.
  const generationRef = useRef(0);

  const loadFolder = useCallback(
    (folder: string, generation: number) => {
      setState((current) => startLoading(current, folder));
      listDirectory(rootPath, folder)
        .then((entries) => {
          if (generationRef.current !== generation) return;
          setState((current) => finishLoading(current, folder, entries));
        })
        .catch((error: unknown) => {
          if (generationRef.current !== generation) return;
          setState((current) => failLoading(current, folder, errorMessage(error)));
        });
    },
    [rootPath],
  );

  useEffect(() => {
    generationRef.current += 1;
    setState(EMPTY_STATE);
    loadFolder(ROOT_FOLDER, generationRef.current);
  }, [loadFolder]);

  const toggleFolder = useCallback(
    (folder: string) => {
      const current = stateRef.current;
      if (current.expanded[folder]) {
        setState((s) => ({ ...s, expanded: without(s.expanded, folder) }));
        return;
      }
      setState((s) => ({ ...s, expanded: { ...s.expanded, [folder]: true } }));
      const needsLoad = !current.children[folder] && !current.loading[folder];
      if (needsLoad) loadFolder(folder, generationRef.current);
    },
    [loadFolder, stateRef],
  );

  const refresh = useCallback(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const folders = [ROOT_FOLDER, ...Object.keys(stateRef.current.expanded)];
    // Keep what is on screen until the new listings arrive; drop the rest of
    // the cache so collapsed folders reload when they are next expanded.
    setState((s) => ({
      ...s,
      loading: {},
      children: Object.fromEntries(folders.flatMap((f) => (s.children[f] ? [[f, s.children[f]]] : []))),
    }));
    folders.forEach((folder) => loadFolder(folder, generation));
  }, [loadFolder, stateRef]);

  const isLoading = useCallback((folder: string) => Boolean(state.loading[folder]), [state.loading]);
  const isExpanded = useCallback((folder: string) => Boolean(state.expanded[folder]), [state.expanded]);

  return { children: state.children, errors: state.errors, isLoading, isExpanded, toggleFolder, refresh };
}
