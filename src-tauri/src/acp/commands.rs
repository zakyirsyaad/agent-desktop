//! Tauri commands and the event bridge for ACP sessions.
//!
//! The webview names a profile; the backend decides which program runs, from
//! the detected profile, with the user's login-shell environment.

use std::collections::BTreeMap;

use serde_json::{json, Value};
use tauri::State;

use super::manager::{AcpEvent, AcpLaunch, AcpManager, StartedSession};
use super::probe::ProbedAgent;
use super::terminal_auth::{is_sign_in_terminal_id, CANCELLED_MESSAGE};
use crate::env_resolver::cached_user_env;
use crate::files::ensure_known_workspace;
use crate::installer::commands::versions_in_use;
use crate::profiles::{agent_profile_from, with_system_tools, AgentProfile};
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
        AcpEvent::Elicitation {
            session_id,
            key,
            view,
        } => json!({ "sessionId": session_id, "kind": "elicitation", "key": key, "request": view }),
        AcpEvent::ElicitationComplete { session_id, key } => {
            json!({ "sessionId": session_id, "kind": "elicitation-complete", "key": key })
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
    // Stands in for the login shell's PATH when that could not be read.
    let process_path = std::env::var("PATH").ok();
    launch_from(profile, user_env, process_path.as_deref(), |id, version| {
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
    let id = canonical_agent_id(profile_id);
    agent_profile_from(catalog, tools, id, versions, now).ok_or_else(|| {
        match catalog.unsupported_agent_name(id, versions, now) {
            Some(name) => format!("{name} is not available for this Mac"),
            None => format!("Unknown agent profile '{profile_id}'"),
        }
    })
}

/// How to launch `profile` over ACP, or why it cannot run. The agent gets
/// `user_env` with the profile's dirs around its `PATH` (`process_path` when
/// `user_env` has none), and then the variables `registry_env` gives for its
/// id and version; both are read only once the profile can run.
fn launch_from(
    profile: AgentProfile,
    user_env: impl FnOnce() -> BTreeMap<String, String>,
    process_path: Option<&str>,
    registry_env: impl FnOnce(&str, &str) -> BTreeMap<String, String>,
) -> Result<AcpLaunch, String> {
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
    // Zorvo's runtime and prerequisite dirs go around the user's PATH. Without
    // the login shell's env, the process PATH stands in (as in
    // `agent_profiles`) rather than leave the agent only Zorvo's dirs.
    if let Some(path) = agent_path(
        &profile.acp_path_prepend,
        env.get("PATH").map(String::as_str),
        process_path,
        &profile.acp_path_append,
    ) {
        env.insert("PATH".to_string(), path);
    }
    if let Some(version) = &profile.version {
        env.extend(registry_env(&profile.id, version));
    }
    Ok(AcpLaunch {
        program,
        args: profile.acp_args,
        env: env.into_iter().collect(),
    })
}

/// `prepend`, the user's `PATH` entries, then `append`, joined with `:`;
/// `None` when there is nothing to add, so the user's `PATH` is left alone.
/// Without the login shell's `PATH` the process `PATH` stands in (as in
/// `agent_profiles`), so the agent still finds `git` and `sh`.
fn agent_path(
    prepend: &[String],
    login_path: Option<&str>,
    process_path: Option<&str>,
    append: &[String],
) -> Option<String> {
    if prepend.is_empty() && append.is_empty() {
        return None;
    }
    let user_entries = login_path
        .or(process_path)
        .unwrap_or_default()
        .split(':')
        .filter(|entry| !entry.is_empty());
    let entries: Vec<&str> = prepend
        .iter()
        .map(String::as_str)
        .chain(user_entries)
        .chain(append.iter().map(String::as_str))
        .collect();
    Some(entries.join(":"))
}

/// [`launch_for`] at the versions the user has in use.
fn launch_with_store(store: &AppStore, profile_id: &str) -> Result<AcpLaunch, String> {
    launch_for(profile_id, &versions_in_use(store))
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
    let attempts = manager.sign_ins();
    attempts.begin(terminal_id)?;
    let result = launch_in_workspace(store, cwd, profile_id)
        .and_then(|launch| {
            manager.terminal_login_with(cwd, &launch, method_id, |connection| {
                attempts.track(terminal_id, connection)
            })
        })
        .and_then(|login| {
            if attempts.is_cancelled(terminal_id) {
                return Err(CANCELLED_MESSAGE.to_string());
            }
            pty.start_session(terminal_id, cwd, &login.program, &login.args, &login.env)
        });
    // Whatever went wrong, a sign-in the user cancelled reads as cancelled.
    let result = match result {
        Err(_) if attempts.is_cancelled(terminal_id) => Err(CANCELLED_MESSAGE.to_string()),
        other => other,
    };
    attempts.end(terminal_id);
    result
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

/// Cancels a terminal sign-in that is still starting: the agent it reads the
/// method from is ended and no terminal starts. A running login is ended with
/// `terminate_session` instead.
#[tauri::command(async)]
pub fn acp_cancel_terminal_sign_in(manager: State<'_, AcpManager>, terminal_id: String) {
    manager.sign_ins().cancel(&terminal_id);
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
    use crate::installer::{plan::InstalledTools, runtimes::MIN_USER_NODE_MAJOR};
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
    fn elicitation_events_carry_the_key_and_view() {
        let request = event_payload(&AcpEvent::Elicitation {
            session_id: "s-1".into(),
            key: "el-3".into(),
            view: json!({ "mode": "form", "message": "Name?", "fields": [] }),
        });
        assert_eq!(
            request,
            json!({ "sessionId": "s-1", "kind": "elicitation", "key": "el-3",
                    "request": { "mode": "form", "message": "Name?", "fields": [] } })
        );

        let complete = event_payload(&AcpEvent::ElicitationComplete {
            session_id: "s-1".into(),
            key: "el-4".into(),
        });
        assert_eq!(
            complete,
            json!({ "sessionId": "s-1", "kind": "elicitation-complete", "key": "el-4" })
        );
    }

    #[test]
    fn agent_path_puts_zorvos_dirs_around_the_users_path() {
        let node = vec!["/zorvo/node/bin".to_string()];
        let extras = vec!["/zorvo/uv".to_string(), "/zorvo/pi/bin".to_string()];

        assert_eq!(agent_path(&[], Some("/usr/bin:/bin"), None, &[]), None);
        assert_eq!(
            agent_path(&node, Some("/usr/bin:/bin"), Some("/ignored"), &extras).as_deref(),
            Some("/zorvo/node/bin:/usr/bin:/bin:/zorvo/uv:/zorvo/pi/bin")
        );
        assert_eq!(
            agent_path(&[], None, None, &extras).as_deref(),
            Some("/zorvo/uv:/zorvo/pi/bin")
        );
    }

    #[test]
    fn without_the_login_shell_env_the_agent_keeps_the_process_path() {
        let node = vec!["/zorvo/node/bin".to_string()];

        assert_eq!(
            agent_path(&node, None, Some("/usr/bin:/bin"), &[]).as_deref(),
            Some("/zorvo/node/bin:/usr/bin:/bin")
        );
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

        let err = launch_in_workspace(&store, &scratch.folder(), "claude-acp").unwrap_err();

        assert!(
            err.contains("is not one of your workspaces"),
            "unexpected: {err}"
        );
    }

    #[test]
    fn a_remembered_workspace_passes_the_folder_check() {
        let scratch = Scratch::new("remembered");
        let store = scratch.store();
        store
            .remember_workspace(&scratch.folder())
            .expect("remember the folder");

        let err = launch_in_workspace(&store, &scratch.folder(), "no-such-agent").unwrap_err();

        assert!(
            err.contains("Unknown agent profile 'no-such-agent'"),
            "unexpected: {err}"
        );
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

    /// A ready registry agent run through Zorvo's Node, whose `bin` goes first on `PATH`.
    fn agent_on_zorvos_node() -> AgentProfile {
        let mut profile = AgentProfile::new(
            "gemini".to_string(),
            "Gemini CLI".to_string(),
            "npx".to_string(),
        );
        profile.detected = true;
        profile.acp_program_path = Some("/zorvo/node/bin/npx".to_string());
        profile.acp_path_prepend = vec!["/zorvo/node/bin".to_string()];
        profile
    }

    fn path_of(launch: &AcpLaunch) -> Option<&str> {
        launch
            .env
            .iter()
            .find(|(key, _)| key == "PATH")
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn a_launch_puts_the_prepend_dir_first_on_the_users_path() {
        let user_env = || BTreeMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())]);

        let launch = launch_from(
            agent_on_zorvos_node(),
            user_env,
            Some("/ignored"),
            |_, _| BTreeMap::new(),
        )
        .expect("it launches");

        assert_eq!(path_of(&launch), Some("/zorvo/node/bin:/usr/bin:/bin"));
    }

    #[test]
    fn a_launch_without_the_login_path_falls_back_to_the_process_path() {
        let launch = launch_from(
            agent_on_zorvos_node(),
            BTreeMap::new,
            Some("/usr/bin:/bin"),
            |_, _| BTreeMap::new(),
        )
        .expect("it launches");

        assert_eq!(path_of(&launch), Some("/zorvo/node/bin:/usr/bin:/bin"));
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
        // The user's own Node is new enough, so their `npx` runs the agent.
        let installed = InstalledTools {
            user_node_major: Some(MIN_USER_NODE_MAJOR),
            ..InstalledTools::none()
        };
        let tools = SystemTools {
            path_var: Some(&path),
            npm_globals: &npm,
            installed: &installed,
        };

        let profile =
            profile_to_launch(&catalog, &tools, "claude-code", &BTreeMap::new(), FIXED_NOW)
                .expect("claude-code is known");
        assert_eq!(profile.id, "claude-acp");
        let launch = launch_from(profile, BTreeMap::new, None, |id, version| {
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
        let installed = InstalledTools::none();
        let tools = SystemTools {
            path_var: Some(""),
            npm_globals: &npm,
            installed: &installed,
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

    #[test]
    fn an_agent_not_built_for_this_mac_is_refused_by_name() {
        use crate::registry::schema::{BinaryTarget, Distribution, RegistryEntry};

        let entry = RegistryEntry {
            id: "linuxy".into(),
            name: "Linuxy".into(),
            version: "1.0.0".into(),
            description: None,
            icon: None,
            distribution: Distribution::Binary {
                platforms: BTreeMap::from([(
                    "linux-x86_64".to_string(),
                    BinaryTarget {
                        archive: "https://example.com/linuxy.tar.gz".into(),
                        cmd: "./linuxy".into(),
                        args: Vec::new(),
                        sha256: "a".repeat(64),
                        env: BTreeMap::new(),
                    },
                )]),
            },
        };
        let mut history = crate::registry::history::VersionHistory::default();
        history.observe(std::slice::from_ref(&entry), 1);
        let catalog = Catalog::bundled(&history.to_json());
        let npm = BTreeSet::new();
        let installed = InstalledTools::none();
        let tools = SystemTools {
            path_var: Some(""),
            npm_globals: &npm,
            installed: &installed,
        };

        let err =
            profile_to_launch(&catalog, &tools, "linuxy", &BTreeMap::new(), FIXED_NOW).unwrap_err();

        assert_eq!(err, "Linuxy is not available for this Mac");
    }
}
