import { useEffect, useState } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useLatest } from './useLatest';

/**
 * Files dragged onto the window from Finder: `onDrop` gets their paths, and
 * the result says whether files are being dragged over it right now. The
 * webview's own event is used because a DOM drop carries no file paths.
 */
export function useFileDrop(onDrop: (paths: string[]) => void, onError: (message: string) => void): boolean {
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const onDropRef = useLatest(onDrop);
  const onErrorRef = useLatest(onError);

  useEffect(() => {
    let webview: ReturnType<typeof getCurrentWebview>;
    try {
      webview = getCurrentWebview();
    } catch {
      // Outside the app's own window (a plain browser, a test) there is nothing to listen to.
      return;
    }
    let isCancelled = false;
    let unlisten: (() => void) | undefined;
    webview
      .onDragDropEvent((event) => {
        const drag = event.payload;
        if (drag.type === 'enter') setIsDraggingFiles(true);
        else if (drag.type === 'leave') setIsDraggingFiles(false);
        else if (drag.type === 'drop') {
          setIsDraggingFiles(false);
          if (drag.paths.length > 0) onDropRef.current(drag.paths);
        }
      })
      .then((stop) => {
        if (isCancelled) stop();
        else unlisten = stop;
      })
      .catch((error) => onErrorRef.current(`Dropping files into the window will not work: ${String(error)}`));
    return () => {
      isCancelled = true;
      unlisten?.();
    };
  }, [onDropRef, onErrorRef]);

  return isDraggingFiles;
}
