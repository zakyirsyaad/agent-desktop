//! Translates the UI's session options into a concrete, validated spawn plan.
//!
//! This module is pure: no process spawning, no environment reads, no I/O. That
//! keeps every rule testable in isolation and makes it the single place that
//! decides what the backend is allowed to run. The webview picks a *profile id*
//! and a set of options; it never supplies a command or raw args.

use serde::{Deserialize, Serialize};

use crate::profiles::{AgentProfile, FORK_SUPPORT_NATIVE};

/// Placeholder in a profile's `resume_fork_args` template.
const SESSION_ID_PLACEHOLDER: &str = "{session_id}";

/// Shortest accepted session id, in characters.
const SESSION_ID_MIN_LEN: usize = 8;
/// Longest accepted session id, in characters.
const SESSION_ID_MAX_LEN: usize = 64;

/// What the UI asked for. All fields are optional and arrive as camelCase JSON.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    /// A model alias listed in `AgentProfile::models`.
    #[serde(default)]
    pub model: Option<String>,
    /// An `EffortLevel::label` from the profile.
    #[serde(default)]
    pub effort: Option<String>,
    /// A `PermissionModeOption::id` from the profile.
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// Session id to assign at start, when the CLI supports it.
    #[serde(default)]
    pub agent_session_id: Option<String>,
    /// Existing session id to fork from; requires native fork support.
    #[serde(default)]
    pub fork_from_agent_session_id: Option<String>,
}

/// The resolved command line and environment for one session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpawnPlan {
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Builds the spawn plan for `profile`, rejecting anything the profile does not
/// actually support.
///
/// Args are appended in a fixed order — model, effort, permission mode, session
/// id, then resume/fork — so the same options always produce the same command
/// line.
pub fn build_spawn_plan(
    profile: &AgentProfile,
    options: &SpawnOptions,
) -> Result<SpawnPlan, String> {
    let mut args: Vec<String> = Vec::new();
    let mut env: Vec<(String, String)> = Vec::new();

    if let Some(model) = selected(&options.model)? {
        let model_arg = profile.model_arg.as_deref().ok_or_else(|| {
            format!(
                "{} does not support model selection (no model flag)",
                profile.name
            )
        })?;
        if !profile.models.iter().any(|m| m == model) {
            return Err(format!(
                "Unknown model '{}' for {}. Available: {}",
                model,
                profile.name,
                available(&profile.models)
            ));
        }
        args.push(model_arg.to_string());
        args.push(model.to_string());
    }

    if let Some(effort) = selected(&options.effort)? {
        if profile.effort_levels.is_empty() {
            return Err(format!(
                "{} does not support effort/thinking levels",
                profile.name
            ));
        }
        let level = profile
            .effort_levels
            .iter()
            .find(|level| level.label == effort)
            .ok_or_else(|| {
                format!(
                    "Unknown effort level '{}' for {}. Available: {}",
                    effort,
                    profile.name,
                    available(&profile
                        .effort_levels
                        .iter()
                        .map(|level| level.label.clone())
                        .collect::<Vec<_>>())
                )
            })?;
        args.extend(level.args.iter().cloned());
        env.extend(level.env.iter().cloned());
    }

    if let Some(mode_id) = selected(&options.permission_mode)? {
        if profile.permission_modes.is_empty() {
            return Err(format!(
                "{} does not expose permission modes",
                profile.name
            ));
        }
        let mode = profile
            .permission_modes
            .iter()
            .find(|mode| mode.id == mode_id)
            .ok_or_else(|| {
                format!(
                    "Unknown permission mode '{}' for {}. Available: {}",
                    mode_id,
                    profile.name,
                    available(&profile
                        .permission_modes
                        .iter()
                        .map(|mode| mode.id.clone())
                        .collect::<Vec<_>>())
                )
            })?;
        args.extend(mode.args.iter().cloned());
    }

    if let Some(session_id) = selected(&options.agent_session_id)? {
        let session_id_arg = profile.session_id_arg.as_deref().ok_or_else(|| {
            format!(
                "{} cannot be assigned a session id at start (no session id flag)",
                profile.name
            )
        })?;
        validate_session_id(session_id)?;
        args.push(session_id_arg.to_string());
        args.push(session_id.to_string());
    }

    if let Some(fork_from) = selected(&options.fork_from_agent_session_id)? {
        if profile.fork_support != FORK_SUPPORT_NATIVE {
            return Err(format!(
                "{} cannot fork an existing session (fork support: {})",
                profile.name, profile.fork_support
            ));
        }
        if profile.resume_fork_args.is_empty() {
            return Err(format!(
                "{} declares native fork support but has no resume/fork template",
                profile.name
            ));
        }
        validate_session_id(fork_from)?;
        args.extend(
            profile
                .resume_fork_args
                .iter()
                .map(|arg| arg.replace(SESSION_ID_PLACEHOLDER, fork_from)),
        );
    }

    Ok(SpawnPlan {
        command: resolve_command(profile)?,
        args,
        env,
    })
}

/// Prefers the absolute path found during detection, falling back to the bare
/// command name for `PATH` lookup inside the PTY.
fn resolve_command(profile: &AgentProfile) -> Result<String, String> {
    let command = profile
        .detected_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
        .unwrap_or(profile.command.as_str());

    if command.trim().is_empty() {
        return Err(format!("{} has no command configured", profile.name));
    }
    Ok(command.to_string())
}

/// Normalises an incoming option: `None` and blank strings both mean "not set".
fn selected(value: &Option<String>) -> Result<Option<&str>, String> {
    match value {
        None => Ok(None),
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err("Option value must not be blank".to_string());
            }
            Ok(Some(trimmed))
        }
    }
}

/// Checks a session id is UUID-like (`[0-9a-fA-F-]`, 8-64 chars).
///
/// Session ids come from the webview and land directly on a command line, so the
/// charset is the boundary that keeps a crafted value from becoming a flag or a
/// shell metacharacter.
fn validate_session_id(value: &str) -> Result<(), String> {
    if !value
        .chars()
        .all(|c| c.is_ascii_hexdigit() || c == '-')
    {
        return Err(format!(
            "Session id '{value}' must be UUID-like (hex digits and '-' only)"
        ));
    }
    if value.len() < SESSION_ID_MIN_LEN || value.len() > SESSION_ID_MAX_LEN {
        return Err(format!(
            "Session id '{value}' must be {}-{} characters long",
            SESSION_ID_MIN_LEN, SESSION_ID_MAX_LEN
        ));
    }
    Ok(())
}

fn available(values: &[String]) -> String {
    if values.is_empty() {
        return "none".to_string();
    }
    values.join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_session_id_accepts_uuid_forms() {
        assert!(validate_session_id("123e4567-e89b-12d3-a456-426614174000").is_ok());
        assert!(validate_session_id("123e4567e89b12d3a456426614174000").is_ok());
        assert!(validate_session_id("ABCDEF01-2345-6789").is_ok());
    }

    #[test]
    fn validate_session_id_rejects_flags_and_shell_metacharacters() {
        for bad in [
            "--resume",
            "$(rm -rf /)",
            "a; rm -rf /",
            "has space",
            "not-a-uuid",
        ] {
            assert!(
                validate_session_id(bad).is_err(),
                "'{bad}' must be rejected"
            );
        }
    }

    #[test]
    fn validate_session_id_enforces_the_length_bounds() {
        assert!(validate_session_id("abcdef0").is_err(), "7 chars is too short");
        assert!(validate_session_id("abcdef01").is_ok(), "8 chars is allowed");
        assert!(validate_session_id(&"a".repeat(64)).is_ok(), "64 chars is allowed");
        assert!(validate_session_id(&"a".repeat(65)).is_err(), "65 chars is too long");
    }

    #[test]
    fn resolve_command_prefers_detected_path() {
        let mut profile = AgentProfile::new("x", "X", "x");
        profile.detected_path = Some("/usr/local/bin/x".to_string());
        assert_eq!(resolve_command(&profile).unwrap(), "/usr/local/bin/x");

        profile.detected_path = Some("   ".to_string());
        assert_eq!(resolve_command(&profile).unwrap(), "x");

        profile.detected_path = None;
        profile.command = String::new();
        assert!(resolve_command(&profile).is_err());
    }

    #[test]
    fn selected_treats_blank_as_unset_and_rejects_whitespace_only() {
        assert_eq!(selected(&None).unwrap(), None);
        assert_eq!(selected(&Some("opus".to_string())).unwrap(), Some("opus"));
        assert_eq!(selected(&Some("  opus ".to_string())).unwrap(), Some("opus"));
        assert!(selected(&Some("   ".to_string())).is_err());
    }
}
