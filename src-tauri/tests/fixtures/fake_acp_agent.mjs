// A tiny ACP agent for integration tests. It speaks newline-delimited
// JSON-RPC on stdin/stdout and reacts to a few magic prompts:
//   "permission" -> asks the client for permission, then reports the choice
//   "slow"       -> waits until the client sends session/cancel
//   "crash"      -> exits with code 3 mid-turn
//   anything else -> echoes the text back as an agent message chunk
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
  say(params.sessionId, `echo: ${text}`);
  reply(id, { stopReason: "end_turn" });
}

const handlers = {
  initialize: (id) =>
    reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: false, sessionCapabilities: { fork: {} } } }),
  "session/new": (id) =>
    reply(id, {
      sessionId: `fake-${nextSession++}`,
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "yolo", name: "YOLO" },
        ],
      },
    }),
  "session/fork": (id) => reply(id, { sessionId: `fake-${nextSession++}` }),
  "session/prompt": handlePrompt,
  "session/set_mode": (id, params) => {
    update(params.sessionId, { sessionUpdate: "current_mode_update", currentModeId: params.modeId });
    reply(id, {});
  },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
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
