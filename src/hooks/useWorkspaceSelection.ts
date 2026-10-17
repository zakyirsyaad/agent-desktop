import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PersistedState, Workspace } from '../types';
import { addRecentFolder, removeRecentFolder } from '../lib/recent-folders';
import { pickFolder } from '../lib/file-picker';
import { useLatest } from './useLatest';

export interface WorkspaceSelection {
  /** Recently opened folders, most recent first. */
  workspaces: Workspace[];
  activeWorkspacePath: string | undefined;
  activeWorkspace: Workspace | undefined;
  selectWorkspace: (path: string) => void;
  /** Adds a folder to the recents (or bumps it) and makes it active. */
  rememberFolder: (folder: Workspace) => void;
  /** Opens the native folder dialog; resolves with the folder or null if cancelled. */
  openFolder: () => Promise<Workspace | null>;
  removeFolder: (path: string) => void;
}

type UpdateState = (updater: (prev: PersistedState) => PersistedState) => void;

/** The project folders the user works in, backed by `recentFolders` in the store. */
export function useWorkspaceSelection(
  state: PersistedState,
  isLoaded: boolean,
  updateState: UpdateState,
  onError: (message: string) => void,
): WorkspaceSelection {
  const [activeWorkspacePath, setActiveWorkspacePath] = useState<string | undefined>();
  const onErrorRef = useLatest(onError);
  // The folder the user chose last: a folder still being registered becomes
  // active only if nothing was chosen after it.
  const latestChoiceRef = useRef<string | undefined>(undefined);

  const selectWorkspace = useCallback((path: string) => {
    latestChoiceRef.current = path;
    setActiveWorkspacePath(path);
  }, []);

  const workspaces = [...state.recentFolders]
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .map(({ name, path }) => ({ name, path }));

  // After loading, start in the most recently opened folder.
  useEffect(() => {
    if (!isLoaded) return;
    setActiveWorkspacePath((current) => current ?? workspaces[0]?.path);
    // Only on the load transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded]);

  const rememberFolder = useCallback(
    (folder: Workspace) => {
      latestChoiceRef.current = folder.path;
      updateState((prev) => ({
        ...prev,
        recentFolders: addRecentFolder(prev.recentFolders, folder, Date.now()),
      }));
      // The backend only reads known workspaces (files, branch), and the state
      // save that also records this one is debounced: register it first, so
      // nothing reads it before the backend knows it.
      invoke('remember_workspace', { path: folder.path })
        .catch((error) => {
          onErrorRef.current(`Could not register the folder: ${String(error)}`);
        })
        .finally(() => {
          if (latestChoiceRef.current === folder.path) setActiveWorkspacePath(folder.path);
        });
    },
    [updateState, onErrorRef],
  );

  const openFolder = useCallback(async () => {
    try {
      const folder = await pickFolder();
      if (folder) rememberFolder(folder);
      return folder;
    } catch (error) {
      onErrorRef.current(`Could not open the folder dialog: ${String(error)}`);
      return null;
    }
  }, [rememberFolder, onErrorRef]);

  const removeFolder = useCallback(
    (path: string) => {
      updateState((prev) => ({ ...prev, recentFolders: removeRecentFolder(prev.recentFolders, path) }));
      setActiveWorkspacePath((current) => (current === path ? undefined : current));
    },
    [updateState],
  );

  return {
    workspaces,
    activeWorkspacePath,
    activeWorkspace: workspaces.find((ws) => ws.path === activeWorkspacePath),
    selectWorkspace,
    rememberFolder,
    openFolder,
    removeFolder,
  };
}
