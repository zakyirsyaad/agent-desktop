/** The main window's label (`tauri.conf.json`); popouts send it their actions. */
export const MAIN_WINDOW_LABEL = 'main';

export type WindowMode = { kind: 'main' } | { kind: 'popout'; sessionId: string };

/** Same rule the backend uses for ids that end up in window labels and file names. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Popout windows are opened as `index.html?session=<id>&popout=1`. Anything
 * else, including an id that fails validation, is the main window.
 */
export function readWindowMode(search: string): WindowMode {
  const params = new URLSearchParams(search);
  const sessionId = params.get('session');
  if (params.get('popout') === '1' && sessionId && SESSION_ID_PATTERN.test(sessionId)) {
    return { kind: 'popout', sessionId };
  }
  return { kind: 'main' };
}
