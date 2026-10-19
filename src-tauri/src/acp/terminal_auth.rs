//! Terminal sign-in for ACP agents.
//!
//! An agent can offer an auth method of `type: "terminal"`: sign in by running
//! its own command in a terminal. The method carries extra `args` and `env`
//! for that command, and both come from the agent, so they are checked here
//! before Zorvo runs anything. The webview only names a method; it never
//! sends a program, arguments or environment.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::connection::AcpConnection;
use super::manager::{
    auth_methods_of, auth_required_error, failure_message, initialize, spawn_unrouted, AcpLaunch,
    AcpManager, OpenError,
};
use crate::pty_session::{validate_cwd, PtyEvent};
use crate::registry::schema::is_safe_env_key;

/// The event that carries a sign-in terminal's output and exit to the webview.
pub const SIGN_IN_TERMINAL_EVENT: &str = "sign-in-terminal";

const MAX_ARGS: usize = 32;
const MAX_ARG_BYTES: usize = 1024;
const MAX_ID_SUFFIX: usize = 64;
const ID_PREFIX: &str = "signin-";
const REFUSED_PREFIX: &str = "Zorvo does not run this sign-in: ";
/// The error of a sign-in the user cancelled before its terminal started.
pub const CANCELLED_MESSAGE: &str = "Sign-in cancelled";

/// The extra arguments and environment of a terminal auth method.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalMethod {
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TerminalMethodError {
    /// The agent offers no terminal method with that id.
    NotOffered,
    /// The method exists but asks for something Zorvo will not run.
    Refused(String),
}

fn refused(reason: impl AsRef<str>) -> TerminalMethodError {
    TerminalMethodError::Refused(format!("{REFUSED_PREFIX}{}", reason.as_ref()))
}

/// Finds the terminal method `method_id` in an `initialize` result and checks
/// its arguments and environment.
pub fn terminal_method(
    init: &Value,
    method_id: &str,
) -> Result<TerminalMethod, TerminalMethodError> {
    let method = init
        .get("authMethods")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|m| {
            m.get("id").and_then(Value::as_str) == Some(method_id)
                && m.get("type").and_then(Value::as_str) == Some("terminal")
        })
        .ok_or(TerminalMethodError::NotOffered)?;
    let args = read_args(method.get("args"))?;
    let env = read_env(method.get("env"))?;
    Ok(TerminalMethod { args, env })
}

fn read_args(value: Option<&Value>) -> Result<Vec<String>, TerminalMethodError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let list = value
        .as_array()
        .ok_or_else(|| refused("its arguments are not a list of text"))?;
    if list.len() > MAX_ARGS {
        return Err(refused(format!("it passes more than {MAX_ARGS} arguments")));
    }
    list.iter()
        .map(|item| {
            let arg = item
                .as_str()
                .ok_or_else(|| refused("its arguments are not a list of text"))?;
            if arg.len() > MAX_ARG_BYTES {
                return Err(refused(format!(
                    "an argument is longer than {MAX_ARG_BYTES} bytes"
                )));
            }
            if arg.contains('\0') {
                return Err(refused("an argument contains a NUL character"));
            }
            Ok(arg.to_string())
        })
        .collect()
}

fn read_env(value: Option<&Value>) -> Result<BTreeMap<String, String>, TerminalMethodError> {
    let Some(value) = value else {
        return Ok(BTreeMap::new());
    };
    let map = value
        .as_object()
        .ok_or_else(|| refused("its environment is not a map of text"))?;
    map.iter()
        .map(|(key, item)| {
            if !is_safe_env_key(key) {
                return Err(refused(format!("it sets {key}")));
            }
            let text = item
                .as_str()
                .ok_or_else(|| refused("its environment is not a map of text"))?;
            if text.contains('\0') {
                return Err(refused("a variable contains a NUL character"));
            }
            Ok((key.clone(), text.to_string()))
        })
        .collect()
}

/// The agent's own launch plus the method's arguments; the method's variables
/// replace any of the same name.
pub fn login_command(launch: &AcpLaunch, method: &TerminalMethod) -> AcpLaunch {
    let mut args = launch.args.clone();
    args.extend(method.args.iter().cloned());
    let mut env: Vec<(String, String)> = launch
        .env
        .iter()
        .filter(|(key, _)| !method.env.contains_key(key))
        .cloned()
        .collect();
    env.extend(method.env.iter().map(|(k, v)| (k.clone(), v.clone())));
    AcpLaunch {
        program: launch.program.clone(),
        args,
        env,
    }
}

/// `^signin-[a-z0-9-]{1,64}$`
pub fn is_sign_in_terminal_id(id: &str) -> bool {
    id.strip_prefix(ID_PREFIX).is_some_and(|suffix| {
        (1..=MAX_ID_SUFFIX).contains(&suffix.len())
            && suffix
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    })
}

/// The payload of a `sign-in-terminal` event. The PTY session id is the
/// terminal id.
pub fn sign_in_event_payload(event: &PtyEvent) -> Value {
    match event {
        PtyEvent::Output { session_id, data } => {
            json!({ "terminalId": session_id, "kind": "output", "data": data })
        }
        PtyEvent::Exit {
            session_id,
            exit_code,
        } => json!({ "terminalId": session_id, "kind": "exit", "exitCode": exit_code }),
    }
}

/// The terminal sign-ins being started, by terminal id: one attempt per id,
/// and a cancel ends the short-lived agent an attempt is reading its method from.
#[derive(Default)]
pub struct SignInAttempts {
    attempts: Mutex<HashMap<String, Attempt>>,
}

#[derive(Default)]
struct Attempt {
    connection: Option<Arc<AcpConnection>>,
    is_cancelled: bool,
}

impl SignInAttempts {
    /// Claims `terminal_id` for a new attempt.
    pub fn begin(&self, terminal_id: &str) -> Result<(), String> {
        let mut attempts = self.lock();
        if attempts.contains_key(terminal_id) {
            return Err("That sign-in is already running".to_string());
        }
        attempts.insert(terminal_id.to_string(), Attempt::default());
        Ok(())
    }

    /// Remembers the agent an attempt waits on; false when the attempt was
    /// cancelled already, and the caller stops.
    pub fn track(&self, terminal_id: &str, connection: Arc<AcpConnection>) -> bool {
        match self.lock().get_mut(terminal_id) {
            Some(attempt) if !attempt.is_cancelled => {
                attempt.connection = Some(connection);
                true
            }
            _ => false,
        }
    }

    pub fn is_cancelled(&self, terminal_id: &str) -> bool {
        self.lock()
            .get(terminal_id)
            .is_some_and(|attempt| attempt.is_cancelled)
    }

    /// Cancels an attempt still starting, ending the agent it waits on. An
    /// attempt that is not under way is left alone.
    pub fn cancel(&self, terminal_id: &str) {
        let connection = self.lock().get_mut(terminal_id).and_then(|attempt| {
            attempt.is_cancelled = true;
            attempt.connection.take()
        });
        if let Some(connection) = connection {
            connection.kill();
        }
    }

    pub fn end(&self, terminal_id: &str) {
        self.lock().remove(terminal_id);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Attempt>> {
        self.attempts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl AcpManager {
    /// Builds the command that signs in to the agent through its terminal
    /// method `method_id`. The method is read from the agent's own `initialize`
    /// in a short-lived process, so the webview never names a program.
    pub fn terminal_login(
        &self,
        cwd: &str,
        launch: &AcpLaunch,
        method_id: &str,
    ) -> Result<AcpLaunch, String> {
        self.terminal_login_with(cwd, launch, method_id, |_| true)
    }

    /// [`Self::terminal_login`], handing the short-lived agent to `on_spawned`
    /// first, which says whether to go on (false: the sign-in was cancelled).
    pub fn terminal_login_with(
        &self,
        cwd: &str,
        launch: &AcpLaunch,
        method_id: &str,
        on_spawned: impl FnOnce(Arc<AcpConnection>) -> bool,
    ) -> Result<AcpLaunch, String> {
        validate_cwd(cwd)?;
        let connection = spawn_unrouted(cwd, launch, |_, _| {})?;
        if !on_spawned(Arc::clone(&connection)) {
            connection.kill();
            return Err(CANCELLED_MESSAGE.to_string());
        }
        let init = initialize(&connection)
            .map_err(|message| failure_message(&connection, OpenError::Transport(message)))?;
        connection.kill();
        match terminal_method(&init, method_id) {
            Ok(method) => Ok(login_command(launch, &method)),
            Err(TerminalMethodError::NotOffered) => {
                Err(auth_required_error(&auth_methods_of(&init)))
            }
            Err(TerminalMethodError::Refused(message)) => Err(message),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offered(method: Value) -> Value {
        json!({ "authMethods": [method] })
    }

    fn refusal(reason: &str) -> TerminalMethodError {
        TerminalMethodError::Refused(format!("{REFUSED_PREFIX}{reason}"))
    }

    #[test]
    fn reads_a_terminal_method() {
        let init = offered(
            json!({"id": "t", "type": "terminal", "args": ["--login"], "env": {"A_B": "1"}}),
        );
        let method = terminal_method(&init, "t").unwrap();
        assert_eq!(method.args, vec!["--login"]);
        assert_eq!(method.env, BTreeMap::from([("A_B".into(), "1".into())]));

        let bare = offered(json!({"id": "t", "type": "terminal"}));
        let method = terminal_method(&bare, "t").unwrap();
        assert!(method.args.is_empty());
        assert!(method.env.is_empty());
    }

    #[test]
    fn an_agent_method_or_unknown_id_is_not_offered() {
        let agent = offered(json!({"id": "t"}));
        assert_eq!(
            terminal_method(&agent, "t"),
            Err(TerminalMethodError::NotOffered)
        );
        let terminal = offered(json!({"id": "t", "type": "terminal"}));
        assert_eq!(
            terminal_method(&terminal, "other"),
            Err(TerminalMethodError::NotOffered)
        );
        assert_eq!(
            terminal_method(&json!({}), "t"),
            Err(TerminalMethodError::NotOffered)
        );
    }

    #[test]
    fn refuses_unsafe_methods() {
        let many: Vec<String> = (0..33).map(|i| i.to_string()).collect();
        let cases = [
            (json!({"args": many}), "it passes more than 32 arguments"),
            (
                json!({"args": ["x".repeat(1025)]}),
                "an argument is longer than 1024 bytes",
            ),
            (
                json!({"args": ["a\0b"]}),
                "an argument contains a NUL character",
            ),
            (json!({"args": "x"}), "its arguments are not a list of text"),
            (json!({"args": [1]}), "its arguments are not a list of text"),
            (json!({"env": {"PATH": "/x"}}), "it sets PATH"),
            (
                json!({"env": {"DYLD_INSERT_LIBRARIES": "x"}}),
                "it sets DYLD_INSERT_LIBRARIES",
            ),
            (
                json!({"env": {"NODE_OPTIONS": "x"}}),
                "it sets NODE_OPTIONS",
            ),
            (json!({"env": {"lower": "x"}}), "it sets lower"),
            (
                json!({"env": {"A": 1}}),
                "its environment is not a map of text",
            ),
            (
                json!({"env": ["A"]}),
                "its environment is not a map of text",
            ),
            (
                json!({"env": {"A": "x\0y"}}),
                "a variable contains a NUL character",
            ),
        ];
        for (extra, reason) in cases {
            let mut method = json!({"id": "t", "type": "terminal"});
            method
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert_eq!(
                terminal_method(&offered(method), "t"),
                Err(refusal(reason)),
                "{reason}"
            );
        }
    }

    #[test]
    fn login_command_appends_args_and_overrides_env() {
        let launch = AcpLaunch {
            program: "npx".into(),
            args: vec!["-y".into(), "pkg@1".into()],
            env: vec![("A".into(), "base".into()), ("B".into(), "keep".into())],
        };
        let method = TerminalMethod {
            args: vec!["--cli".into(), "auth".into(), "login".into()],
            env: BTreeMap::from([("A".into(), "method".into())]),
        };
        let login = login_command(&launch, &method);
        assert_eq!(login.program, "npx");
        assert_eq!(login.args, vec!["-y", "pkg@1", "--cli", "auth", "login"]);
        assert_eq!(login.env.iter().filter(|(k, _)| k == "A").count(), 1);
        assert!(login.env.contains(&("A".into(), "method".into())));
        assert!(login.env.contains(&("B".into(), "keep".into())));
    }

    #[test]
    fn sign_in_ids() {
        assert!(is_sign_in_terminal_id("signin-1729150000000-k3x9a"));
        assert!(is_sign_in_terminal_id(&format!(
            "signin-{}",
            "a".repeat(64)
        )));
        for bad in ["session-1", "signin-", "signin-A", "signin-../x"] {
            assert!(!is_sign_in_terminal_id(bad), "{bad}");
        }
        assert!(!is_sign_in_terminal_id(&format!(
            "signin-{}",
            "a".repeat(65)
        )));
    }

    #[test]
    fn event_payloads() {
        let output = PtyEvent::Output {
            session_id: "signin-1".into(),
            data: "hi".into(),
        };
        assert_eq!(
            sign_in_event_payload(&output),
            json!({"terminalId": "signin-1", "kind": "output", "data": "hi"})
        );
        let exit = PtyEvent::Exit {
            session_id: "signin-1".into(),
            exit_code: 3,
        };
        assert_eq!(
            sign_in_event_payload(&exit),
            json!({"terminalId": "signin-1", "kind": "exit", "exitCode": 3})
        );
    }

    #[test]
    fn a_terminal_method_is_found_after_another_method_with_its_id() {
        let init = json!({"authMethods": [
            {"id": "login", "name": "In the agent"},
            {"id": "login", "name": "In a terminal", "type": "terminal", "args": ["--x"]},
        ]});

        let method = terminal_method(&init, "login").expect("the terminal method is offered");

        assert_eq!(method.args, vec!["--x".to_string()]);
    }

    #[test]
    fn a_sign_in_id_is_used_by_one_attempt_at_a_time() {
        let attempts = SignInAttempts::default();
        attempts.begin("signin-1").expect("first");

        assert_eq!(
            attempts.begin("signin-1").unwrap_err(),
            "That sign-in is already running"
        );
        attempts.end("signin-1");
        assert!(attempts.begin("signin-1").is_ok());
    }

    #[test]
    fn a_cancelled_attempt_says_so_until_it_ends() {
        let attempts = SignInAttempts::default();
        attempts.begin("signin-1").expect("begin");

        attempts.cancel("signin-1");

        assert!(attempts.is_cancelled("signin-1"));
        attempts.end("signin-1");
        assert!(!attempts.is_cancelled("signin-1"));
    }

    #[test]
    fn cancelling_an_unknown_attempt_does_nothing() {
        let attempts = SignInAttempts::default();

        attempts.cancel("signin-1");

        assert!(!attempts.is_cancelled("signin-1"));
        assert!(attempts.begin("signin-1").is_ok());
    }
}
