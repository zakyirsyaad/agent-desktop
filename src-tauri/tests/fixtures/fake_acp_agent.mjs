// A tiny ACP agent for integration tests. It speaks newline-delimited
// JSON-RPC on stdin/stdout and reacts to a few magic prompts:
//   "permission" -> asks the client for permission, then reports the choice
//   "slow"       -> waits until the client sends session/cancel
//   "crash"      -> exits with code 3 mid-turn
//   "needs-login" -> refuses the prompt until the user signs in
//   anything else -> echoes the text back as an agent message chunk
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

let nextSession = 1;
let pendingPermission = null;
let pendingSlow = null;

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
  if (text === "crash") process.exit(3);
  if (text === "needs-login") {
    send({ id, error: { code: -32000, message: "Authentication required" } });
    return;
  }
  say(params.sessionId, `echo: ${text}`);
  reply(id, { stopReason: "end_turn" });
}

const handlers = {
  initialize: (id) => {
    // FAKE_ACP_AUTH_STATUS: pushes who is signed in, like Claude Code's adapter.
    const authStatus = process.env.FAKE_ACP_AUTH_STATUS;
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: !process.env.FAKE_ACP_NO_LOAD,
        sessionCapabilities: { fork: {}, delete: {} },
        ...(authStatus ? { _meta: { authStatus: {} } } : {}),
      },
      authMethods: [
        { id: "browser", name: "Sign in with a browser" },
        { id: "api-key", name: "API key", description: "Set FAKE_API_KEY" },
      ],
    });
    if (authStatus) send({ method: "_auth/status_update", params: { authStatus: { kind: authStatus } } });
  },
  authenticate: (id, params) =>
    params.methodId === "browser"
      ? reply(id, {})
      : send({ id, error: { code: -32602, message: `Unknown auth method ${params.methodId}` } }),
  // Like real agents, replays the old conversation before answering.
  "session/load": (id, params) => {
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
  "session/new": (id) => {
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
    // Like real agents, lists its slash commands just after the session opens.
    if (!process.env.FAKE_ACP_NO_COMMANDS) update(sessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "review", description: "Review the changes" }],
    });
  },
  "session/delete": (id) => reply(id, {}),
  "session/fork": (id) => reply(id, { sessionId: `fake-${nextSession++}` }),
  "session/prompt": handlePrompt,
  "session/set_mode": (id, params) => {
    update(params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: params.modeId });
    reply(id, {});
  },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  // FAKE_ACP_METHOD_LOG: records each method the client called, one per line.
  if (process.env.FAKE_ACP_METHOD_LOG && message.method) appendFileSync(process.env.FAKE_ACP_METHOD_LOG, `${message.method}\n`);
  if (message.method === "session/cancel" && pendingSlow) {
    reply(pendingSlow.promptId, { stopReason: "cancelled" });
    pendingSlow = null;
    return;
  }
  if (message.id === "perm-1" && pendingPermission) {
    const outcome = message.result.outcome;
    say(pendingPermission.sessionId, `allowed:${outcome.optionId ?? outcome.outcome}`);
    reply(pendingPermission.promptId, { stopReason: "end_turn" });
    pendingPermission = null;
    return;
  }
  const handler = handlers[message.method];
  if (handler) handler(message.id, message.params);
  else if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
