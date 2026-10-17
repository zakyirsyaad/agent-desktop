import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

export interface AttentionNotice {
  title: string;
  body: string;
}

/**
 * Shows a system notification, but only while the user is away from the app:
 * when they are looking at it, the chat already shows what happened. Asks for
 * permission the first time.
 */
export async function notifyIfAway(notice: AttentionNotice): Promise<void> {
  if (document.hasFocus()) return;
  const isGranted = (await isPermissionGranted()) || (await requestPermission()) === 'granted';
  if (isGranted) sendNotification(notice);
}
