//! Tauri commands and the event bridge for ACP sessions.
//!
//! The webview names a profile; the backend decides which program runs, from
//! the detected profile, with the user's login-shell environment.

use std::collections::BTreeMap;

use serde_json::{json, Value};
use tauri::State;

use super::manager::{AcpEvent, AcpLaunch, AcpManager, StartedSession};
use super::probe::ProbedAgent;
use super::terminal_auth::is_sign_in_terminal_id;
use crate::env_resolver::cached_user_env;
use crate::files::ensure_known_workspace;
use crate::profiles::{agent_profile_from, with_system_tools, AgentProfile, TRANSPORT_ACP};
use crate::pty_session::PtySessionManager;
use crate::registry::{
    self,
    resolve::{canonical_agent_id, missing_reason, SystemTools},
};
use crate::store::AppStore;

/// The single event channel the UI listens on for every ACP session.
pub const ACP_EVENT: &str = "acp-event";

/// The JSON the UI receives for one manager event.
pub fn event_payload(event: &AcpEvent) -> Value {
    match event {
        AcpEvent::Update { session_id, update } => {
            json!({ "sessionId": session_id, "kind": "update", "update": update })
        }
        AcpEvent::PermissionRequest {
            session_id,
            request_id,
            params,
        } => json!({
            "sessionId": session_id,
            "kind": "permission",
            "requestId": request_id,
            "toolCall": params["toolCall"],
            "options": params["options"],
        }),
        AcpEvent::TurnEnded {
            session_id,
            stop_reason,
        } => match stop_reason {
            Ok(reason) => {
                json!({ "sessionId": session_id, "kind": "turn-end", "stopReason": reason })
            }
            Err(error) => json!({ "sessionId": session_id, "kind": "turn-end", "error": error }),
        },
        AcpEvent::Exited { session_id, code } => {
            json!({ "sessionId": session_id, "kind": "exit", "code": code })
        }
    }
}

/// Resolves how to launch an installed ACP agent for `profile_id` (a legacy
/// id is mapped first), at the version in `versions` when the catalog has it.
fn launch_for(profile_id: &str, versions: &BTreeMap<String, String>) -> Result<AcpLaunch, String> {
    let profile = with_system_tools(|catalog, tools| {
        profile_to_launch(catalog, tools, profile_id, versions, registry::unix_now())
    })?;
    // A GUI app does not inherit the login shell's PATH, so hand the agent the
    // user's real environment (nvm, Homebrew, ...).
    let user_env = || {
        cached_user_env()
            .map(|m| m.into_iter().collect())
            .unwrap_or_default()
    };
    launch_from(profile, user_env, |id, version| {
        registry::catalog().launch_env(id, version)
    })
}

/// The profile that launches `profile_id` (a legacy id is mapped first) from
/// `catalog` and `tools` at time `now`.
fn profile_to_launch(
    catalog: &registry::Catalog,
    tools: &SystemTools,
    profile_id: &str,
    versions: &BTreeMap<String, String>,
    now: u64,
) -> Result<AgentProfile, String> {
    agent_profile_from(
        catalog,
        tools,
        canonical_agent_id(profile_id),
        versions,
        now,
    )
    .ok_or_else(|| format!("Unknown agent profile '{profile_id}'"))
}

/// How to launch `profile` over ACP, or why it cannot run. The agent gets
/// `user_env` and then the variables `registry_env` gives for its id and
/// version; both are read only once the profile can run.
fn launch_from(
    profile: AgentProfile,
    user_env: impl FnOnce() -> BTreeMap<String, String>,
    registry_env: impl FnOnce(&str, &str) -> BTreeMap<String, String>,
) -> Result<AcpLaunch, String> {
    if profile.transport != TRANSPORT_ACP {
        return Err(format!(
            "{} does not support the Agent Client Protocol",
            profile.name
        ));
    }
    if let Some(reason) = missing_reason(&profile) {
        return Err(reason);
    }
    if !profile.detected {
        return Err(format!("{} is not installed", profile.name));
    }
    let program = profile
        .acp_program_path
        .ok_or_else(|| format!("Could not locate the program that runs {}", profile.name))?;
    let mut env = user_env();
    if let Some(version) = &profile.version {
        env.extend(registry_env(&profile.id, version));
    }
    Ok(AcpLaunch {
        program,
        args: profile.acp_args,
        env: env.into_iter().collect(),
    })
}

/// [`launch_for`] at the versions the user has in use.
fn launch_with_store(store: &AppStore, profile_id: &str) -> Result<AcpLaunch, String> {
    let versions = store
        .load_state()
        .map(|state| state.settings.agent_versions)
        .unwrap_or_else(|error| {
            eprintln!("Could not read the agent versions in use: {error}");
            BTreeMap::new()
        });
    launch_for(profile_id, &versions)
}

/// [`launch_with_store`] for an agent that runs in `cwd`, which must be one of
/// the user's workspaces: a folder they opened, a session's folder or a
/// session worktree (remembered when it is made).
fn launch_in_workspace(store: &AppStore, cwd: &str, profile_id: &str) -> Result<AcpLaunch, String> {
    ensure_known_workspace(cwd, |path| store.is_known_workspace(path))?;
    launch_with_store(store, profile_id)
}

#[tauri::command(async)]
pub fn acp_start_session(
    manager: State<'_, AcpManager>,
    store: State<'_, AppStore>,
    session_id: String,
    cwd: String,
    profile_id: String,
) -> Result<StartedSession, String> {
    manager.start(
        &session_id,
        &cwd,
        &launch_in_workspace(&store, &cwd, &profile_id)?,
    )
}

/// Learns what an agent offers (modes, models, efforts, commands) before a
/// session starts, or that it needs a sign-in first. `needs_options` is for an
/// agent whose options are not known yet; otherwise the sign-in is what is checked.
#[tauri::command(async)]
pub fn acp_probe_agent(
    manager: State<'_, AcpManager>,
    store: State<'_, AppStore>,
    profile_id: String,
    cwd: String,
    needs_options: bool,
) -> Result<ProbedAgent, String> {
    manager.probe(
        &cwd,
        &launch_in_workspace(&store, &cwd, &profile_id)?,
        needs_options,
    )
}

/// Signs in to an agent with one of the auth methods it reported.
#[tauri::command(async)]
pub fn acp_authenticate(
    manager: State<'_, AcpManager>,
    store: State<'_, AppStore>,
    profile_id: String,
    cwd: String,
    method_id: String,
) -> Result<(), String> {
    manager.authenticate(
        &cwd,
        &launch_in_workspace(&store, &cwd, &profile_id)?,
        &method_id,
    )
}

/// Resumes the agent's earlier session `acp_session_id` as app session `session_id`.
#[tauri::command(async)]
pub fn acp_load_session(
    manager: State<'_, AcpManager>,
    store: State<'_, AppStore>,
    session_id: String,
    cwd: String,
    profile_id: String,
    acp_session_id: String,
) -> Result<StartedSession, String> {
    manager.load(
        &session_id,
        &cwd,
        &launch_in_workspace(&store, &cwd, &profile_id)?,
        &acp_session_id,
    )
}

/// Forks `source_session_id` into `session_id` in `cwd`, which must be one of
/// the user's workspaces (the source's folder or worktree is).
fn fork_in_workspace(
    manager: &AcpManager,
    store: &AppStore,
    source_session_id: &str,
    session_id: &str,
    cwd: &str,
) -> Result<StartedSession, String> {
    ensure_known_workspace(cwd, |path| store.is_known_workspace(path))?;
    manager.fork(source_session_id, session_id, cwd)
}

#[tauri::command(async)]
pub fn acp_fork_session(
    manager: State<'_, AcpManager>,
    store: State<'_, AppStore>,
    source_session_id: String,
    session_id: String,
    cwd: String,
) -> Result<StartedSession, String> {
    fork_in_workspace(&manager, &store, &source_session_id, &session_id, &cwd)
}

/// Runs the sign-in command of `profile_id`'s terminal method `method_id` in a
/// PTY named `terminal_id`, in `cwd`, which must be one of the user's workspaces.
fn start_terminal_sign_in(
    manager: &AcpManager,
    pty: &PtySessionManager,
    store: &AppStore,
    profile_id: &str,
    cwd: &str,
    method_id: &str,
    terminal_id: &str,
) -> Result<(), String> {
    if !is_sign_in_terminal_id(terminal_id) {
        return Err("Not a sign-in terminal id".to_string());
    }
    if pty.has_session(terminal_id) {
        return Err("That sign-in is already running".to_string());
    }
    let launch = launch_in_workspace(store, cwd, profile_id)?;
    let login = manager.terminal_login(cwd, &launch, method_id)?;
    pty.start_session(terminal_id, cwd, &login.program, &login.args, &login.env)
}

#[tauri::command(async)]
pub fn acp_start_terminal_sign_in(
    manager: State<'_, AcpManager>,
    pty: State<'_, PtySessionManager>,
    store: State<'_, AppStore>,
    profile_id: String,
    cwd: String,
    method_id: String,
    terminal_id: String,
) -> Result<(), String> {
    start_terminal_sign_in(
        &manager,
        &pty,
        &store,
        &profile_id,
        &cwd,
        &method_id,
        &terminal_id,
    )
}

#[tauri::command(async)]
pub fn acp_prompt(
    manager: State<'_, AcpManager>,
    session_id: String,
    text: String,
    attachments: Option<Vec<String>>,
) -> Result<(), String> {
    manager.prompt(&session_id, &text, &attachments.unwrap_or_default())
}

#[tauri::command(async)]
pub fn acp_cancel(manager: State<'_, AcpManager>, session_id: String) -> Result<(), String> {
    manager.cancel(&session_id)
}

#[tauri::command(async)]
pub fn acp_respond_permission(
    manager: State<'_, AcpManager>,
    session_id: String,
    request_id: Value,
    option_id: Option<String>,
) -> Result<(), String> {
    manager.respond_permission(&session_id, &request_id, option_id.as_deref())
}

#[tauri::command(async)]
pub fn acp_set_mode(
    manager: State<'_, AcpManager>,
    session_id: String,
    mode_id: String,
) -> Result<(), String> {
    manager.set_mode(&session_id, &mode_id)
}

#[tauri::command(async)]
pub fn acp_set_config_option(
    manager: State<'_, AcpManager>,
    session_id: String,
    config_id: String,
    value: String,
) -> Result<Value, String> {
    manager.set_config_option(&session_id, &config_id, &value)
}

#[tauri::command(async)]
pub fn acp_stop_session(manager: State<'_, AcpManager>, session_id: String) {
    manager.stop(&session_id);
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::os::unix::fs::PermissionsExt;

    use super::*;
    use crate::registry::{resolve::SystemTools, Catalog, BUNDLED_HISTORY};

    #[test]
    fn update_events_carry_the_raw_update() {
        let payload = event_payload(&AcpEvent::Update {
            session_id: "s-1".into(),
            update: json!({ "sessionUpdate": "agent_message_chunk" }),
        });

        assert_eq!(payload["kind"], "update");
        assert_eq!(payload["sessionId"], "s-1");
        assert_eq!(payload["update"]["sessionUpdate"], "agent_message_chunk");
    }

    #[test]
    fn permission_events_carry_the_request_id_tool_call_and_options() {
        let payload = event_payload(&AcpEvent::PermissionRequest {
            session_id: "s-1".into(),
            request_id: json!("perm-1"),
            params: json!({ "toolCall": { "title": "Run ls" }, "options": [{ "optionId": "allow" }] }),
        });

        assert_eq!(payload["kind"], "permission");
        assert_eq!(payload["requestId"], "perm-1");
        assert_eq!(payload["toolCall"]["title"], "Run ls");
        assert_eq!(payload["options"][0]["optionId"], "allow");
    }

    #[test]
    fn turn_end_events_report_the_stop_reason_or_the_error() {
        let ok = event_payload(&AcpEvent::TurnEnded {
            session_id: "s".into(),
            stop_reason: Ok("end_turn".into()),
        });
        assert_eq!(ok["stopReason"], "end_turn");

        let failed = event_payload(&AcpEvent::TurnEnded {
            session_id: "s".into(),
            stop_reason: Err("boom".into()),
        });
        assert_eq!(failed["error"], "boom");
        assert!(failed.get("stopReason").is_none());
    }

    #[test]
    fn launching_a_terminal_only_agent_over_acp_is_refused() {
        let none = BTreeMap::new();
        let err = launch_for("omp", &none).unwrap_err();
        assert!(err.contains("does not support"), "unexpected: {err}");
        assert!(launch_for("no-such-agent", &none)
            .unwrap_err()
            .contains("Unknown"));
    }

    /// A fresh store and an empty folder it does not know yet, both removed on drop.
    struct Scratch {
        root: std::path::PathBuf,
    }

    impl Scratch {
        fn new(tag: &str) -> Self {
            static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
            let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let root = std::env::temp_dir().join(format!(
                "zorvo-acp-commands-{tag}-{}-{unique}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join("data")).expect("data dir");
            std::fs::create_dir_all(root.join("folder")).expect("folder");
            Self { root }
        }

        fn store(&self) -> AppStore {
            AppStore::new(self.root.join("data"))
        }

        fn folder(&self) -> String {
            self.root.join("folder").to_string_lossy().to_string()
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn an_agent_is_not_launched_in_a_folder_that_is_not_a_workspace() {
        let scratch = Scratch::new("unknown");
        let store = scratch.store();

        let err = launch_in_workspace(&store, &scratch.folder(), "omp").unwrap_err();

        assert!(
            err.contains("is not one of your workspaces"),
            "unexpected: {err}"
        );
    }

    #[test]
    fn an_agent_is_launched_in_a_remembered_workspace() {
        let scratch = Scratch::new("known");
        let store = scratch.store();
        store
            .remember_workspace(&scratch.folder())
            .expect("remember");

        // Past the folder check, the terminal-only agent is refused for its transport.
        let err = launch_in_workspace(&store, &scratch.folder(), "omp").unwrap_err();

        assert!(err.contains("does not support"), "unexpected: {err}");
    }

    #[test]
    fn a_sign_in_with_a_bad_terminal_id_is_refused() {
        let scratch = Scratch::new("signin-bad-id");

        let err = start_terminal_sign_in(
            &quiet_manager(),
            &PtySessionManager::default_manager(),
            &scratch.store(),
            "claude-acp",
            &scratch.folder(),
            "terminal-login",
            "session-1",
        )
        .unwrap_err();

        assert_eq!(err, "Not a sign-in terminal id");
    }

    #[test]
    fn a_sign_in_is_not_started_in_a_folder_that_is_not_a_workspace() {
        let scratch = Scratch::new("signin-unknown");

        let err = start_terminal_sign_in(
            &quiet_manager(),
            &PtySessionManager::default_manager(),
            &scratch.store(),
            "claude-acp",
            &scratch.folder(),
            "terminal-login",
            "signin-1",
        )
        .unwrap_err();

        assert!(
            err.contains("is not one of your workspaces"),
            "unexpected: {err}"
        );
    }

    #[test]
    fn scratch_roots_are_unique_within_a_process() {
        let first = Scratch::new("same");
        let second = Scratch::new("same");

        assert_ne!(first.root, second.root);
    }

    fn quiet_manager() -> AcpManager {
        AcpManager::new(Box::new(|_| {}))
    }

    #[test]
    fn a_session_is_not_forked_into_a_folder_that_is_not_a_workspace() {
        let scratch = Scratch::new("fork-unknown");
        let store = scratch.store();

        let Err(err) = fork_in_workspace(
            &quiet_manager(),
            &store,
            "source",
            "fork",
            &scratch.folder(),
        ) else {
            panic!("the fork is refused");
        };

        assert!(
            err.contains("is not one of your workspaces"),
            "unexpected: {err}"
        );
    }

    #[test]
    fn a_session_is_forked_in_a_remembered_workspace() {
        let scratch = Scratch::new("fork-known");
        let store = scratch.store();
        store
            .remember_workspace(&scratch.folder())
            .expect("remember");

        // Past the folder check, the manager refuses an unknown source session.
        let Err(err) = fork_in_workspace(
            &quiet_manager(),
            &store,
            "source",
            "fork",
            &scratch.folder(),
        ) else {
            panic!("the fork is refused");
        };

        assert!(
            err.contains("Session 'source' not found"),
            "unexpected: {err}"
        );
    }

    /// Later than every version in the bundle, so each one is old enough.
    const FIXED_NOW: u64 = 4_000_000_000;

    #[test]
    fn a_legacy_id_launches_its_registry_agent() {
        let scratch = Scratch::new("legacy");
        let bin = scratch.root.join("bin");
        std::fs::create_dir_all(&bin).expect("bin dir");
        let npx = bin.join("npx");
        std::fs::write(&npx, "#!/bin/sh\n").expect("write fake npx");
        std::fs::set_permissions(&npx, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let catalog = Catalog::bundled(BUNDLED_HISTORY);
        let npm = BTreeSet::new();
        let path = bin.to_string_lossy().to_string();
        let tools = SystemTools {
            path_var: Some(&path),
            npm_globals: &npm,
        };

        let profile =
            profile_to_launch(&catalog, &tools, "claude-code", &BTreeMap::new(), FIXED_NOW)
                .expect("claude-code is known");
        assert_eq!(profile.id, "claude-acp");
        let launch = launch_from(profile, BTreeMap::new, |id, version| {
            catalog.launch_env(id, version)
        })
        .expect("it launches");

        assert_eq!(launch.program, npx.to_string_lossy());
        assert_eq!(launch.args.first().map(String::as_str), Some("-y"));
        assert!(
            launch
                .args
                .get(1)
                .is_some_and(|a| a.starts_with("@agentclientprotocol/claude-agent-acp@")),
            "{:?}",
            launch.args
        );
    }

    #[test]
    fn an_unknown_profile_id_is_named_in_the_error() {
        let catalog = Catalog::bundled(BUNDLED_HISTORY);
        let npm = BTreeSet::new();
        let tools = SystemTools {
            path_var: Some(""),
            npm_globals: &npm,
        };

        let err = profile_to_launch(
            &catalog,
            &tools,
            "no-such-agent",
            &BTreeMap::new(),
            FIXED_NOW,
        )
        .unwrap_err();

        assert!(
            err.contains("Unknown agent profile 'no-such-agent'"),
            "unexpected: {err}"
        );
    }
}
