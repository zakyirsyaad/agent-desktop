//! Maps app sessions onto ACP sessions running in agent processes.
//!
//! One agent process can host several ACP sessions (a fork lives in the same
//! process as its source), so connections are shared and only killed when the
//! last app session using them stops.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
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
    Update { session_id: String, update: Value },
    PermissionRequest { session_id: String, request_id: Value, params: Value },
    /// The prompt turn finished: `Ok(stopReason)` or `Err(message)`.
    TurnEnded { session_id: String, stop_reason: Result<String, String> },
    Exited { session_id: String, code: Option<i32> },
}

pub type AcpEventSink = Box<dyn Fn(AcpEvent) + Send + Sync>;

struct SessionEntry {
    connection: Arc<AcpConnection>,
    connection_key: u64,
    acp_session_id: String,
    agent_capabilities: Value,
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
    pub fn start(&self, app_session_id: &str, cwd: &str, launch: &AcpLaunch) -> Result<StartedSession, String> {
        self.open(app_session_id, cwd, launch, |connection, init| {
            let session = open_request(connection, init, "session/new", json!({ "cwd": cwd, "mcpServers": [] }))?;
            started_session(session, init["agentCapabilities"].clone())
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
                return Err("This agent cannot resume earlier sessions".to_string());
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
        open_session: impl FnOnce(&AcpConnection, &Value) -> Result<StartedSession, String>,
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

        let started = initialize(&connection)
            .and_then(|init| open_session(&connection, &init))
            .map_err(|e| {
                let stderr = connection.stderr_tail();
                connection.kill();
                // A sign-in error carries JSON the UI parses; stderr would break it.
                if stderr.is_empty() || e.starts_with(AUTH_REQUIRED_PREFIX) {
                    e
                } else {
                    format!("{}\n{}", e, stderr)
                }
            })?;
        self.register(app_session_id, connection, connection_key, &started);
        Ok(started)
    }

    /// Signs in to the agent with one of the methods it reported, in a
    /// short-lived process. Methods that need a secret (an API key in the
    /// environment) are for the user to set up outside the app.
    pub fn authenticate(&self, cwd: &str, launch: &AcpLaunch, method_id: &str) -> Result<(), String> {
        validate_cwd(cwd)?;
        let connection_key = self.next_connection_key.fetch_add(1, Ordering::SeqCst);
        let connection = AcpConnection::spawn(
            &launch.program,
            &launch.args,
            cwd,
            &launch.env,
            self.connection_sink(connection_key),
        )?;
        let result = initialize(&connection).and_then(|_| {
            connection.request("authenticate", json!({ "methodId": method_id }), AUTHENTICATE_TIMEOUT)
        });
        connection.kill();
        result.map(|_| ())
    }

    /// Forks `source` into a new app session hosted by the same agent process.
    pub fn fork(&self, source_app_id: &str, new_app_id: &str, cwd: &str) -> Result<StartedSession, String> {
        let (connection, connection_key, acp_id, capabilities) = self.with_entry(source_app_id, |e| {
            (Arc::clone(&e.connection), e.connection_key, e.acp_session_id.clone(), e.agent_capabilities.clone())
        })?;
        let response = connection.request(
            "session/fork",
            json!({ "sessionId": acp_id, "cwd": cwd, "mcpServers": [] }),
            SESSION_REQUEST_TIMEOUT,
        )?;
        let started = started_session(response, capabilities)?;
        self.register(new_app_id, connection, connection_key, &started);
        Ok(started)
    }

    /// Sends a user prompt. Returns once sent; the turn ends with `TurnEnded`.
    pub fn prompt(&self, app_session_id: &str, text: &str, attachments: &[String]) -> Result<(), String> {
        let (connection, acp_id, capabilities) = self.with_entry(app_session_id, |e| {
            (Arc::clone(&e.connection), e.acp_session_id.clone(), e.agent_capabilities.clone())
        })?;
        let supports_images = capabilities["promptCapabilities"]["image"] == Value::Bool(true);
        let prompt = prompt_blocks(text, attachments, supports_images)?;
        let sink = Arc::clone(&self.sink);
        let session_id = app_session_id.to_string();
        connection.send_request(
            "session/prompt",
            json!({ "sessionId": acp_id, "prompt": prompt }),
            Box::new(move |result| {
                let stop_reason = result
                    .map(|r| r["stopReason"].as_str().unwrap_or("end_turn").to_string())
                    .map_err(|e| error_message(&e));
                sink(AcpEvent::TurnEnded { session_id, stop_reason });
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
    pub fn set_config_option(&self, app_session_id: &str, config_id: &str, value: &str) -> Result<Value, String> {
        let (connection, acp_id) = self.connection_for(app_session_id)?;
        let response = connection.request(
            "session/set_config_option",
            json!({ "sessionId": acp_id, "configId": config_id, "value": value }),
            SESSION_REQUEST_TIMEOUT,
        )?;
        Ok(response["configOptions"].clone())
    }

    /// Forgets the session; kills the agent once no other session uses it.
    pub fn stop(&self, app_session_id: &str) {
        let Ok(mut routes) = self.routes.lock() else { return };
        let Some(entry) = routes.sessions.remove(app_session_id) else { return };
        routes.by_acp_id.remove(&entry.acp_session_id);
        let still_used = routes.sessions.values().any(|e| e.connection_key == entry.connection_key);
        if !still_used {
            entry.connection.kill();
        }
    }

    fn register(&self, app_session_id: &str, connection: Arc<AcpConnection>, key: u64, started: &StartedSession) {
        if let Ok(mut routes) = self.routes.lock() {
            routes.by_acp_id.insert(started.acp_session_id.clone(), app_session_id.to_string());
            routes.sessions.insert(
                app_session_id.to_string(),
                SessionEntry {
                    connection,
                    connection_key: key,
                    acp_session_id: started.acp_session_id.clone(),
                    agent_capabilities: started.agent_capabilities.clone(),
                },
            );
        }
    }

    fn with_entry<T>(&self, app_session_id: &str, f: impl FnOnce(&SessionEntry) -> T) -> Result<T, String> {
        let routes = self.routes.lock().map_err(|_| "Session lock poisoned".to_string())?;
        routes
            .sessions
            .get(app_session_id)
            .map(f)
            .ok_or_else(|| format!("Session '{}' not found", app_session_id))
    }

    fn connection_for(&self, app_session_id: &str) -> Result<(Arc<AcpConnection>, String), String> {
        self.with_entry(app_session_id, |e| (Arc::clone(&e.connection), e.acp_session_id.clone()))
    }

    /// Routes one connection's events to the app sessions it hosts.
    fn connection_sink(&self, connection_key: u64) -> EventSink {
        let routes = Arc::clone(&self.routes);
        let sink = Arc::clone(&self.sink);
        Arc::new(move |event| route_event(&routes, &sink, connection_key, event))
    }
}

fn route_event(routes: &Arc<Mutex<Routes>>, sink: &Arc<AcpEventSink>, connection_key: u64, event: ConnectionEvent) {
    let app_id_for = |acp_id: &str| routes.lock().ok().and_then(|r| r.by_acp_id.get(acp_id).cloned());
    match event {
        ConnectionEvent::Notification { method, params } if method == "session/update" => {
            if let Some(session_id) = params["sessionId"].as_str().and_then(app_id_for) {
                sink(AcpEvent::Update { session_id, update: params["update"].clone() });
            }
        }
        ConnectionEvent::Notification { .. } => {}
        ConnectionEvent::Request { id, method, params } => {
            let session_id = params["sessionId"].as_str().and_then(app_id_for);
            match (method.as_str(), session_id) {
                ("session/request_permission", Some(session_id)) => {
                    sink(AcpEvent::PermissionRequest { session_id, request_id: id, params })
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
        let _ = connection.respond_error(id, METHOD_NOT_FOUND, "Method not supported by Agent Desktop");
    }
}

/// `-32000` is also JSON-RPC's generic server error, so the message must say it is about signing in.
fn is_auth_required(error: &Value) -> bool {
    let message = error["message"].as_str().unwrap_or_default().to_ascii_lowercase();
    error["code"].as_i64() == Some(AUTH_REQUIRED)
        && ["auth", "login", "log in", "sign in"].iter().any(|word| message.contains(word))
}

/// Opens a session; an "authentication required" answer becomes an error
/// carrying [`AUTH_REQUIRED_PREFIX`] and the agent's auth methods.
fn open_request(connection: &AcpConnection, init: &Value, method: &str, params: Value) -> Result<Value, String> {
    match connection.request_raw(method, params, HANDSHAKE_TIMEOUT)? {
        Ok(result) => Ok(result),
        Err(error) if is_auth_required(&error) => {
            let methods = match &init["authMethods"] {
                Value::Array(methods) => Value::Array(methods.clone()),
                _ => Value::Array(Vec::new()),
            };
            Err(format!("{}{}", AUTH_REQUIRED_PREFIX, methods))
        }
        Err(error) => Err(format!("{} failed: {}", method, error_message(&error))),
    }
}

/// Initializes ACP and returns the agent's answer: capabilities and auth methods.
fn initialize(connection: &AcpConnection) -> Result<Value, String> {
    connection.request(
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
            "clientInfo": { "name": "agent-desktop", "version": env!("CARGO_PKG_VERSION") },
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
