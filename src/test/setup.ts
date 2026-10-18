// Global test setup for Vitest (JSDOM environment mocks)

import { afterEach } from "vitest";
import { fakeProfiles } from "./fixtures/agents";

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
    agentOptions?: Record<string, unknown>;
  };
  transcripts: Record<string, unknown[]>;
}

/**
 * Default: a returning user who finished onboarding and has three recent
 * folders (newest first). Onboarding tests flip `onboardingCompleted` back.
 */
function emptyFakeStore(): FakeTauriStore {
  return {
    state: {
      version: 1,
      settings: { defaultAgentId: null, onboardingCompleted: true },
      recentFolders: [
        { name: "ai-perpetual-trading", path: "/Users/test/developer/ai-perpetual-trading", lastOpenedAt: 3000 },
        { name: "titan-investment", path: "/Users/test/developer/titan-investment", lastOpenedAt: 2000 },
        { name: "agent-desktop", path: "/Users/test/developer/agent-desktop", lastOpenedAt: 1000 },
      ],
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
    case "acp_start_session":
    case "acp_fork_session":
    case "acp_load_session":
      // Shaped like Qwen Code's real answer; it starts in YOLO like the user's own config.
      return Promise.resolve({
        acpSessionId:
          (args as { acpSessionId?: string })?.acpSessionId ?? `acp-${(args as { sessionId?: string })?.sessionId}`,
        agentCapabilities: { sessionCapabilities: { fork: {} } },
        modes: {
          currentModeId: "yolo",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "yolo", name: "YOLO" },
          ],
        },
        models: null,
        configOptions: [],
      });
    case "acp_set_config_option":
      return Promise.resolve([]);
    case "acp_prompt":
    case "acp_cancel":
    case "acp_respond_permission":
    case "acp_set_mode":
    case "acp_stop_session":
      return Promise.resolve(undefined);
    case "write_fork_handoff":
      return Promise.resolve(`/fake/app-data/handoffs/${(args as { handoffId?: string })?.handoffId}.md`);
    case "get_user_profile":
      return Promise.resolve({ name: "Test User", email: "test@example.com" });
    case "plugin:app|version":
      return Promise.resolve("0.1.0");
    case "list_directory":
      return Promise.resolve([]);
    case "open_path":
    case "remember_workspace":
    case "end_orphaned_sessions":
    case "open_external_url":
    case "open_session_window":
    case "reveal_in_finder":
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

/**
 * The fake Tauri backend every test runs against. A test that spies on
 * `invoke` and passes the other commands through calls this, never the
 * `invoke` it read before spying: that may already be a spy, and Vitest
 * hands back the same spy, so calling it would recurse.
 */
export function fakeTauriInvoke(cmd: string, args?: unknown): Promise<unknown> {
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
    return Promise.resolve(structuredClone(fakeProfiles));
  }
  if (cmd === "workspace_details") {
    return Promise.resolve({ location: "~/developer", branch: "main" });
  }
  return Promise.resolve(undefined);
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
      invoke: fakeTauriInvoke,
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
