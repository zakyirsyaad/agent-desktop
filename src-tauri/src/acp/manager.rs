//! Maps app sessions onto ACP sessions running in agent processes.
//!
//! One agent process can host several ACP sessions (a fork lives in the same
//! process as its source), so connections are shared and only killed when the
//! last app session using them stops.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use serde_json::{json, Value};

use super::connection::{error_message, AcpConnection, ConnectionEvent, EventSink};
use super::prompt_blocks::prompt_blocks;
use crate::pty_session::validate_cwd;

/// ACP protocol version this client speaks.
pub const PROTOCOL_VERSION: u64 = 1;
/// The first start may download an adapter through npx, so allow a long handshake.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(180);
const SESSION_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// JSON-RPC "method not found", returned for client methods we do not offer.
const METHOD_NOT_FOUND: i64 = -32601;
/// ACP's "authentication required" error code.
const AUTH_REQUIRED: i64 = -32000;
/// Signing in may wait for the user to finish in a browser.
const AUTHENTICATE_TIMEOUT: Duration = Duration::from_secs(300);
/// Starts the error of a session that needs a sign-in; the agent's auth methods follow as JSON.
pub const AUTH_REQUIRED_PREFIX: &str = "ACP_AUTH_REQUIRED:";

/// How to start an ACP agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpLaunch {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// What `authenticate` says for a method that signs in through a terminal.
const TERMINAL_METHOD_MESSAGE: &str = "This sign-in runs in a terminal";

/// Why opening a session failed: the agent answered with an error (its
/// message says it all), or the process or transport failed (the agent's
/// stderr helps explain that).
pub(super) enum OpenError {
    Agent(String),
    Transport(String),
}

/// What the agent reported when a session started (or was forked).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedSession {
    pub acp_session_id: String,
    pub agent_capabilities: Value,
    pub modes: Value,
    pub models: Value,
    pub config_options: Value,
}

/// Events for the UI, already routed to the app session they belong to.
#[derive(Debug, Clone)]
pub enum AcpEvent {
    Update {
        session_id: String,
        update: Value,
    },
    PermissionRequest {
        session_id: String,
        request_id: Value,
        params: Value,
    },
    /// The prompt turn finished: `Ok(stopReason)` or `Err(message)`.
    TurnEnded {
        session_id: String,
        stop_reason: Result<String, String>,
    },
    Exited {
        session_id: String,
        code: Option<i32>,
    },
}

pub type AcpEventSink = Box<dyn Fn(AcpEvent) + Send + Sync>;

struct SessionEntry {
    connection: Arc<AcpConnection>,
    connection_key: u64,
    acp_session_id: String,
    agent_capabilities: Value,
    /// The sign-in methods the agent reported, offered again when it refuses a prompt.
    auth_methods: Value,
}

#[derive(Default)]
struct Routes {
    /// app session id -> entry
    sessions: HashMap<String, SessionEntry>,
    /// acp session id -> app session id
    by_acp_id: HashMap<String, String>,
}

pub struct AcpManager {
    routes: Arc<Mutex<Routes>>,
    sink: Arc<AcpEventSink>,
    next_connection_key: AtomicU64,
}

impl AcpManager {
    pub fn new(sink: AcpEventSink) -> Self {
        Self {
            routes: Arc::new(Mutex::new(Routes::default())),
            sink: Arc::new(sink),
            next_connection_key: AtomicU64::new(1),
        }
    }

    /// Starts an agent process, initializes ACP and opens a session in `cwd`.
    pub fn start(
        &self,
        app_session_id: &str,
        cwd: &str,
        launch: &AcpLaunch,
    ) -> Result<StartedSession, String> {
        self.open(app_session_id, cwd, launch, |connection, init| {
            let session = open_request(
                connection,
                init,
                "session/new",
                json!({ "cwd": cwd, "mcpServers": [] }),
            )?;
            started_session(session, init["agentCapabilities"].clone()).map_err(OpenError::Agent)
        })
    }

    /// Starts an agent process and resumes its earlier session `acp_session_id`.
    ///
    /// The agent replays the old conversation as `session/update`s before it
    /// answers. The session is registered only after that, so the replay is
    /// not routed to the app, which already has the conversation.
    pub fn load(
        &self,
        app_session_id: &str,
        cwd: &str,
        launch: &AcpLaunch,
        acp_session_id: &str,
    ) -> Result<StartedSession, String> {
        self.open(app_session_id, cwd, launch, |connection, init| {
            let capabilities = init["agentCapabilities"].clone();
            if capabilities["loadSession"] != Value::Bool(true) {
                return Err(OpenError::Agent(
                    "This agent cannot resume earlier sessions".to_string(),
                ));
            }
            let response = open_request(
                connection,
                init,
                "session/load",
                json!({ "sessionId": acp_session_id, "cwd": cwd, "mcpServers": [] }),
            )?;
            Ok(StartedSession {
                acp_session_id: acp_session_id.to_string(),
                agent_capabilities: capabilities,
                modes: response["modes"].clone(),
                models: response["models"].clone(),
                config_options: response["configOptions"].clone(),
            })
        })
    }

    /// Spawns the agent, initializes ACP, opens a session with `open_session`
    /// and registers it. On failure the process is killed and its stderr tail
    /// is added to the error.
    fn open(
        &self,
        app_session_id: &str,
        cwd: &str,
        launch: &AcpLaunch,
        open_session: impl FnOnce(&AcpConnection, &Value) -> Result<StartedSession, OpenError>,
    ) -> Result<StartedSession, String> {
        validate_cwd(cwd)?;
        let connection_key = self.next_connection_key.fetch_add(1, Ordering::SeqCst);
        let connection = AcpConnection::spawn(
            &launch.program,
            &launch.args,
            cwd,
            &launch.env,
            self.connection_sink(connection_key),
        )?;

        let (started, auth_methods) = initialize(&connection)
            .map_err(OpenError::Transport)
            .and_then(|init| {
                open_session(&connection, &init).map(|started| (started, auth_methods_of(&init)))
            })
            .map_err(|error| failure_message(&connection, error))?;
        self.register(
            app_session_id,
            connection,
            connection_key,
            &started,
            auth_methods,
        );
        Ok(started)
    }

    /// Signs in to the agent with one of the methods it reported, in a
    /// short-lived process. Methods that need a secret (an API key in the
    /// environment) are for the user to set up outside the app.
    pub fn authenticate(
        &self,
        cwd: &str,
        launch: &AcpLaunch,
        method_id: &str,
    ) -> Result<(), String> {
        validate_cwd(cwd)?;
        let connection = spawn_unrouted(cwd, launch, |_, _| {})?;
        let result = initialize(&connection).and_then(|init| {
            if is_terminal_method(&init, method_id) {
                return Err(TERMINAL_METHOD_MESSAGE.to_string());
            }
            connection.request(
                "authenticate",
                json!({ "methodId": method_id }),
                AUTHENTICATE_TIMEOUT,
            )
        });
        connection.kill();
        result.map(|_| ())
    }

    /// Forks `source` into a new app session hosted by the same agent process.
    pub fn fork(
        &self,
        source_app_id: &str,
        new_app_id: &str,
        cwd: &str,
    ) -> Result<StartedSession, String> {
        let (connection, connection_key, acp_id, capabilities, auth_methods) =
            self.with_entry(source_app_id, |e| {
                (
                    Arc::clone(&e.connection),
                    e.connection_key,
                    e.acp_session_id.clone(),
                    e.agent_capabilities.clone(),
                    e.auth_methods.clone(),
                )
            })?;
        let response = connection.request(
            "session/fork",
            json!({ "sessionId": acp_id, "cwd": cwd, "mcpServers": [] }),
            SESSION_REQUEST_TIMEOUT,
        )?;
        let started = started_session(response, capabilities)?;
        self.register(
            new_app_id,
            connection,
            connection_key,
            &started,
            auth_methods,
        );
        Ok(started)
    }

    /// Sends a user prompt. Returns once sent; the turn ends with `TurnEnded`.
    pub fn prompt(
        &self,
        app_session_id: &str,
        text: &str,
        attachments: &[String],
    ) -> Result<(), String> {
        let (connection, acp_id, capabilities, auth_methods) =
            self.with_entry(app_session_id, |e| {
                (
                    Arc::clone(&e.connection),
                    e.acp_session_id.clone(),
                    e.agent_capabilities.clone(),
                    e.auth_methods.clone(),
                )
            })?;
        let supports_images = capabilities["promptCapabilities"]["image"] == Value::Bool(true);
        let prompt = prompt_blocks(text, attachments, supports_images)?;
        let sink = Arc::clone(&self.sink);
        let session_id = app_session_id.to_string();
        connection.send_request(
            "session/prompt",
            json!({ "sessionId": acp_id, "prompt": prompt }),
            Box::new(move |result| {
                // An agent can open a session signed out and refuse only the
                // prompt (Claude Code does): the UI then asks for a sign-in.
                let stop_reason = result
                    .map(|r| r["stopReason"].as_str().unwrap_or("end_turn").to_string())
                    .map_err(|e| {
                        if is_auth_required(&e) {
                            auth_required_error(&auth_methods)
                        } else {
                            error_message(&e)
                        }
                    });
                sink(AcpEvent::TurnEnded {
                    session_id,
                    stop_reason,
                });
            }),
        )
    }

    pub fn cancel(&self, app_session_id: &str) -> Result<(), String> {
        let (connection, acp_id) = self.connection_for(app_session_id)?;
        connection.notify("session/cancel", json!({ "sessionId": acp_id }))
    }

    /// Answers a permission request; `None` cancels it.
    pub fn respond_permission(
        &self,
        app_session_id: &str,
        request_id: &Value,
        option_id: Option<&str>,
    ) -> Result<(), String> {
        let (connection, _) = self.connection_for(app_session_id)?;
        let outcome = match option_id {
            Some(option_id) => json!({ "outcome": "selected", "optionId": option_id }),
            None => json!({ "outcome": "cancelled" }),
        };
        connection.respond(request_id, json!({ "outcome": outcome }))
    }

    pub fn set_mode(&self, app_session_id: &str, mode_id: &str) -> Result<(), String> {
        let (connection, acp_id) = self.connection_for(app_session_id)?;
        connection
            .request(
                "session/set_mode",
                json!({ "sessionId": acp_id, "modeId": mode_id }),
                SESSION_REQUEST_TIMEOUT,
            )
            .map(|_| ())
    }

    /// Sets a session config option (e.g. the model); returns the agent's updated options.
    pub fn set_config_option(
        &self,
        app_session_id: &str,
        config_id: &str,
        value: &str,
    ) -> Result<Value, String> {
        let (connection, acp_id) = self.connection_for(app_session_id)?;
        let response = connection.request(
            "session/set_config_option",
            json!({ "sessionId": acp_id, "configId": config_id, "value": value }),
            SESSION_REQUEST_TIMEOUT,
        )?;
        Ok(response["configOptions"].clone())
    }

    /// Stops every session; returns how many there were.
    pub fn stop_all(&self) -> usize {
        let ids: Vec<String> = self
            .routes
            .lock()
            .map(|routes| routes.sessions.keys().cloned().collect())
            .unwrap_or_default();
        ids.iter().for_each(|id| self.stop(id));
        ids.len()
    }

    /// Each running session's agent pid, by session id; sessions sharing an
    /// agent each list its pid.
    pub fn root_pids(&self) -> Vec<(String, u32)> {
        let mut roots: Vec<(String, u32)> = self
            .routes
            .lock()
            .map(|routes| {
                routes
                    .sessions
                    .iter()
                    .filter_map(|(id, entry)| Some((id.clone(), entry.connection.pid()?)))
                    .collect()
            })
            .unwrap_or_default();
        roots.sort();
        roots
    }

    /// Forgets the session; kills the agent once no other session uses it.
    pub fn stop(&self, app_session_id: &str) {
        let Ok(mut routes) = self.routes.lock() else {
            return;
        };
        let Some(entry) = routes.sessions.remove(app_session_id) else {
            return;
        };
        routes.by_acp_id.remove(&entry.acp_session_id);
        let still_used = routes
            .sessions
            .values()
            .any(|e| e.connection_key == entry.connection_key);
        if !still_used {
            entry.connection.kill();
        }
    }

    fn register(
        &self,
        app_session_id: &str,
        connection: Arc<AcpConnection>,
        key: u64,
        started: &StartedSession,
        auth_methods: Value,
    ) {
        if let Ok(mut routes) = self.routes.lock() {
            routes
                .by_acp_id
                .insert(started.acp_session_id.clone(), app_session_id.to_string());
            routes.sessions.insert(
                app_session_id.to_string(),
                SessionEntry {
                    connection,
                    connection_key: key,
                    acp_session_id: started.acp_session_id.clone(),
                    agent_capabilities: started.agent_capabilities.clone(),
                    auth_methods,
                },
            );
        }
    }

    fn with_entry<T>(
        &self,
        app_session_id: &str,
        f: impl FnOnce(&SessionEntry) -> T,
    ) -> Result<T, String> {
        let routes = self
            .routes
            .lock()
            .map_err(|_| "Session lock poisoned".to_string())?;
        routes
            .sessions
            .get(app_session_id)
            .map(f)
            .ok_or_else(|| format!("Session '{}' not found", app_session_id))
    }

    fn connection_for(&self, app_session_id: &str) -> Result<(Arc<AcpConnection>, String), String> {
        self.with_entry(app_session_id, |e| {
            (Arc::clone(&e.connection), e.acp_session_id.clone())
        })
    }

    /// Routes one connection's events to the app sessions it hosts.
    fn connection_sink(&self, connection_key: u64) -> EventSink {
        let routes = Arc::clone(&self.routes);
        let sink = Arc::clone(&self.sink);
        Arc::new(move |event| route_event(&routes, &sink, connection_key, event))
    }
}

fn route_event(
    routes: &Arc<Mutex<Routes>>,
    sink: &Arc<AcpEventSink>,
    connection_key: u64,
    event: ConnectionEvent,
) {
    let app_id_for = |acp_id: &str| {
        routes
            .lock()
            .ok()
            .and_then(|r| r.by_acp_id.get(acp_id).cloned())
    };
    match event {
        ConnectionEvent::Notification { method, params } if method == "session/update" => {
            if let Some(session_id) = params["sessionId"].as_str().and_then(app_id_for) {
                sink(AcpEvent::Update {
                    session_id,
                    update: params["update"].clone(),
                });
            }
        }
        ConnectionEvent::Notification { .. } => {}
        ConnectionEvent::Request { id, method, params } => {
            let session_id = params["sessionId"].as_str().and_then(app_id_for);
            match (method.as_str(), session_id) {
                ("session/request_permission", Some(session_id)) => {
                    sink(AcpEvent::PermissionRequest {
                        session_id,
                        request_id: id,
                        params,
                    })
                }
                // We advertise no fs/terminal capabilities, so anything else is refused.
                _ => refuse(routes, connection_key, &id),
            }
        }
        ConnectionEvent::Exited { code } => {
            let gone: Vec<String> = routes
                .lock()
                .map(|mut r| {
                    let ids: Vec<String> = r
                        .sessions
                        .iter()
                        .filter(|(_, e)| e.connection_key == connection_key)
                        .map(|(id, _)| id.clone())
                        .collect();
                    for id in &ids {
                        if let Some(entry) = r.sessions.remove(id) {
                            r.by_acp_id.remove(&entry.acp_session_id);
                        }
                    }
                    ids
                })
                .unwrap_or_default();
            for session_id in gone {
                sink(AcpEvent::Exited { session_id, code });
            }
        }
    }
}

fn refuse(routes: &Arc<Mutex<Routes>>, connection_key: u64, id: &Value) {
    let connection = routes.lock().ok().and_then(|r| {
        r.sessions
            .values()
            .find(|e| e.connection_key == connection_key)
            .map(|e| Arc::clone(&e.connection))
    });
    if let Some(connection) = connection {
        let _ = connection.respond_error(id, METHOD_NOT_FOUND, "Method not supported by Zorvo");
    }
}

/// `-32000` is also JSON-RPC's generic server error, so the message must say it is about signing in.
fn is_auth_required(error: &Value) -> bool {
    // Letters only, so "Not logged in", "log-in" and "signed in" all match.
    let message: String = error["message"]
        .as_str()
        .unwrap_or_default()
        .chars()
        .filter(char::is_ascii_alphabetic)
        .collect::<String>()
        .to_ascii_lowercase();
    error["code"].as_i64() == Some(AUTH_REQUIRED)
        && ["auth", "login", "loggedin", "signin", "signedin"]
            .iter()
            .any(|word| message.contains(word))
}

/// Opens a session; an "authentication required" answer becomes an error
/// carrying [`AUTH_REQUIRED_PREFIX`] and the agent's auth methods.
pub(super) fn open_request(
    connection: &AcpConnection,
    init: &Value,
    method: &str,
    params: Value,
) -> Result<Value, OpenError> {
    match connection
        .request_raw(method, params, HANDSHAKE_TIMEOUT)
        .map_err(OpenError::Transport)?
    {
        Ok(result) => Ok(result),
        Err(error) if is_auth_required(&error) => Err(OpenError::Agent(auth_required_error(
            &auth_methods_of(init),
        ))),
        Err(error) => Err(OpenError::Agent(format!(
            "{} failed: {}",
            method,
            error_message(&error)
        ))),
    }
}

/// Whether `method_id` is a `type: "terminal"` method, which only a terminal can run.
fn is_terminal_method(init: &Value, method_id: &str) -> bool {
    init["authMethods"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|m| m["id"] == method_id && m["type"] == "terminal")
}

/// The sign-in methods `initialize` reported, always as a JSON array.
pub(super) fn auth_methods_of(init: &Value) -> Value {
    match &init["authMethods"] {
        Value::Array(methods) => Value::Array(methods.clone()),
        _ => Value::Array(Vec::new()),
    }
}

/// The error the UI reads as "sign in first": [`AUTH_REQUIRED_PREFIX`] and the methods.
pub(super) fn auth_required_error(auth_methods: &Value) -> String {
    format!("{}{}", AUTH_REQUIRED_PREFIX, auth_methods)
}

/// Ends a connection that failed to open and says why. A transport failure
/// gets the agent's stderr tail; an agent's own answer (sign-in JSON
/// included, which the UI parses) is kept as it is.
pub(super) fn failure_message(connection: &AcpConnection, error: OpenError) -> String {
    let stderr = connection.stderr_tail();
    connection.kill();
    match error {
        OpenError::Agent(message) => message,
        OpenError::Transport(message) if stderr.is_empty() => message,
        OpenError::Transport(message) => format!("{}\n{}", message, stderr),
    }
}

/// Spawns an agent that hosts no app session (a sign-in or a probe). Routing
/// cannot answer its requests, so they are refused here and the agent never
/// waits on us; its notifications go to `on_notification`.
pub(super) fn spawn_unrouted(
    cwd: &str,
    launch: &AcpLaunch,
    on_notification: impl Fn(&str, &Value) + Send + Sync + 'static,
) -> Result<Arc<AcpConnection>, String> {
    let connection_slot: Arc<OnceLock<Weak<AcpConnection>>> = Arc::new(OnceLock::new());
    let sink_slot = Arc::clone(&connection_slot);
    let sink: EventSink = Arc::new(move |event| match event {
        ConnectionEvent::Request { id, .. } => {
            if let Some(connection) = sink_slot.get().and_then(Weak::upgrade) {
                let _ = connection.respond_error(&id, METHOD_NOT_FOUND, "Not available here");
            }
        }
        ConnectionEvent::Notification { method, params } => on_notification(&method, &params),
        ConnectionEvent::Exited { .. } => {}
    });
    let connection = AcpConnection::spawn(&launch.program, &launch.args, cwd, &launch.env, sink)?;
    let _ = connection_slot.set(Arc::downgrade(&connection));
    Ok(connection)
}

/// Initializes ACP and returns the agent's answer: capabilities and auth methods.
pub(super) fn initialize(connection: &AcpConnection) -> Result<Value, String> {
    connection.request(
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false, "auth": { "terminal": true } },
            "clientInfo": { "name": "zorvo", "version": env!("CARGO_PKG_VERSION") },
        }),
        HANDSHAKE_TIMEOUT,
    )
}

fn started_session(response: Value, agent_capabilities: Value) -> Result<StartedSession, String> {
    let acp_session_id = response["sessionId"]
        .as_str()
        .ok_or("The agent did not return a session id")?
        .to_string();
    Ok(StartedSession {
        acp_session_id,
        agent_capabilities,
        modes: response["modes"].clone(),
        models: response["models"].clone(),
        config_options: response["configOptions"].clone(),
    })
}
