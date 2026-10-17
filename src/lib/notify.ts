import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { getAllWindows } from '@tauri-apps/api/window';

export interface AttentionNotice {
  title: string;
  body: string;
}

/** Whether any of the app's windows has focus: the main one, or a session popout. */
async function isAppFocused(): Promise<boolean> {
  if (document.hasFocus()) return true;
  const windows = await getAllWindows();
  const focused = await Promise.all(windows.map((window) => window.isFocused()));
  return focused.some(Boolean);
}

/**
 * Shows a system notification, but only while the user is away from the app:
 * when they are looking at any of its windows, the chat already shows what
 * happened. Asks for permission the first time.
 */
export async function notifyIfAway(notice: AttentionNotice): Promise<void> {
  if (await isAppFocused()) return;
  const isGranted = (await isPermissionGranted()) || (await requestPermission()) === 'granted';
  if (isGranted) sendNotification(notice);
}
