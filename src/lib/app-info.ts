import { getVersion } from '@tauri-apps/api/app';

/**
 * The bundled app version, or null when it cannot be read.
 *
 * `getVersion()` goes through the Tauri IPC bridge, which does not exist in a
 * plain browser or in the jsdom test environment, so it rejects there. Callers
 * show the version line only when one came back instead of failing to render.
 */
export async function getAppVersion(): Promise<string | null> {
  try {
    return await getVersion();
  } catch {
    return null;
  }
}
