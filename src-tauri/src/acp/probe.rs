//! Asks an ACP agent what it offers before the user starts a session with it.
//!
//! An agent reports its modes, models, efforts and slash commands only once a
//! session is open, and some (Claude Code) open one while signed out and
//! refuse only the first prompt. A probe asks in a short-lived process, so the
//! composer can offer the agent's own choices and ask for a sign-in before the
//! user writes a message.
//!
//! Opening a session is not free: the agent may run the user's session hooks
//! and record the session in its history. So a session is opened only when
//! needed, and deleted afterwards: to learn the options of an agent that never
//! ran, or to learn whether someone is signed in to an agent that cannot say
//! so on its own. An agent that reports its sign-in (Claude Code) and whose
//! options are known is only asked who is signed in.

use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use std::sync::Arc;

use serde_json::{json, Value};

use super::connection::AcpConnection;
use super::manager::{
    auth_methods_of, auth_required_error, failure_message, initialize, open_request,
    spawn_unrouted, AcpLaunch, AcpManager, OpenError,
};
use crate::pty_session::validate_cwd;

/// How long to wait for the sign-in status the agent pushes on its own.
/// Claude Code's comes from a CLI check that it caps at five seconds.
const AUTH_STATUS_TIMEOUT: Duration = Duration::from_secs(6);
/// How long to wait, once the session opened, for its slash commands. Agents
/// send them at once; one that has none must not hold the options back.
const COMMANDS_TIMEOUT: Duration = Duration::from_secs(2);
/// Deleting the throwaway session is a courtesy; a slow agent is not waited on.
const DISCARD_TIMEOUT: Duration = Duration::from_secs(5);
/// The extension notification that says who the agent is signed in as.
const AUTH_STATUS_UPDATE: &str = "_auth/status_update";
/// The `authStatus.kind` that means nobody is signed in.
const SIGNED_OUT: &str = "none";

/// What an agent offers in a new session; empty when no session was opened.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbedAgent {
    pub modes: Value,
    pub config_options: Value,
    /// The slash commands, as the agent's `available_commands_update` lists them.
    pub commands: Value,
    /// Whether the agent showed someone is signed in: it opened a session, or
    /// reported an account. False when it said nothing either way.
    pub sign_in_checked: bool,
}

/// What the agent pushes on its own while a probe waits.
enum Pushed {
    Commands(Value),
    AuthStatus(String),
}

/// What a probe waits for, and until when.
struct Awaited {
    commands_until: Option<Instant>,
    auth_until: Option<Instant>,
}

impl AcpManager {
    /// Asks the agent what it offers and whether someone is signed in, then
    /// ends it. With `needs_options`, or when the agent cannot report its
    /// sign-in, a throwaway session is opened (and deleted in the background)
    /// to learn the modes, options and commands; otherwise only the sign-in
    /// status is read. Fails with the sign-in error the UI parses when the
    /// agent will not open a session, or says nobody is signed in.
    pub fn probe(
        &self,
        cwd: &str,
        launch: &AcpLaunch,
        needs_options: bool,
    ) -> Result<ProbedAgent, String> {
        validate_cwd(cwd)?;
        let started = Instant::now();
        let (tx, rx) = mpsc::channel();
        let connection = spawn_unrouted(cwd, launch, move |method, params| {
            let pushed = match method {
                "session/update"
                    if params["update"]["sessionUpdate"] == "available_commands_update" =>
                {
                    Pushed::Commands(params["update"]["availableCommands"].clone())
                }
                AUTH_STATUS_UPDATE => Pushed::AuthStatus(
                    params["authStatus"]["kind"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                ),
                _ => return,
            };
            let _ = tx.send(pushed);
        })?;

        let result = initialize(&connection)
            .map_err(OpenError::Transport)
            .and_then(|init| {
                let reports_auth = init["agentCapabilities"]["_meta"]["authStatus"].is_object();
                let auth_until = reports_auth.then(|| started + AUTH_STATUS_TIMEOUT);
                if !needs_options && reports_auth {
                    let awaited = Awaited {
                        commands_until: None,
                        auth_until,
                    };
                    let auth_kind = settle(&rx, &awaited).1;
                    let probed = ProbedAgent {
                        modes: Value::Null,
                        config_options: Value::Array(Vec::new()),
                        commands: Value::Array(Vec::new()),
                        sign_in_checked: auth_kind.is_some(),
                    };
                    let outcome = signed_in(&init, auth_kind.as_deref()).map(|()| probed);
                    return Ok((outcome, None));
                }
                // Opening a session is also how an agent that cannot report its sign-in refuses it.
                let session = open_request(
                    &connection,
                    &init,
                    "session/new",
                    json!({ "cwd": cwd, "mcpServers": [] }),
                )?;
                let awaited = Awaited {
                    commands_until: Some(Instant::now() + COMMANDS_TIMEOUT),
                    auth_until,
                };
                let (commands, auth_kind) = settle(&rx, &awaited);
                let probed = ProbedAgent {
                    modes: session["modes"].clone(),
                    config_options: session["configOptions"].clone(),
                    commands: commands.unwrap_or_else(|| Value::Array(Vec::new())),
                    // An agent that reports its sign-in may open sessions signed out
                    // (Claude Code): then only a reported account shows one.
                    sign_in_checked: !reports_auth || auth_kind.is_some(),
                };
                let discard =
                    discard_method(&init).map(|method| (method, session["sessionId"].clone()));
                Ok((
                    signed_in(&init, auth_kind.as_deref()).map(|()| probed),
                    discard,
                ))
            });
        match result {
            // Signed in or not, the agent answered: its session goes in the background.
            Ok((outcome, discard)) => {
                finish_in_background(connection, discard);
                outcome.map_err(failure_message_without_stderr)
            }
            Err(error) => Err(failure_message(&connection, error)),
        }
    }
}

/// The message of an answer the agent gave itself (the sign-in error the UI parses).
fn failure_message_without_stderr(error: OpenError) -> String {
    match error {
        OpenError::Agent(message) | OpenError::Transport(message) => message,
    }
}

/// Fails with the sign-in error when the agent said nobody is signed in.
fn signed_in(init: &Value, auth_kind: Option<&str>) -> Result<(), OpenError> {
    if auth_kind == Some(SIGNED_OUT) {
        return Err(OpenError::Agent(auth_required_error(&auth_methods_of(
            init,
        ))));
    }
    Ok(())
}

/// Ends the agent; first, off the caller's thread, deletes the throwaway
/// session, so the options are not held back while the agent tears it down.
fn finish_in_background(connection: Arc<AcpConnection>, discard: Option<(&'static str, Value)>) {
    let Some((method, session_id)) = discard else {
        connection.kill();
        return;
    };
    std::thread::spawn(move || {
        discard_session(&connection, method, &session_id);
        connection.kill();
    });
}

/// How to remove a throwaway session: delete it from the agent's history, or
/// at least close it; nothing when the agent offers neither.
fn discard_method(init: &Value) -> Option<&'static str> {
    let capabilities = &init["agentCapabilities"]["sessionCapabilities"];
    if capabilities["delete"].is_object() {
        Some("session/delete")
    } else if capabilities["close"].is_object() {
        Some("session/close")
    } else {
        None
    }
}

/// Removes the throwaway session. A failure only leaves it as it was.
fn discard_session(connection: &AcpConnection, method: &str, session_id: &Value) {
    let _ = connection.request(method, json!({ "sessionId": session_id }), DISCARD_TIMEOUT);
}

/// Collects the pushes `awaited` names until each arrived or its deadline
/// passed. The latest of each wins.
fn settle(rx: &Receiver<Pushed>, awaited: &Awaited) -> (Option<Value>, Option<String>) {
    let mut commands = None;
    let mut auth_kind = None;
    loop {
        let now = Instant::now();
        let still = |until: Option<Instant>, got: bool| until.filter(|u| !got && *u > now);
        let next_deadline = [
            still(awaited.commands_until, commands.is_some()),
            still(awaited.auth_until, auth_kind.is_some()),
        ]
        .into_iter()
        .flatten()
        .min();
        let Some(deadline) = next_deadline else {
            break;
        };
        match rx.recv_timeout(deadline - now) {
            Ok(Pushed::Commands(value)) => commands = Some(value),
            Ok(Pushed::AuthStatus(kind)) => auth_kind = Some(kind),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    // Pushes that came in together with the last one awaited.
    for pushed in rx.try_iter() {
        match pushed {
            Pushed::Commands(value) => commands = Some(value),
            Pushed::AuthStatus(kind) => auth_kind = Some(kind),
        }
    }
    (commands, auth_kind)
}
