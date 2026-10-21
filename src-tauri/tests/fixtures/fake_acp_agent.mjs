// A tiny ACP agent for integration tests. It speaks newline-delimited
// JSON-RPC on stdin/stdout and reacts to a few magic prompts:
//   "permission" -> asks the client for permission, then reports the choice
//   "slow"       -> waits until the client sends session/cancel
//   "crash"      -> exits with code 3 mid-turn
//   "needs-login" -> refuses the prompt until the user signs in
//   "stray-permission" -> asks permission for a session that does not exist, reports the answer
//   "elicit-form" -> asks for a name (at most five characters) through a form
//   "elicit-url"  -> asks the user to open https://agent.example.com/connect (elicitationId "gh-1")
//   "elicit-voice" -> asks in a mode no client knows
//   "elicit-twice" -> asks for two forms at once, "elic-1" and "elic-2"
//   "elicit-blocked-url" -> asks the user to open http://agent.example.com/connect, which Zorvo blocks
//   "stray-elicit" -> asks for a form for session "nope", which does not exist
//     (each elicit-* prompt says "elicited:<reply as JSON>" per reply, then ends the turn;
//     FAKE_ACP_ELICIT_LOG names a file each reply is appended to, as one JSON line)
//   "elicit-complete" -> sends elicitation/complete for "gh-1" and "nope", then says "completed-sent"
//   "elicit-url-done-on-accept" -> as "elicit-url", but sends elicitation/complete for "gh-1"
//     the moment the accept arrives, before anything else
//   "elicit-url-deaf" -> closes its stdin, then asks as "elicit-url", so no answer can reach it
//   --login      -> the terminal sign-in: prints a greeting and exits
//   anything else -> echoes the text back as an agent message chunk
// Environment flags add capabilities and record what it was called with:
//   FAKE_ACP_RESUME   -> advertises sessionCapabilities.resume and answers session/resume
//   FAKE_ACP_LIST     -> advertises sessionCapabilities.list and answers session/list
//   FAKE_ACP_LIST_PAGES -> names a JSON file of pages (arrays of SessionInfo); without it
//                         session/list answers no sessions
//   FAKE_ACP_LIST_FAIL_AT=<n> -> page n answers with a server error
//   FAKE_ACP_AUTH_REQUIRED -> session/new and session/list refuse with an auth-required error
//   FAKE_ACP_CALL_LOG -> appends every received method name to the file it names
//   FAKE_ACP_SLOW_INIT=<ms> -> answers initialize only after that many milliseconds
//                         (ten seconds when set without a delay)
//   FAKE_ACP_SLOW_REPLAY -> session/load sends another chunk three seconds later, then answers
// (each other FAKE_ACP_* flag is documented where it is read below)
import { appendFileSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

let nextSession = 1;
let pendingPermission = null;
let pendingSlow = null;
let pendingStray = null;
// The elicit-* prompt waiting on its elicitation/create replies.
let pendingElicit = null;
// The session/new waiting on its FAKE_ACP_ELICIT_ON_NEW form.
let elicitOnNew = null;
// Replies to the requests sent while a session/new waits, by request id.
let earlyRequests = null;

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const reply = (id, result) => send({ id, result });
const update = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
const say = (sessionId, text) =>
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

// The modes every answer that opens a session reports.
const defaultModes = () => ({
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default" },
    { id: "yolo", name: "YOLO" },
  ],
});

const nameForm = (target) => ({
  ...target,
  mode: "form",
  message: "What should I call you?",
  requestedSchema: { type: "object", properties: { name: { type: "string", maxLength: 5 } }, required: ["name"] },
});

const elicitations = {
  "elicit-form": (sessionId) => [nameForm({ sessionId })],
  "elicit-url": (sessionId) => [
    { sessionId, mode: "url", message: "Connect your account", elicitationId: "gh-1", url: "https://agent.example.com/connect" },
  ],
  "elicit-voice": (sessionId) => [{ sessionId, mode: "voice", message: "Say something" }],
  "elicit-twice": (sessionId) => [nameForm({ sessionId }), nameForm({ sessionId })],
  "elicit-blocked-url": (sessionId) => [
    { sessionId, mode: "url", message: "Connect your account", elicitationId: "gh-2", url: "http://agent.example.com/connect" },
  ],
  "stray-elicit": () => [nameForm({ sessionId: "nope" })],
};

// Sends each request as elicitation/create with ids "elic-1", "elic-2", ...
// `doneOnAccept` is the elicitationId to complete as soon as an accept arrives.
function elicit(promptId, sessionId, requests, doneOnAccept = null) {
  pendingElicit = { promptId, sessionId, doneOnAccept, waiting: new Set(requests.map((_, i) => `elic-${i + 1}`)) };
  requests.forEach((params, i) => send({ id: `elic-${i + 1}`, method: "elicitation/create", params }));
}

function handlePrompt(id, params) {
  const text = params.prompt.map((block) => block.text ?? "").join("");
  if (elicitations[text]) {
    elicit(id, params.sessionId, elicitations[text](params.sessionId));
    return;
  }
  if (text === "elicit-url-done-on-accept") {
    elicit(id, params.sessionId, elicitations["elicit-url"](params.sessionId), "gh-1");
    return;
  }
  if (text === "elicit-url-deaf") {
    // Close the pipe itself, not only Node's stream, before asking, so the client's answer fails.
    process.stdin.destroy();
    try {
      closeSync(0);
    } catch {
      // Already closed by the stream.
    }
    elicit(id, params.sessionId, elicitations["elicit-url"](params.sessionId));
    return;
  }
  if (text === "elicit-complete") {
    send({ method: "elicitation/complete", params: { elicitationId: "gh-1" } });
    send({ method: "elicitation/complete", params: { elicitationId: "nope" } });
    say(params.sessionId, "completed-sent");
    reply(id, { stopReason: "end_turn" });
    return;
  }
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
    // FAKE_ACP_SLOW_INIT: answers initialize only after the delay it names, so a
    // test can stop a session while it opens. A bare set keeps the ten seconds.
    const delay = Number(process.env.FAKE_ACP_SLOW_INIT);
    if (process.env.FAKE_ACP_SLOW_INIT && !params?.slowInitDone) {
      setTimeout(
        () => handlers.initialize(id, { ...params, slowInitDone: true }),
        delay > 1 ? delay : 10000,
      );
      return;
    }
    // FAKE_ACP_INIT_LOG: writes the client's capabilities to the file it names, as JSON.
    if (process.env.FAKE_ACP_INIT_LOG) writeFileSync(process.env.FAKE_ACP_INIT_LOG, JSON.stringify(params?.clientCapabilities));
    // FAKE_ACP_AUTH_STATUS: pushes who is signed in, like Claude Code's adapter.
    const authStatus = process.env.FAKE_ACP_AUTH_STATUS;
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: !process.env.FAKE_ACP_NO_LOAD,
        sessionCapabilities: {
          // FAKE_ACP_NO_FORK: cannot fork a session.
          ...(process.env.FAKE_ACP_NO_FORK ? {} : { fork: {} }),
          delete: {},
          // FAKE_ACP_RESUME: reopens a session without replaying its history.
          ...(process.env.FAKE_ACP_RESUME ? { resume: {} } : {}),
          // FAKE_ACP_LIST: lists its sessions for a folder.
          ...(process.env.FAKE_ACP_LIST ? { list: {} } : {}),
        },
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
    update(params.sessionId, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "earlier question" },
    });
    say(params.sessionId, "replayed history");
    // FAKE_ACP_SLOW_REPLAY: lets a test stop the import in the middle of the replay.
    if (process.env.FAKE_ACP_SLOW_REPLAY) {
      setTimeout(() => {
        say(params.sessionId, "late history");
        reply(id, { modes: defaultModes() });
      }, 3000);
      return;
    }
    reply(id, { modes: defaultModes() });
  },
  // FAKE_ACP_RESUME: reopens the session and answers without replaying anything.
  "session/resume": (id) => reply(id, { modes: defaultModes() }),
  // FAKE_ACP_LIST_PAGES: serves the pages from the JSON file it names. A missing
  // cursor serves page 0 and "page-<n>" serves page n; the answer names the next
  // page while one remains. Any other cursor is refused as invalid. Without the
  // file there are no sessions.
  "session/list": (id, params) => {
    // Unlike session/new, listing is refused even when signed out.
    if (process.env.FAKE_ACP_AUTH_REQUIRED) {
      send({ id, error: { code: -32000, message: process.env.FAKE_ACP_AUTH_MESSAGE ?? "Authentication required" } });
      return;
    }
    const pages = process.env.FAKE_ACP_LIST_PAGES
      ? JSON.parse(readFileSync(process.env.FAKE_ACP_LIST_PAGES, "utf8"))
      : [];
    const cursor = params?.cursor;
    let page = 0;
    if (cursor === undefined) {
      if (pages.length === 0) {
        reply(id, { sessions: [] });
        return;
      }
    } else {
      const match = /^page-(\d+)$/.exec(String(cursor));
      page = match ? Number(match[1]) : -1;
      if (page < 0 || page >= pages.length) {
        send({ id, error: { code: -32602, message: `Unknown cursor ${cursor}` } });
        return;
      }
    }
    if (process.env.FAKE_ACP_LIST_FAIL_AT === String(page)) {
      send({ id, error: { code: -32603, message: `Page ${page} could not be listed` } });
      return;
    }
    reply(id, {
      sessions: pages[page],
      ...(page + 1 < pages.length ? { nextCursor: `page-${page + 1}` } : {}),
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
    // FAKE_ACP_ELICIT_ON_NEW: asks for a form (by requestId) before the session exists and
    // answers session/new only once the client replies, or with an error after three
    // seconds. The reply goes to the file FAKE_ACP_ELICIT_ON_NEW names, as one JSON line.
    if (process.env.FAKE_ACP_ELICIT_ON_NEW && !params?.elicitDone) {
      elicitBeforeTheSessionExists(id, params);
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
      modes: defaultModes(),
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

function elicitBeforeTheSessionExists(id, params) {
  const timer = setTimeout(() => {
    elicitOnNew = null;
    send({ id, error: { code: -32603, message: "The client never answered the form" } });
  }, 3000);
  elicitOnNew = (answer) => {
    clearTimeout(timer);
    elicitOnNew = null;
    appendFileSync(process.env.FAKE_ACP_ELICIT_ON_NEW, `${JSON.stringify(answer)}\n`);
    handlers["session/new"](id, { ...params, elicitDone: true });
  };
  send({ id: "elic-new", method: "elicitation/create", params: nameForm({ requestId: id }) });
}

// Started as the terminal login (--login): print a greeting and exit, FAKE_LOGIN_EXIT is the exit code.
if (process.argv.includes("--login")) {
  process.stdout.write(`signed in: ${process.env.FAKE_LOGIN_GREETING ?? ""}\n`);
  process.exit(Number(process.env.FAKE_LOGIN_EXIT ?? 0));
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  // FAKE_ACP_ARRIVAL_LOG: records every method called and every reply, in the order they arrive.
  if (process.env.FAKE_ACP_ARRIVAL_LOG) {
    const entry = message.method ?? `reply ${message.id} ${JSON.stringify(message.result ?? message.error)}`;
    appendFileSync(process.env.FAKE_ACP_ARRIVAL_LOG, `${entry}\n`);
  }
  // FAKE_ACP_METHOD_LOG and FAKE_ACP_CALL_LOG each name a file every method the
  // client called is appended to, one per line. FAKE_ACP_CALL_LOG is what a test
  // reads to tell session/resume from a session/load whose replay was dropped.
  if (message.method) {
    for (const key of ["FAKE_ACP_METHOD_LOG", "FAKE_ACP_CALL_LOG"]) {
      const path = process.env[key];
      if (path) appendFileSync(path, `${message.method}\n`);
    }
  }
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
  if (message.id === "elic-new" && elicitOnNew && message.method === undefined) {
    elicitOnNew(message);
    return;
  }
  if (pendingElicit?.waiting.has(message.id) && message.method === undefined) {
    if (pendingElicit.doneOnAccept && message.result?.action === "accept") {
      send({ method: "elicitation/complete", params: { elicitationId: pendingElicit.doneOnAccept } });
    }
    if (process.env.FAKE_ACP_ELICIT_LOG) appendFileSync(process.env.FAKE_ACP_ELICIT_LOG, `${JSON.stringify(message)}\n`);
    say(pendingElicit.sessionId, `elicited:${JSON.stringify(message.result ?? message.error)}`);
    pendingElicit.waiting.delete(message.id);
    if (pendingElicit.waiting.size === 0) {
      reply(pendingElicit.promptId, { stopReason: "end_turn" });
      pendingElicit = null;
    }
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
