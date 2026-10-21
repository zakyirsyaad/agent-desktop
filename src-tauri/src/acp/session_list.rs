//! Lists an agent's sessions for a folder, so the draft can offer to continue
//! one that Zorvo does not know.
//!
//! One short-lived agent process reads every `session/list` page: a cursor
//! never leaves the backend and is never reused across processes. Each
//! `SessionInfo` is validated here, since every field comes from the agent.

use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use super::connection::AcpConnection;
use super::manager::{
    agent_error, initialize, spawn_unrouted, AcpLaunch, AcpManager, SESSION_REQUEST_TIMEOUT,
};
use crate::pty_session::validate_cwd;

/// At most this many `session/list` pages are read.
pub const MAX_LIST_PAGES: usize = 10;
/// At most this many sessions are listed.
pub const MAX_LISTED_SESSIONS: usize = 200;
/// How long a whole listing may take, measured from the end of `initialize`.
const LIST_BUDGET: Duration = Duration::from_secs(120);
/// A session id longer than this many characters is not kept.
const MAX_SESSION_ID_CHARS: usize = 256;
/// A title is cut to this many characters.
const MAX_TITLE_CHARS: usize = 200;
/// The error for an agent that offers no `sessionCapabilities.list`.
const CANNOT_LIST: &str = "This agent cannot list its sessions";
/// The error for a listing whose first page could not be read in time.
const LIST_TOOK_TOO_LONG: &str = "Listing sessions took too long";

/// One of the agent's sessions in the requested folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedSession {
    pub acp_session_id: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}

/// What one listing read: `truncated` when entries were left unread,
/// `incomplete` when a later page failed and only the earlier ones are included.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListedSessions {
    pub sessions: Vec<ListedSession>,
    pub truncated: bool,
    pub incomplete: bool,
}

impl AcpManager {
    /// Lists the agent's sessions in `cwd`, in one short-lived process that is
    /// ended whatever the outcome. The agent's entries are validated here:
    /// anything the UI must not see is dropped.
    pub fn list_sessions(&self, cwd: &str, launch: &AcpLaunch) -> Result<ListedSessions, String> {
        validate_cwd(cwd)?;
        let connection = spawn_unrouted(cwd, launch, |_, _| {})?;
        let result = read_pages(&connection, cwd);
        connection.kill();
        result
    }
}

/// Reads `session/list` pages until the end, a cap or a failure.
fn read_pages(connection: &AcpConnection, cwd: &str) -> Result<ListedSessions, String> {
    let init = initialize(connection)?;
    if !init["agentCapabilities"]["sessionCapabilities"]["list"].is_object() {
        return Err(CANNOT_LIST.to_string());
    }
    let folder = Path::new(cwd);
    let deadline = Instant::now() + LIST_BUDGET;
    let mut sessions = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0;
    loop {
        if pages >= MAX_LIST_PAGES {
            return Ok(ListedSessions {
                sessions,
                truncated: true,
                incomplete: false,
            });
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return if pages == 0 {
                Err(LIST_TOOK_TOO_LONG.to_string())
            } else {
                Ok(ListedSessions {
                    sessions,
                    truncated: false,
                    incomplete: true,
                })
            };
        }
        let mut params = json!({ "cwd": cwd });
        if let Some(cursor) = &cursor {
            params["cursor"] = json!(cursor);
        }
        match connection.request_raw_with(
            "session/list",
            params,
            SESSION_REQUEST_TIMEOUT.min(remaining),
            |_| {},
        ) {
            Ok(Ok(page)) => {
                pages += 1;
                let mut unread = false;
                let entries = page["sessions"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default();
                for (index, entry) in entries.iter().enumerate() {
                    let Some(session) = listed_session(entry, folder) else {
                        continue;
                    };
                    // An entry repeated on a later page keeps its first copy.
                    if !seen.insert(session.acp_session_id.clone()) {
                        continue;
                    }
                    sessions.push(session);
                    if sessions.len() == MAX_LISTED_SESSIONS {
                        unread = index + 1 < entries.len();
                        break;
                    }
                }
                // A missing or empty cursor is the end; a cursor is otherwise
                // opaque and passed back exactly as the agent gave it.
                let next = page["nextCursor"].as_str().filter(|next| !next.is_empty());
                if sessions.len() >= MAX_LISTED_SESSIONS {
                    // The cap only truncates the list when this page has
                    // entries left or another page follows.
                    return Ok(ListedSessions {
                        sessions,
                        truncated: unread || next.is_some(),
                        incomplete: false,
                    });
                }
                match next {
                    Some(next) => cursor = Some(next.to_string()),
                    None => {
                        return Ok(ListedSessions {
                            sessions,
                            truncated: false,
                            incomplete: false,
                        })
                    }
                }
            }
            Ok(Err(error)) if pages == 0 => {
                return Err(agent_error("session/list", &init, &error));
            }
            Ok(Err(_)) => return Ok(incomplete(sessions)),
            Err(message) if pages == 0 => return Err(message),
            Err(_) => return Ok(incomplete(sessions)),
        }
    }
}

/// The pages read so far, with a later page missing.
fn incomplete(sessions: Vec<ListedSession>) -> ListedSessions {
    ListedSessions {
        sessions,
        truncated: false,
        incomplete: true,
    }
}

/// The session `info` describes, when it belongs to `cwd` and its fields are
/// usable. Duplicate ids are the caller's concern.
pub fn listed_session(info: &Value, cwd: &Path) -> Option<ListedSession> {
    let acp_session_id = info["sessionId"].as_str()?;
    if acp_session_id.is_empty() || acp_session_id.chars().count() > MAX_SESSION_ID_CHARS {
        return None;
    }
    if !is_same_folder(info["cwd"].as_str()?, cwd) {
        return None;
    }
    Some(ListedSession {
        acp_session_id: acp_session_id.to_string(),
        title: clean_title(info["title"].as_str()),
        updated_at: info["updatedAt"]
            .as_str()
            .filter(|updated_at| is_rfc3339(updated_at))
            .map(str::to_string),
    })
}

/// Whether `entry_cwd` is the absolute folder `cwd`, by string or, when both
/// canonicalise, after resolving symlinks. Paths from the agent are only
/// compared, never read or run.
fn is_same_folder(entry_cwd: &str, cwd: &Path) -> bool {
    let entry = Path::new(entry_cwd);
    if !entry.is_absolute() {
        return false;
    }
    if cwd.to_str() == Some(entry_cwd) {
        return true;
    }
    match (entry.canonicalize(), cwd.canonicalize()) {
        (Ok(entry), Ok(requested)) => entry == requested,
        _ => false,
    }
}

/// The title as one line: control characters removed, whitespace collapsed,
/// cut to [`MAX_TITLE_CHARS`]; empty becomes `None`.
fn clean_title(title: Option<&str>) -> Option<String> {
    let cleaned: String = title?
        .chars()
        // A newline or tab separates words; any other control character goes.
        .filter(|character| !character.is_control() || character.is_whitespace())
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(MAX_TITLE_CHARS).collect())
}

/// Whether `value` has the RFC 3339 shape
/// `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)` with in-range fields. No crate:
/// the shape is all the UI needs to turn it into a `Date`.
fn is_rfc3339(value: &str) -> bool {
    let bytes = value.as_bytes();
    if date_and_time(bytes).is_none() {
        return false;
    }
    let mut rest = &bytes[19..];
    if rest.first() == Some(&b'.') {
        rest = &rest[1..];
        let fraction = rest.iter().take_while(|byte| byte.is_ascii_digit()).count();
        if fraction == 0 {
            return false;
        }
        rest = &rest[fraction..];
    }
    match rest {
        [b'Z'] => true,
        [sign, hour_tens, hour_ones, b':', minute_tens, minute_ones]
            if *sign == b'+' || *sign == b'-' =>
        {
            let offset = [hour_tens, hour_ones, minute_tens, minute_ones];
            if !offset.iter().all(|digit| digit.is_ascii_digit()) {
                return false;
            }
            let hours = u32::from(*hour_tens - b'0') * 10 + u32::from(*hour_ones - b'0');
            let minutes = u32::from(*minute_tens - b'0') * 10 + u32::from(*minute_ones - b'0');
            hours <= 23 && minutes <= 59
        }
        _ => false,
    }
}

/// Checks `YYYY-MM-DDTHH:MM:SS` at the start of `bytes` with in-range fields.
fn date_and_time(bytes: &[u8]) -> Option<()> {
    if bytes.len() < 19 {
        return None;
    }
    let separators = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')];
    if separators
        .iter()
        .any(|(index, separator)| bytes[*index] != *separator)
    {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<u32> {
        let digits = bytes.get(range)?;
        if !digits.iter().all(u8::is_ascii_digit) {
            return None;
        }
        Some(
            digits
                .iter()
                .fold(0, |number, digit| number * 10 + u32::from(*digit - b'0')),
        )
    };
    number(0..4)?;
    let month = number(5..7)?;
    let day = number(8..10)?;
    let hour = number(11..13)?;
    let minute = number(14..16)?;
    let second = number(17..19)?;
    let in_range = (1..=12).contains(&month)
        && (1..=31).contains(&day)
        && hour <= 23
        && minute <= 59
        && second <= 60;
    in_range.then_some(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;
    use std::path::Path;

    use serde_json::{json, Value};

    use super::*;

    fn valid_entry(cwd: &Path) -> Value {
        json!({
            "sessionId": "a",
            "cwd": cwd.to_string_lossy(),
            "title": "Fix it",
            "updatedAt": "2026-10-20T08:00:00Z",
        })
    }

    /// A path under the temp dir that no earlier run of this test created.
    fn unique_temp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "zorvo-list-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ))
    }

    #[test]
    fn keeps_a_valid_entry() {
        let dir = std::env::temp_dir();

        let listed = listed_session(&valid_entry(&dir), &dir).expect("kept");

        assert_eq!(
            listed,
            ListedSession {
                acp_session_id: "a".to_string(),
                title: Some("Fix it".to_string()),
                updated_at: Some("2026-10-20T08:00:00Z".to_string()),
            }
        );
    }

    #[test]
    fn drops_bad_entries() {
        let dir = std::env::temp_dir();
        let long_id = "x".repeat(257);
        let bad = [
            json!({ "sessionId": "", "cwd": dir.to_string_lossy() }),
            json!({ "sessionId": long_id, "cwd": dir.to_string_lossy() }),
            json!({ "sessionId": 7, "cwd": dir.to_string_lossy() }),
            json!({ "sessionId": "a", "cwd": "relative/folder" }),
            json!({ "sessionId": "a", "cwd": "/somewhere/else" }),
            json!({ "sessionId": "a" }),
        ];

        for entry in bad {
            assert_eq!(listed_session(&entry, &dir), None, "{entry}");
        }
    }

    #[test]
    fn cleans_titles() {
        assert_eq!(
            clean_title(Some("  Fix\n\tthe\u{7}  bug ")).as_deref(),
            Some("Fix the bug")
        );
        let long = "x".repeat(300);
        assert_eq!(
            clean_title(Some(&long)).map(|title| title.chars().count()),
            Some(200)
        );
        assert_eq!(clean_title(Some("   ")), None);
        assert_eq!(clean_title(None), None);
    }

    #[test]
    fn checks_timestamps() {
        for kept in [
            "2026-10-20T08:00:00Z",
            "2026-10-20T08:00:00.123+07:00",
            "2026-10-20T08:00:00-05:30",
        ] {
            assert!(is_rfc3339(kept), "{kept} should be kept");
        }
        for dropped in ["2026-13-01T00:00:00Z", "yesterday", "2026-10-20"] {
            assert!(!is_rfc3339(dropped), "{dropped} should be dropped");
        }
    }

    #[test]
    fn matches_a_folder_through_a_symlink() {
        let root = unique_temp("symlink");
        let real = root.join("real");
        std::fs::create_dir_all(&real).expect("real dir");
        let link = root.join("link");
        symlink("real", &link).expect("symlink");
        let info = json!({ "sessionId": "a", "cwd": link.to_string_lossy() });

        assert!(listed_session(&info, &real).is_some());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn matches_a_missing_folder_by_its_string() {
        let missing = unique_temp("gone");
        let info = json!({ "sessionId": "a", "cwd": missing.to_string_lossy() });

        assert!(listed_session(&info, &missing).is_some());
    }
}
