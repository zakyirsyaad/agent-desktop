// A tiny ACP agent for integration tests. It speaks newline-delimited
// JSON-RPC on stdin/stdout and reacts to a few magic prompts:
//   "permission" -> asks the client for permission, then reports the choice
//   "slow"       -> waits until the client sends session/cancel
//   "crash"      -> exits with code 3 mid-turn
//   "needs-login" -> refuses the prompt until the user signs in
//   "stray-permission" -> asks permission for a session that does not exist, reports the answer
//   --login      -> the terminal sign-in: prints a greeting and exits
//   anything else -> echoes the text back as an agent message chunk
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

let nextSession = 1;
let pendingPermission = null;
let pendingSlow = null;
let pendingStray = null;
// Replies to the requests sent while a session/new waits, by request id.
let earlyRequests = null;

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const reply = (id, result) => send({ id, result });
const update = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
const say = (sessionId, text) =>
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

function handlePrompt(id, params) {
  const text = params.prompt.map((block) => block.text ?? "").join("");
  if (text === "permission") {
    pendingPermission = { promptId: id, sessionId: params.sessionId };
    send({
      id: "perm-1",
      method: "session/request_permission",
      params: {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "t-1", title: "Run rm -rf build", kind: "execute", status: "pending" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    return;
  }
  if (text === "slow") {
    pendingSlow = { promptId: id };
    return;
  }
  if (text === "stray-permission") {
    pendingStray = { promptId: id, sessionId: params.sessionId };
    send({ id: "stray", method: "session/request_permission", params: permissionFor("nobody") });
    return;
  }
  if (text === "crash") process.exit(3);
  if (text === "needs-login") {
    send({ id, error: { code: -32000, message: "Authentication required" } });
    return;
  }
  say(params.sessionId, `echo: ${text}`);
  reply(id, { stopReason: "end_turn" });
}

const permissionFor = (sessionId) => ({
  sessionId,
  toolCall: { toolCallId: "t-0", title: "Warm up", kind: "execute", status: "pending" },
  options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
});

// FAKE_ACP_ASK_AFTER_OPEN: asks permission for a session right after opening it.
const askAfterOpen = (sessionId) => {
  if (process.env.FAKE_ACP_ASK_AFTER_OPEN) {
    send({ id: `after-open-${sessionId}`, method: "session/request_permission", params: permissionFor(sessionId) });
  }
};

const handlers = {
  initialize: (id, params) => {
    // FAKE_ACP_SLOW_INIT: answers initialize only after ten seconds.
    if (process.env.FAKE_ACP_SLOW_INIT && !params?.slowInitDone) {
      setTimeout(() => handlers.initialize(id, { ...params, slowInitDone: true }), 10000);
      return;
    }
    // FAKE_ACP_AUTH_STATUS: pushes who is signed in, like Claude Code's adapter.
    const authStatus = process.env.FAKE_ACP_AUTH_STATUS;
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: !process.env.FAKE_ACP_NO_LOAD,
        // FAKE_ACP_NO_FORK: cannot fork a session.
        sessionCapabilities: process.env.FAKE_ACP_NO_FORK ? { delete: {} } : { fork: {}, delete: {} },
        ...(authStatus ? { _meta: { authStatus: {} } } : {}),
      },
      authMethods: [
        { id: "browser", name: "Sign in with a browser" },
        { id: "api-key", name: "API key", description: "Set FAKE_API_KEY" },
        ...(params?.clientCapabilities?.auth?.terminal === true
          ? [
              {
                id: "terminal-login",
                name: "Sign in in a terminal",
                type: "terminal",
                args: ["--login"],
                // FAKE_ACP_BAD_TERMINAL_ENV: a variable Zorvo must refuse to pass on.
                env: process.env.FAKE_ACP_BAD_TERMINAL_ENV ? { PATH: "/tmp" } : { FAKE_LOGIN_GREETING: "hello" },
              },
            ]
          : []),
      ],
    });
    // "silent" advertises the extension but never says who is signed in, as an agent that cannot tell.
    if (authStatus && authStatus !== "silent") {
      send({ method: "_auth/status_update", params: { authStatus: { kind: authStatus } } });
    }
  },
  authenticate: (id, params) =>
    params.methodId === "browser"
      ? reply(id, {})
      : send({ id, error: { code: -32602, message: `Unknown auth method ${params.methodId}` } }),
  // Like real agents, replays the old conversation before answering.
  "session/load": (id, params) => {
    if (process.env.FAKE_ACP_EARLY_REQUESTS && !params.earlyDone) {
      askBeforeTheSessionExists("session/load", id, params);
      return;
    }
    say(params.sessionId, "replayed history");
    reply(id, {
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "yolo", name: "YOLO" },
        ],
      },
    });
  },
  "session/new": (id, params) => {
    // FAKE_ACP_EARLY_REQUESTS: asks the client things before the session exists and answers
    // session/new (or session/load) only once both are answered, or with an error after
    // twenty seconds. Each reply goes to the file FAKE_ACP_EARLY_REQUESTS names, one JSON
    // line per reply.
    if (process.env.FAKE_ACP_EARLY_REQUESTS && !params?.earlyDone) {
      askBeforeTheSessionExists("session/new", id, params);
      return;
    }
    if (process.env.FAKE_ACP_STDERR) process.stderr.write("warming up the model cache\n");
    if (process.env.FAKE_ACP_SERVER_ERROR) {
      send({ id, error: { code: -32000, message: "Internal error: disk full" } });
      return;
    }
    if (process.env.FAKE_ACP_AUTH_REQUIRED) {
      send({ id, error: { code: -32000, message: process.env.FAKE_ACP_AUTH_MESSAGE ?? "Authentication required" } });
      return;
    }
    const sessionId = `fake-${nextSession++}`;
    reply(id, {
      sessionId,
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "yolo", name: "YOLO" },
        ],
      },
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "fast",
          options: [
            { value: "fast", name: "Fast" },
            { value: "smart", name: "Smart" },
          ],
        },
      ],
    });
    askAfterOpen(sessionId);
    // Like real agents, lists its slash commands just after the session opens.
    if (!process.env.FAKE_ACP_NO_COMMANDS) update(sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "review", description: "Review the changes" }],
    });
  },
  // FAKE_ACP_SLOW_DELETE: takes three seconds to delete a session.
  "session/delete": (id) => setTimeout(() => reply(id, {}), process.env.FAKE_ACP_SLOW_DELETE ? 3000 : 0),
  "session/fork": (id) => {
    const sessionId = `fake-${nextSession++}`;
    reply(id, { sessionId });
    askAfterOpen(sessionId);
  },
  "session/prompt": handlePrompt,
  "session/set_mode": (id, params) => {
    update(params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: params.modeId });
    reply(id, {});
  },
};

function askBeforeTheSessionExists(method, id, params) {
  const timer = setTimeout(() => {
    earlyRequests = null;
    send({ id, error: { code: -32603, message: "The client never answered early requests" } });
  }, 20000);
  earlyRequests = {
    waiting: new Set(["early-fs", "early-permission"]),
    done: () => {
      clearTimeout(timer);
      earlyRequests = null;
      handlers[method](id, { ...params, earlyDone: true });
    },
  };
  send({ id: "early-fs", method: "fs/read_text_file", params: { sessionId: "not-yet", path: "/etc/hosts" } });
  send({ id: "early-permission", method: "session/request_permission", params: permissionFor("not-yet") });
}

// Started as the terminal login (--login): print a greeting and exit, FAKE_LOGIN_EXIT is the exit code.
if (process.argv.includes("--login")) {
  process.stdout.write(`signed in: ${process.env.FAKE_LOGIN_GREETING ?? ""}\n`);
  process.exit(Number(process.env.FAKE_LOGIN_EXIT ?? 0));
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  // FAKE_ACP_METHOD_LOG: records each method the client called, one per line.
  if (process.env.FAKE_ACP_METHOD_LOG && message.method) appendFileSync(process.env.FAKE_ACP_METHOD_LOG, `${message.method}\n`);
  if (message.method === "session/cancel" && pendingSlow) {
    reply(pendingSlow.promptId, { stopReason: "cancelled" });
    pendingSlow = null;
    return;
  }
  if (earlyRequests?.waiting.has(message.id) && message.method === undefined) {
    appendFileSync(process.env.FAKE_ACP_EARLY_REQUESTS, `${JSON.stringify(message)}\n`);
    earlyRequests.waiting.delete(message.id);
    if (earlyRequests.waiting.size === 0) earlyRequests.done();
    return;
  }
  if (message.id === "stray" && pendingStray) {
    const outcome = message.result?.outcome?.outcome ?? `error ${message.error?.code}`;
    say(pendingStray.sessionId, `stray:${outcome}`);
    reply(pendingStray.promptId, { stopReason: "end_turn" });
    pendingStray = null;
    return;
  }
  if (message.id === "perm-1" && pendingPermission) {
    const outcome = message.result.outcome;
    say(pendingPermission.sessionId, `allowed:${outcome.optionId ?? outcome.outcome}`);
    reply(pendingPermission.promptId, { stopReason: "end_turn" });
    pendingPermission = null;
    return;
  }
  // A reply to a request with nothing waiting on it (an after-open permission).
  if (message.method === undefined) return;
  const handler = handlers[message.method];
  if (handler) handler(message.id, message.params);
  else if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
