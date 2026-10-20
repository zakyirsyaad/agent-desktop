/**
 * The registry's agent icons, kept for the app's lifetime so every logo shares one fetch.
 * Icons are monochrome `currentColor` SVGs as data URLs; they are only ever used as a CSS mask.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

let icons: Readonly<Record<string, string>> = {};
let requested = false;
/** Counts loads, so an older load that answers late never replaces a newer one's icons. */
let latestLoad = 0;
let changeListener: Promise<UnlistenFn> | null = null;
const subscribers = new Set<() => void>();

export function agentIconOf(id: string): string | undefined {
  return icons[id];
}

export function subscribeToAgentIcons(onChange: () => void): () => void {
  subscribers.add(onChange);
  return () => {
    subscribers.delete(onChange);
  };
}

function ensureChangeListener(): void {
  changeListener ??= listen('agent-profiles-changed', () => void loadAgentIcons()).catch(() => {
    changeListener = null;
    return () => {};
  });
}

/** Fetches the icons and reloads them whenever the backend says the agents changed. */
export async function loadAgentIcons(): Promise<void> {
  requested = true;
  ensureChangeListener();
  const load = ++latestLoad;
  try {
    const next = await invoke<Record<string, string>>('get_agent_icons');
    if (load !== latestLoad) return;
    icons = next;
    subscribers.forEach((notify) => notify());
  } catch {
    // Without icons the logos stay generic; the next change event tries again.
  }
}

/** An agent's registry icon as a data URL, or undefined while there is none. */
export function useAgentIcon(id: string): string | undefined {
  useEffect(() => {
    if (!requested) void loadAgentIcons();
  }, []);
  return useSyncExternalStore(subscribeToAgentIcons, () => agentIconOf(id));
}

/** Tests only: forgets the icons and the listener, so each test starts clean. */
export function resetAgentIcons(): void {
  const listener = changeListener;
  changeListener = null;
  void listener?.then((stop) => stop());
  icons = {};
  requested = false;
  latestLoad += 1;
  subscribers.forEach((notify) => notify());
}
