//! The identity of the person running the app, read from their global git config.
//!
//! The footer used to show a hardcoded name and a "Pro" badge. Neither was
//! real, so this module reads what git already knows about the user and reports
//! `None` when git knows nothing — the UI then falls back to a neutral label.

use std::process::Command;

use serde::Serialize;

use crate::git_info::git_binary;

/// The user's git identity. Either field is absent when git has no value for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// Normalises one `git config` value.
///
/// Only the first line is kept and surrounding whitespace is dropped, so a
/// trailing newline or an empty value both become `None` rather than an empty
/// string the UI would render as a blank name.
pub fn parse_git_config_value(raw: &str) -> Option<String> {
    let value = raw.lines().next().unwrap_or("").trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// Builds the profile from the two raw git values, normalising both.
pub fn profile_from_raw(name: Option<&str>, email: Option<&str>) -> UserProfile {
    UserProfile {
        name: name.and_then(parse_git_config_value),
        email: email.and_then(parse_git_config_value),
    }
}

/// The current user's git identity, or an empty profile when git has none.
pub fn current_user_profile() -> UserProfile {
    profile_from_raw(
        read_git_global_config("user.name").as_deref(),
        read_git_global_config("user.email").as_deref(),
    )
}

/// Reads one `--global` git config value.
///
/// Both "git is not installed" and "this key was never set" mean no value: the
/// former has no binary to run, the latter exits non-zero. Neither is an error
/// worth surfacing to the user, so both become `None`.
fn read_git_global_config(key: &str) -> Option<String> {
    let output = Command::new(git_binary())
        .args(["config", "--global", key])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The user's git identity, for the sidebar footer.
///
/// Async because reading git config spawns two child processes, which must not
/// block the main thread.
#[tauri::command(async)]
pub fn get_user_profile() -> UserProfile {
    current_user_profile()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_trimmed_value() {
        assert_eq!(
            parse_git_config_value("Iwang Nurhadi\n"),
            Some("Iwang Nurhadi".to_string())
        );
        assert_eq!(
            parse_git_config_value("  iwang@example.com  "),
            Some("iwang@example.com".to_string())
        );
    }

    #[test]
    fn turns_an_empty_value_into_none() {
        // `git config --global user.name` prints nothing and exits 1 when unset,
        // and prints an empty line when the value was set to "".
        assert_eq!(parse_git_config_value(""), None);
        assert_eq!(parse_git_config_value("\n"), None);
        assert_eq!(parse_git_config_value("   \t\n"), None);
    }

    #[test]
    fn keeps_only_the_first_line_of_a_multi_line_value() {
        assert_eq!(
            parse_git_config_value("Iwang\nignored trailing output"),
            Some("Iwang".to_string())
        );
    }

    #[test]
    fn keeps_non_ascii_characters_intact() {
        assert_eq!(
            parse_git_config_value("Íwang Núrhadi"),
            Some("Íwang Núrhadi".to_string())
        );
    }

    #[test]
    fn builds_a_profile_from_the_two_git_values() {
        let profile = profile_from_raw(Some("Iwang\n"), Some("\n"));

        assert_eq!(
            profile,
            UserProfile {
                name: Some("Iwang".to_string()),
                email: None,
            }
        );
    }

    #[test]
    fn builds_an_empty_profile_when_git_has_neither_value() {
        assert_eq!(
            profile_from_raw(None, None),
            UserProfile {
                name: None,
                email: None
            }
        );
    }

    #[test]
    fn serializes_the_profile_with_camel_case_keys_and_nulls_for_missing_values() {
        let json = serde_json::to_value(UserProfile {
            name: Some("Iwang".to_string()),
            email: None,
        })
        .expect("serialize profile");

        assert_eq!(json, serde_json::json!({ "name": "Iwang", "email": null }));
        assert!(json.get("name").is_some(), "key must stay camelCase `name`");
    }
}
