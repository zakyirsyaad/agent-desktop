//! The pull request for a session's branch, and how its checks stand, read
//! through the GitHub CLI the user has already signed in to. The app never
//! asks for or stores a token.

use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::env_resolver;
use crate::files::ensure_known_workspace;
use crate::git_info::branch_of;
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
    /// The branch it was looked up for, so the UI shows it only beside that branch.
    pub branch: String,
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
pub fn parse_pull_request(listed: &str, branch: &str) -> Result<Option<PullRequestStatus>, String> {
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
        branch: branch.to_string(),
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

/// Longest a gh call may take: on a stalled network it is stopped, rather
/// than left running with a thread waiting on it at every refresh.
const GH_TIMEOUT: Duration = Duration::from_secs(20);
const GH_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Runs gh in `dir` with stdin closed, stopping it after `GH_TIMEOUT`: its
/// output, None for a repository that is not on GitHub, or its error.
fn run_gh(gh: &Path, dir: &Path, args: &[String]) -> Result<Option<String>, String> {
    run_gh_within(gh, dir, args, GH_TIMEOUT)
}

fn run_gh_within(
    gh: &Path,
    dir: &Path,
    args: &[String],
    timeout: Duration,
) -> Result<Option<String>, String> {
    let mut child = Command::new(gh)
        .current_dir(dir)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run gh: {e}"))?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill();
        return Err("Could not read gh's output".to_string());
    };
    let (stdout, stderr) = (
        env_resolver::drain_in_background(stdout),
        env_resolver::drain_in_background(stderr),
    );
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child
            .try_wait()
            .map_err(|e| format!("Could not run gh: {e}"))?
        {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "gh did not answer within {} seconds",
                    timeout.as_secs()
                ));
            }
            None => thread::sleep(GH_POLL_INTERVAL),
        }
    };
    let text = |rx| match env_resolver::recv_by_deadline(rx, deadline) {
        Some(Ok(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
        _ => String::new(),
    };
    if !status.success() {
        let error = text(&stderr).trim().to_string();
        // A repository with no GitHub remote has no pull requests: nothing to show, not a failure.
        return if is_not_on_github(&error) {
            Ok(None)
        } else {
            Err(error)
        };
    }
    Ok(Some(text(&stdout)))
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
    let args = [
        "pr",
        "list",
        "--state",
        "all",
        "--limit",
        "1",
        &format!("--head={branch}"),
        "--json",
        "number,title,url,state,isDraft,statusCheckRollup",
    ]
    .map(String::from);
    match run_gh(gh, dir, &args)? {
        Some(listed) => parse_pull_request(&listed, branch),
        None => Ok(None),
    }
}

/// The pull request for the branch checked out in a session's folder right
/// now, read with the user's GitHub CLI. The branch is read here, not passed
/// in, so one the agent just created or switched to counts at once.
#[tauri::command(async)]
pub fn session_pull_request(
    store: State<'_, AppStore>,
    path: String,
) -> Result<Option<PullRequestStatus>, String> {
    ensure_known_workspace(&path, |p| store.is_known_workspace(p))?;
    let Some(gh) = env_resolver::find_binary_in_user_path("gh") else {
        return Ok(None);
    };
    let Some(branch) = branch_of(Path::new(&path)) else {
        return Ok(None);
    };
    branch_pull_request(&gh, Path::new(&path), &branch)
}

/// One of the user's pull requests in a repository, as its list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSummary {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// `open`, `merged` or `closed`.
    pub state: String,
    pub is_draft: bool,
}

/// How many of the user's pull requests the list reads, newest first: one
/// more than it shows (30), so it can tell there are others.
const LISTED_PULL_REQUESTS: &str = "31";

/// Every pull request in `gh pr list --json number,title,url,state,isDraft`
/// output, in the order gh gave them (newest first).
pub fn parse_pull_request_list(listed: &str) -> Result<Vec<PullRequestSummary>, String> {
    let parsed: Value =
        serde_json::from_str(listed).map_err(|e| format!("Unexpected answer from gh: {e}"))?;
    let Some(list) = parsed.as_array() else {
        return Err("Unexpected answer from gh: not a list".to_string());
    };
    Ok(list
        .iter()
        .map(|pr| {
            let text = |name: &str| {
                pr.get(name)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            PullRequestSummary {
                number: pr.get("number").and_then(Value::as_u64).unwrap_or(0),
                title: text("title"),
                url: text("url"),
                state: text("state").to_ascii_lowercase(),
                is_draft: pr.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
            }
        })
        .collect())
}

/// The pull requests the signed-in user opened in the repository at a
/// session's folder, newest first, merged and closed ones included. None
/// when the GitHub CLI is not installed or the repository is not on GitHub
/// (the list is then not shown at all).
#[tauri::command(async)]
pub fn repo_pull_requests(
    store: State<'_, AppStore>,
    path: String,
) -> Result<Option<Vec<PullRequestSummary>>, String> {
    ensure_known_workspace(&path, |p| store.is_known_workspace(p))?;
    let Some(gh) = env_resolver::find_binary_in_user_path("gh") else {
        return Ok(None);
    };
    let args = [
        "pr",
        "list",
        "--state",
        "all",
        "--author",
        "@me",
        "--limit",
        LISTED_PULL_REQUESTS,
        "--json",
        "number,title,url,state,isDraft",
    ]
    .map(String::from);
    run_gh(&gh, Path::new(&path), &args)?
        .map(|listed| parse_pull_request_list(&listed))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in for gh: a shell script with `body`, in a fresh folder.
    #[cfg(unix)]
    fn fake_gh(name: &str, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("fake-gh-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create fake gh folder");
        let gh = dir.join("gh");
        std::fs::write(&gh, format!("#!/bin/sh\n{body}\n")).expect("write fake gh");
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755))
            .expect("make fake gh runnable");
        gh
    }

    #[cfg(unix)]
    #[test]
    fn stops_a_gh_that_does_not_answer_in_time() {
        let gh = fake_gh("hangs", "sleep 30");
        let started = Instant::now();

        let result = run_gh_within(&gh, &std::env::temp_dir(), &[], Duration::from_millis(200));

        assert!(result.expect_err("a timeout").contains("did not answer"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[test]
    fn reads_gh_output_and_takes_a_repository_off_github_as_none() {
        let listing = fake_gh("lists", "echo '[]'");
        let off_github = fake_gh("off-github", "echo 'no git remotes found' >&2; exit 1");
        let failing = fake_gh("fails", "echo 'gh auth login' >&2; exit 4");
        let dir = std::env::temp_dir();

        assert_eq!(
            run_gh(&listing, &dir, &[]).expect("run"),
            Some("[]\n".to_string())
        );
        assert_eq!(run_gh(&off_github, &dir, &[]).expect("run"), None);
        assert_eq!(
            run_gh(&failing, &dir, &[]).expect_err("a failure"),
            "gh auth login"
        );
    }

    #[test]
    fn reads_every_pull_request_in_a_list() {
        let listed = r#"[
            {"number":14,"title":"PR status","url":"https://github.com/o/r/pull/14","state":"MERGED","isDraft":false},
            {"number":15,"title":"Draft","url":"https://github.com/o/r/pull/15","state":"OPEN","isDraft":true}]"#;

        let list = parse_pull_request_list(listed).expect("parse");

        assert_eq!(list.len(), 2);
        assert_eq!(list[0].number, 14);
        assert_eq!(list[0].state, "merged");
        assert_eq!(list[1].title, "Draft");
        assert!(list[1].is_draft);
    }

    #[test]
    fn reads_an_empty_list_and_rejects_an_answer_that_is_not_one() {
        assert_eq!(parse_pull_request_list("[]").expect("parse"), vec![]);
        assert!(parse_pull_request_list("{}").is_err());
        assert!(parse_pull_request_list("not json").is_err());
    }

    #[test]
    fn reads_a_pull_request_and_counts_its_checks() {
        let listed = r#"[{"number":13,"title":"Unread marks","url":"https://github.com/o/r/pull/13",
            "state":"OPEN","isDraft":false,"statusCheckRollup":[
              {"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"},
              {"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"},
              {"__typename":"CheckRun","status":"IN_PROGRESS","conclusion":""},
              {"__typename":"StatusContext","state":"PENDING"},
              {"__typename":"StatusContext","state":"SUCCESS"}]}]"#;

        let pr = parse_pull_request(listed, "feat/x")
            .expect("parse")
            .expect("a pull request");

        assert_eq!(pr.branch, "feat/x");
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
        assert_eq!(parse_pull_request("[]", "feat/x").expect("parse"), None);
    }

    #[test]
    fn reports_an_answer_it_cannot_read() {
        assert!(parse_pull_request("not json", "feat/x").is_err());
    }

    #[test]
    fn counts_skipped_and_neutral_checks_as_passing_and_cancelled_as_failing() {
        let listed = r#"[{"number":1,"title":"t","url":"u","state":"MERGED","isDraft":false,"statusCheckRollup":[
              {"status":"COMPLETED","conclusion":"SKIPPED"},
              {"status":"COMPLETED","conclusion":"NEUTRAL"},
              {"status":"COMPLETED","conclusion":"CANCELLED"}]}]"#;

        let pr = parse_pull_request(listed, "feat/x")
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
