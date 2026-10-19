//! Asks an ACP agent what it offers before the user starts a session with it.
//!
//! An agent reports its modes, models, efforts and slash commands only once a
//! session is open, and some (Claude Code) open one while signed out and
//! refuse only the first prompt. A probe opens a throwaway session in a
//! short-lived process, so the composer can offer the agent's own choices and
//! ask for a sign-in before the user writes a message.

use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::manager::{
    auth_methods_of, auth_required_error, failure_message, initialize, open_request,
    spawn_unrouted, AcpLaunch, AcpManager, OpenError,
};
use crate::pty_session::validate_cwd;

/// How long to wait, after the session opened, for the commands and the
/// sign-in status the agent sends on its own. Claude Code's status comes
/// from a CLI check that it caps at five seconds.
const SETTLE_TIMEOUT: Duration = Duration::from_secs(6);
/// The extension notification that says who the agent is signed in as.
const AUTH_STATUS_UPDATE: &str = "_auth/status_update";
/// The `authStatus.kind` that means nobody is signed in.
const SIGNED_OUT: &str = "none";

/// What an agent offers in a new session.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbedAgent {
    pub modes: Value,
    pub config_options: Value,
    /// The slash commands, as the agent's `available_commands_update` lists them.
    pub commands: Value,
}

/// What the agent pushes on its own while a probe waits.
enum Pushed {
    Commands(Value),
    AuthStatus(String),
}

impl AcpManager {
    /// Opens a throwaway session to learn what the agent offers, then ends
    /// the agent. Fails with the sign-in error the UI parses when the agent
    /// will not open a session, or says nobody is signed in.
    pub fn probe(&self, cwd: &str, launch: &AcpLaunch) -> Result<ProbedAgent, String> {
        validate_cwd(cwd)?;
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
                let session = open_request(
                    &connection,
                    &init,
                    "session/new",
                    json!({ "cwd": cwd, "mcpServers": [] }),
                )?;
                let reports_auth = init["agentCapabilities"]["_meta"]["authStatus"].is_object();
                let (commands, auth_kind) = settle(&rx, reports_auth);
                if auth_kind.as_deref() == Some(SIGNED_OUT) {
                    return Err(OpenError::Agent(auth_required_error(&auth_methods_of(
                        &init,
                    ))));
                }
                Ok(ProbedAgent {
                    modes: session["modes"].clone(),
                    config_options: session["configOptions"].clone(),
                    commands: commands.unwrap_or_else(|| Value::Array(Vec::new())),
                })
            });
        match result {
            Ok(probed) => {
                connection.kill();
                Ok(probed)
            }
            Err(error) => Err(failure_message(&connection, error)),
        }
    }
}

/// Collects the commands and, when the agent reports one, its sign-in
/// status, until both arrived or [`SETTLE_TIMEOUT`] passed. The latest of
/// each wins.
fn settle(rx: &Receiver<Pushed>, reports_auth: bool) -> (Option<Value>, Option<String>) {
    let deadline = Instant::now() + SETTLE_TIMEOUT;
    let mut commands = None;
    let mut auth_kind = None;
    while commands.is_none() || (reports_auth && auth_kind.is_none()) {
        let Some(left) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        match rx.recv_timeout(left) {
            Ok(Pushed::Commands(value)) => commands = Some(value),
            Ok(Pushed::AuthStatus(kind)) => auth_kind = Some(kind),
            Err(_) => break,
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
