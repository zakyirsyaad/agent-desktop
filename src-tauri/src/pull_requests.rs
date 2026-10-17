//! The pull request for a session's branch, and how its checks stand, read
//! through the GitHub CLI the user has already signed in to. The app never
//! asks for or stores a token.

use std::path::Path;
use std::process::Command;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::env_resolver;
use crate::files::ensure_known_workspace;
use crate::store::AppStore;

/// How a pull request's checks stand, counted.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckCounts {
    pub passing: u32,
    pub failing: u32,
    pub pending: u32,
}

/// A branch's pull request as the UI shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestStatus {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// `open`, `merged` or `closed`.
    pub state: String,
    pub is_draft: bool,
    pub checks: CheckCounts,
}

/// Where one check stands: a CheckRun has a status and a conclusion, a
/// commit status context only a state.
fn check_bucket(check: &Value) -> Option<&'static str> {
    let field = |name: &str| {
        check
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_uppercase()
    };
    let (status, conclusion, state) = (field("status"), field("conclusion"), field("state"));
    if !state.is_empty() {
        return match state.as_str() {
            "SUCCESS" => Some("passing"),
            "FAILURE" | "ERROR" => Some("failing"),
            "PENDING" | "EXPECTED" => Some("pending"),
            _ => None,
        };
    }
    if status != "COMPLETED" {
        return Some("pending");
    }
    match conclusion.as_str() {
        "SUCCESS" | "NEUTRAL" | "SKIPPED" => Some("passing"),
        "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" | "STALE" => {
            Some("failing")
        }
        _ => None,
    }
}

/// The first pull request in `gh pr list --json …` output, or None when the
/// branch has none.
pub fn parse_pull_request(listed: &str) -> Result<Option<PullRequestStatus>, String> {
    let parsed: Value =
        serde_json::from_str(listed).map_err(|e| format!("Unexpected answer from gh: {e}"))?;
    let Some(pr) = parsed.as_array().and_then(|list| list.first()) else {
        return Ok(None);
    };
    let mut checks = CheckCounts::default();
    for check in pr
        .get("statusCheckRollup")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match check_bucket(check) {
            Some("passing") => checks.passing += 1,
            Some("failing") => checks.failing += 1,
            Some("pending") => checks.pending += 1,
            _ => {}
        }
    }
    let text = |name: &str| {
        pr.get(name)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    Ok(Some(PullRequestStatus {
        number: pr.get("number").and_then(Value::as_u64).unwrap_or(0),
        title: text("title"),
        url: text("url"),
        state: text("state").to_ascii_lowercase(),
        is_draft: pr.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        checks,
    }))
}

/// True for gh's answer about a repository that is not on GitHub: no remote
/// at all, or remotes on other hosts.
fn is_not_on_github(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("no git remotes found") || error.contains("point to a known github host")
}

/// The pull request whose head is `branch` in the repository at `dir`, newest
/// first, merged and closed ones included; None when there is none, or when
/// the GitHub CLI is not installed (the status is then not shown at all).
pub fn branch_pull_request(
    gh: &Path,
    dir: &Path,
    branch: &str,
) -> Result<Option<PullRequestStatus>, String> {
    if branch.trim().is_empty() {
        return Ok(None);
    }
    let output = Command::new(gh)
        .current_dir(dir)
        .args(["pr", "list", "--state", "all", "--limit", "1"])
        .arg(format!("--head={branch}"))
        .args(["--json", "number,title,url,state,isDraft,statusCheckRollup"])
        .output()
        .map_err(|e| format!("Could not run gh: {e}"))?;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        // A repository with no GitHub remote has no pull requests: nothing to show, not a failure.
        return if is_not_on_github(&error) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    parse_pull_request(&String::from_utf8_lossy(&output.stdout))
}

/// The pull request for a session's branch, read with the user's GitHub CLI.
#[tauri::command(async)]
pub fn session_pull_request(
    store: State<'_, AppStore>,
    path: String,
    branch: String,
) -> Result<Option<PullRequestStatus>, String> {
    ensure_known_workspace(&path, |p| store.is_known_workspace(p))?;
    let Some(gh) = env_resolver::find_binary_in_user_path("gh") else {
        return Ok(None);
    };
    branch_pull_request(&gh, Path::new(&path), &branch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_pull_request_and_counts_its_checks() {
        let listed = r#"[{"number":13,"title":"Unread marks","url":"https://github.com/o/r/pull/13",
            "state":"OPEN","isDraft":false,"statusCheckRollup":[
              {"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"},
              {"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"},
              {"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":""},
              {"__typename":"StatusContext","state":"PENDING"},
              {"__typename":"StatusContext","state":"SUCCESS"}]}]"#;

        let pr = parse_pull_request(listed)
            .expect("parse")
            .expect("a pull request");

        assert_eq!(pr.number, 13);
        assert_eq!(pr.state, "open");
        assert!(!pr.is_draft);
        assert_eq!(
            pr.checks,
            CheckCounts {
                passing: 2,
                failing: 1,
                pending: 2
            }
        );
    }

    #[test]
    fn treats_a_repository_off_github_as_having_no_pull_requests() {
        assert!(is_not_on_github("no git remotes found"));
        assert!(is_not_on_github(
            "none of the git remotes configured for this repository point to a known GitHub host"
        ));
        assert!(!is_not_on_github(
            "To get started with GitHub CLI, please run:  gh auth login"
        ));
    }

    #[test]
    fn has_no_pull_request_for_an_empty_list() {
        assert_eq!(parse_pull_request("[]").expect("parse"), None);
    }

    #[test]
    fn reports_an_answer_it_cannot_read() {
        assert!(parse_pull_request("not json").is_err());
    }

    #[test]
    fn counts_skipped_and_neutral_checks_as_passing_and_cancelled_as_failing() {
        let listed = r#"[{"number":1,"title":"t","url":"u","state":"MERGED","isDraft":false,"statusCheckRollup":[
              {"status":"COMPLETED","conclusion":"SKIPPED"},
              {"status":"COMPLETED","conclusion":"NEUTRAL"},
              {"status":"COMPLETED","conclusion":"CANCELLED"}]}]"#;

        let pr = parse_pull_request(listed)
            .expect("parse")
            .expect("a pull request");

        assert_eq!(pr.state, "merged");
        assert_eq!(
            pr.checks,
            CheckCounts {
                passing: 2,
                failing: 1,
                pending: 0
            }
        );
    }
}
