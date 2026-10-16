// Global test setup for Vitest (JSDOM environment mocks)

import { afterEach } from "vitest";

/**
 * In-memory stand-in for the backend store commands. Tests seed it through
 * `window.__FAKE_TAURI_STORE__` and it is reset after every test.
 */
export interface FakeTauriStore {
  state: {
    version: number;
    settings: { defaultAgentId: string | null; onboardingCompleted: boolean };
    recentFolders: unknown[];
    sessions: unknown[];
  };
  transcripts: Record<string, unknown[]>;
}

function emptyFakeStore(): FakeTauriStore {
  return {
    state: {
      version: 1,
      settings: { defaultAgentId: null, onboardingCompleted: false },
      recentFolders: [],
      sessions: [],
    },
    transcripts: {},
  };
}

type StoreArgs = { state?: FakeTauriStore["state"]; sessionId?: string; messages?: unknown[] };

function handleStoreCommand(cmd: string, args: StoreArgs | undefined): Promise<unknown> | null {
  const store = (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__;
  switch (cmd) {
    case "load_app_state":
      return Promise.resolve(structuredClone(store.state));
    case "save_app_state":
      store.state = structuredClone(args?.state ?? store.state);
      return Promise.resolve(undefined);
    case "load_transcript":
      return Promise.resolve(structuredClone(store.transcripts[args?.sessionId ?? ""] ?? []));
    case "save_transcript":
      store.transcripts[args?.sessionId ?? ""] = structuredClone(args?.messages ?? []);
      return Promise.resolve(undefined);
    case "delete_transcript":
      delete store.transcripts[args?.sessionId ?? ""];
      return Promise.resolve(undefined);
    case "terminate_session":
    case "spawn_session":
    case "send_input":
    case "resize_session":
      return Promise.resolve(undefined);
    default:
      return null;
  }
}

if (typeof window !== "undefined") {
  (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__ = emptyFakeStore();
  afterEach(() => {
    (window as unknown as { __FAKE_TAURI_STORE__: FakeTauriStore }).__FAKE_TAURI_STORE__ = emptyFakeStore();
  });
}

if (typeof window !== "undefined") {
  // Provide mock for Tauri invoke and event system if not running in real Tauri webview
  let nextCallbackId = 1;
  const win = window as unknown as {
    __TAURI_INTERNALS__?: {
      invoke: (cmd: string, args?: unknown) => Promise<unknown>;
      transformCallback?: (callback: unknown, once?: boolean) => number;
      unregisterCallbackAction?: (id: number) => void;
    };
    __TAURI_EVENT_PLUGIN_INTERNALS__?: {
      unregisterListener: (event: string, eventId: number) => void;
    };
  };

  if (!win.__TAURI_INTERNALS__) {
    win.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: unknown) => {
        const storeResult = handleStoreCommand(cmd, args as StoreArgs | undefined);
        if (storeResult) {
          return storeResult;
        }
        if (cmd === "list_workspaces") {
          return Promise.resolve([
            { name: "ai-perpetual-trading", path: "/Users/test/developer/ai-perpetual-trading" },
            { name: "titan-investment", path: "/Users/test/developer/titan-investment" },
            { name: "agent-desktop", path: "/Users/test/developer/agent-desktop" },
          ]);
        }
        if (cmd === "get_agent_profiles") {
          return Promise.resolve([
            {
              id: "claude-code",
              name: "Claude Code",
              command: "claude",
              detected: true,
              detected_path: "/opt/homebrew/bin/claude",
              models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"],
              effort_levels: ["Low", "Medium", "High"],
            },
            {
              id: "omp",
              name: "Oh-My-Pi",
              command: "omp",
              detected: true,
              detected_path: "/usr/local/bin/omp",
              models: ["gemini-3.8-flash-tiered"],
              effort_levels: ["Low", "High"],
            },
            {
              id: "aider",
              name: "Aider",
              command: "aider",
              detected: false,
              models: ["gpt-5"],
              effort_levels: [],
            },
          ]);
        }
        return Promise.resolve(undefined);
      },
      transformCallback: (_cb: unknown, _once?: boolean) => nextCallbackId++,
      unregisterCallbackAction: (_id: number) => {},
    };
  }

  if (!win.__TAURI_EVENT_PLUGIN_INTERNALS__) {
    win.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (_event: string, _eventId: number) => {},
    };
  }

  window.requestAnimationFrame = (cb: FrameRequestCallback) =>
    setTimeout(cb, 0) as unknown as number;
  window.cancelAnimationFrame = (id: number) => clearTimeout(id);

  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;

  HTMLCanvasElement.prototype.getContext = (() => ({
    fillRect: () => {},
    clearRect: () => {},
    getImageData: () => ({ data: new Array(4) }),
    putImageData: () => {},
    createImageData: () => [],
    setTransform: () => {},
    drawImage: () => {},
    save: () => {},
    fillText: () => {},
    restore: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    closePath: () => {},
    stroke: () => {},
    translate: () => {},
    scale: () => {},
    rotate: () => {},
    arc: () => {},
    fill: () => {},
    measureText: () => ({ width: 10 }),
    transform: () => {},
    rect: () => {},
    clip: () => {},
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  if (typeof ResizeObserver === "undefined") {
    class MockResizeObserver {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe = () => {};
      unobserve = () => {};
      disconnect = () => {};
    }
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  }
}
