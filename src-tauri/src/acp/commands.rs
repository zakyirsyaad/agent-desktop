//! Tauri commands and the event bridge for ACP sessions.
//!
//! The webview names a profile; the backend decides which program runs, from
//! the detected profile, with the user's login-shell environment.

use serde_json::{json, Value};
use tauri::State;

use super::manager::{AcpEvent, AcpLaunch, AcpManager, StartedSession};
use crate::env_resolver::cached_user_env;
use crate::profiles::{get_available_agent_profiles, TRANSPORT_ACP};

/// The single event channel the UI listens on for every ACP session.
pub const ACP_EVENT: &str = "acp-event";

/// The JSON the UI receives for one manager event.
pub fn event_payload(event: &AcpEvent) -> Value {
    match event {
        AcpEvent::Update { session_id, update } => {
            json!({ "sessionId": session_id, "kind": "update", "update": update })
        }
        AcpEvent::PermissionRequest { session_id, request_id, params } => json!({
            "sessionId": session_id,
            "kind": "permission",
            "requestId": request_id,
            "toolCall": params["toolCall"],
            "options": params["options"],
        }),
        AcpEvent::TurnEnded { session_id, stop_reason } => match stop_reason {
            Ok(reason) => json!({ "sessionId": session_id, "kind": "turn-end", "stopReason": reason }),
            Err(error) => json!({ "sessionId": session_id, "kind": "turn-end", "error": error }),
        },
        AcpEvent::Exited { session_id, code } => {
            json!({ "sessionId": session_id, "kind": "exit", "code": code })
        }
    }
}

/// Resolves how to launch an installed ACP agent for `profile_id`.
fn launch_for(profile_id: &str) -> Result<AcpLaunch, String> {
    let profile = get_available_agent_profiles()
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Unknown agent profile '{}'", profile_id))?;
    if profile.transport != TRANSPORT_ACP {
        return Err(format!("{} does not support the Agent Client Protocol", profile.name));
    }
    if !profile.detected {
        return Err(format!("{} is not installed", profile.name));
    }
    let program = profile
        .acp_program_path
        .ok_or_else(|| format!("Could not locate the program that runs {}", profile.name))?;
    // A GUI app does not inherit the login shell's PATH, so hand the agent the
    // user's real environment (nvm, Homebrew, ...).
    let env = cached_user_env().map(|m| m.into_iter().collect()).unwrap_or_default();
    Ok(AcpLaunch { program, args: profile.acp_args, env })
}

#[tauri::command(async)]
pub fn acp_start_session(
    manager: State<'_, AcpManager>,
    session_id: String,
    cwd: String,
    profile_id: String,
) -> Result<StartedSession, String> {
    manager.start(&session_id, &cwd, &launch_for(&profile_id)?)
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
pub fn acp_prompt(manager: State<'_, AcpManager>, session_id: String, text: String) -> Result<(), String> {
    manager.prompt(&session_id, &text)
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
pub fn acp_set_mode(manager: State<'_, AcpManager>, session_id: String, mode_id: String) -> Result<(), String> {
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
        let ok = event_payload(&AcpEvent::TurnEnded { session_id: "s".into(), stop_reason: Ok("end_turn".into()) });
        assert_eq!(ok["stopReason"], "end_turn");

        let failed = event_payload(&AcpEvent::TurnEnded { session_id: "s".into(), stop_reason: Err("boom".into()) });
        assert_eq!(failed["error"], "boom");
        assert!(failed.get("stopReason").is_none());
    }

    #[test]
    fn launching_a_terminal_only_agent_over_acp_is_refused() {
        let err = launch_for("omp").unwrap_err();
        assert!(err.contains("does not support"), "unexpected: {err}");
        assert!(launch_for("no-such-agent").unwrap_err().contains("Unknown"));
    }
}
