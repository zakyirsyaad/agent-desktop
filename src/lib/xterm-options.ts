import type { ITerminalOptions } from '@xterm/xterm';

/** The app's terminal look, shared by the main terminal view and the drawer. */
export const XTERM_OPTIONS: ITerminalOptions = {
  cursorBlink: true,
  cursorStyle: 'bar',
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  theme: {
    background: '#000000',
    foreground: '#f5f5f5',
    cursor: '#f59e0b',
    selectionBackground: 'rgba(245, 158, 11, 0.3)',
    black: '#1e1e1e',
    red: '#ef4444',
    green: '#10b981',
    yellow: '#f59e0b',
    blue: '#3b82f6',
    magenta: '#ec4899',
    cyan: '#06b6d4',
    white: '#e5e5e5',
    brightBlack: '#4b5563',
    brightRed: '#f87171',
    brightGreen: '#34d399',
    brightYellow: '#fbbf24',
    brightBlue: '#60a5fa',
    brightMagenta: '#f472b6',
    brightCyan: '#22d3ee',
    brightWhite: '#ffffff',
  },
  scrollback: 5000,
  convertEol: true,
};
