//! Tauri commands and the event bridge for ACP sessions.
//!
//! The webview names a profile; the backend decides which program runs, from
//! the detected profile, with the user's login-shell environment.

use std::collections::BTreeMap;

use serde_json::{json, Value};
use tauri::State;

use super::manager::{AcpEvent, AcpLaunch, AcpManager, StartedSession};
use super::probe::ProbedAgent;
use crate::env_resolver::cached_user_env;
use crate::files::ensure_known_workspace;
use crate::profiles::{agent_profiles, TRANSPORT_ACP};
use crate::registry::{
    self,
    resolve::{canonical_agent_id, missing_reason},
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
    let id = canonical_agent_id(profile_id);
    let profile = agent_profiles(versions)
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("Unknown agent profile '{}'", profile_id))?;
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
    // A GUI app does not inherit the login shell's PATH, so hand the agent the
    // user's real environment (nvm, Homebrew, ...) with the dirs of Zorvo's
    // runtimes and prerequisites around its PATH, then the variables the
    // registry sets for this version.
    let mut env: BTreeMap<String, String> = cached_user_env()
        .map(|m| m.into_iter().collect())
        .unwrap_or_default();
    // Without the login shell's env, fall back to the process PATH (as
    // `agent_profiles` does) rather than leave the agent only Zorvo's dirs.
    let process_path = std::env::var("PATH").ok();
    if let Some(path) = agent_path(
        &profile.acp_path_prepend,
        env.get("PATH").map(String::as_str),
        process_path.as_deref(),
        &profile.acp_path_append,
    ) {
        env.insert("PATH".to_string(), path);
    }
    if let Some(version) = &profile.version {
        env.extend(registry::catalog().launch_env(&profile.id, version));
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
    let versions = store
        .load_state()
        .map(|state| state.settings.agent_versions)
        .unwrap_or_else(|error| {
            eprintln!("Could not read the agent versions in use: {error}");
            BTreeMap::new()
        });
    launch_for(profile_id, &versions)
}

#[tauri::command(async)]
pub fn acp_start_session(
    manager: State<'_, AcpManager>,
    store: State<'_, AppStore>,
    session_id: String,
    cwd: String,
    profile_id: String,
) -> Result<StartedSession, String> {
    manager.start(&session_id, &cwd, &launch_with_store(&store, &profile_id)?)
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
    // It runs the agent in `cwd`, so only in one of the user's own folders.
    ensure_known_workspace(&cwd, |path| store.is_known_workspace(path))?;
    manager.probe(
        &cwd,
        &launch_with_store(&store, &profile_id)?,
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
    manager.authenticate(&cwd, &launch_with_store(&store, &profile_id)?, &method_id)
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
        &launch_with_store(&store, &profile_id)?,
        &acp_session_id,
    )
}

#[tauri::command(async)]
pub fn acp_fork_session(
    manager: State<'_, AcpManager>,
    source_session_id: String,
    session_id: String,
    cwd: String,
) -> Result<StartedSession, String> {
    manager.fork(&source_session_id, &session_id, &cwd)
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
    use super::*;

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

    #[test]
    fn launching_a_terminal_only_agent_over_acp_is_refused() {
        let none = BTreeMap::new();
        let err = launch_for("omp", &none).unwrap_err();
        assert!(err.contains("does not support"), "unexpected: {err}");
        assert!(launch_for("no-such-agent", &none)
            .unwrap_err()
            .contains("Unknown"));
    }

    #[test]
    fn a_legacy_id_launches_its_registry_agent() {
        match launch_for("claude-code", &BTreeMap::new()) {
            Ok(launch) => assert!(
                launch
                    .args
                    .iter()
                    .any(|a| a.starts_with("@agentclientprotocol/claude-agent-acp@")),
                "{:?}",
                launch.args
            ),
            // Without Node.js the registry agent is found but cannot run.
            Err(error) => assert!(error.contains("Node.js"), "unexpected: {error}"),
        }
    }
}
