//! Git worktrees that give a session its own checkout of a repository.
//!
//! Each worktree gets a new branch, `agent/<title>`, made from the
//! repository's current HEAD, so agents working in the same repository at the
//! same time never edit the same files. Worktrees live in the app's data
//! folder rather than inside the repository, so nothing needs ignoring there.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::State;

use crate::files::ensure_known_workspace;
use crate::git_info::git_binary;
use crate::store::AppStore;

/// The prefix of every branch a session worktree is made on.
const BRANCH_PREFIX: &str = "agent/";
/// The longest a branch name's title part gets, in characters.
const MAX_SLUG_LEN: usize = 40;
/// How many numbered names to try before giving up on a free one.
const MAX_NAME_ATTEMPTS: usize = 100;

/// A session's worktree: its root, the folder the agent runs in, and its branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWorktree {
    /// The worktree's root folder.
    pub path: String,
    /// Where the agent runs: the root, or the subfolder the workspace was.
    pub cwd: String,
    pub branch: String,
}

/// A branch-safe name from a session title: lowercase ASCII words joined by dashes.
pub fn branch_slug(title: &str) -> String {
    let dashed: String = title
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let words: Vec<&str> = dashed.split('-').filter(|w| !w.is_empty()).collect();
    let mut slug = String::new();
    for word in words {
        let extra = if slug.is_empty() {
            word.len()
        } else {
            word.len() + 1
        };
        if slug.len() + extra > MAX_SLUG_LEN {
            break;
        }
        if !slug.is_empty() {
            slug.push('-');
        }
        slug.push_str(word);
    }
    if slug.is_empty() {
        // A first word longer than the limit is cut rather than dropped.
        slug = dashed
            .trim_matches('-')
            .chars()
            .take(MAX_SLUG_LEN)
            .collect();
    }
    if slug.is_empty() {
        "session".to_string()
    } else {
        slug
    }
}

/// Runs git in `dir` and returns its trimmed output, or its error message.
fn run_git(git: &Path, dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new(git)
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn branch_exists(git: &Path, repo: &Path, branch: &str) -> bool {
    run_git(
        git,
        repo,
        &[
            "show-ref",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
    )
    .is_ok()
}

/// Makes a worktree of the repository `workspace` is in, on a new branch
/// named after `title`, under `root`.
pub fn create_worktree(
    git: &Path,
    workspace: &Path,
    root: &Path,
    title: &str,
) -> Result<SessionWorktree, String> {
    let toplevel = run_git(git, workspace, &["rev-parse", "--show-toplevel"])
        .map(PathBuf::from)
        .map_err(|_| format!("{} is not a git repository", workspace.display()))?;
    let workspace = workspace
        .canonicalize()
        .map_err(|e| format!("{}: {e}", workspace.display()))?;
    let toplevel = toplevel
        .canonicalize()
        .map_err(|e| format!("{}: {e}", toplevel.display()))?;
    let subfolder = workspace
        .strip_prefix(&toplevel)
        .unwrap_or(Path::new(""))
        .to_path_buf();
    let repo_name = toplevel
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    // A worktree checks out the last commit: a folder that exists only in
    // uncommitted or ignored files would be missing there.
    if !subfolder.as_os_str().is_empty() {
        let spec = format!("HEAD:{}", subfolder.to_string_lossy());
        if run_git(git, &toplevel, &["cat-file", "-e", &spec]).is_err() {
            return Err(format!(
                "{} is not in the last commit, so a worktree would not have it",
                subfolder.display()
            ));
        }
    }

    let slug = branch_slug(title);
    let (branch, path) = (1..=MAX_NAME_ATTEMPTS)
        .map(|n| {
            if n == 1 {
                slug.clone()
            } else {
                format!("{slug}-{n}")
            }
        })
        .map(|name| {
            (
                format!("{BRANCH_PREFIX}{name}"),
                root.join(&repo_name).join(&name),
            )
        })
        .find(|(branch, path)| !path.exists() && !branch_exists(git, &toplevel, branch))
        .ok_or_else(|| format!("No free branch name for {slug:?}"))?;

    fs::create_dir_all(path.parent().unwrap_or(root))
        .map_err(|e| format!("Could not create {}: {e}", root.display()))?;
    let path_arg = path.to_string_lossy().to_string();
    run_git(
        git,
        &toplevel,
        &["worktree", "add", "-b", &branch, &path_arg, "HEAD"],
    )
    .map_err(|e| format!("Could not create the worktree: {e}"))?;

    let cwd = if subfolder.as_os_str().is_empty() {
        path.clone()
    } else {
        path.join(&subfolder)
    };
    Ok(SessionWorktree {
        path: path_arg,
        cwd: cwd.to_string_lossy().to_string(),
        branch,
    })
}

/// Removes a session worktree that has no uncommitted changes; its branch,
/// with any commits on it, stays in the repository.
pub fn remove_worktree(git: &Path, repo: &Path, root: &Path, path: &Path) -> Result<(), String> {
    let not_a_worktree = || format!("{} is not a session worktree", path.display());
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    // Without the worktrees folder there is no session worktree to remove.
    let root = root.canonicalize().map_err(|_| not_a_worktree())?;
    if canonical == root || !canonical.starts_with(&root) {
        return Err(not_a_worktree());
    }
    let changes = run_git(git, &canonical, &["status", "--porcelain"])?;
    if !changes.is_empty() {
        return Err(format!(
            "{} has uncommitted changes, so it was kept",
            canonical.display()
        ));
    }
    let path_arg = canonical.to_string_lossy().to_string();
    run_git(git, repo, &["worktree", "remove", &path_arg]).map(|_| ())
}

/// Makes a worktree for a new session in the workspace `repo_path`.
#[tauri::command(async)]
pub fn create_session_worktree(
    store: State<'_, AppStore>,
    repo_path: String,
    title: String,
) -> Result<SessionWorktree, String> {
    ensure_known_workspace(&repo_path, |p| store.is_known_workspace(p))?;
    let worktree = create_worktree(
        &git_binary(),
        Path::new(&repo_path),
        &store.worktrees_root(),
        &title,
    )?;
    // The Files panel and branch line read it before the session's state save lands.
    if let Err(error) = store.remember_workspace(&worktree.cwd) {
        // No session will own it, so it is undone rather than left behind.
        return Err(
            match discard_worktree(&git_binary(), Path::new(&repo_path), &worktree) {
                Ok(()) => error,
                Err(undo) => format!(
                    "{error}; the worktree at {} was left behind: {undo}",
                    worktree.path
                ),
            },
        );
    }
    Ok(worktree)
}

/// Undoes a worktree no session got: its checkout and its still-empty branch.
fn discard_worktree(git: &Path, repo: &Path, worktree: &SessionWorktree) -> Result<(), String> {
    run_git(
        git,
        repo,
        &["worktree", "remove", "--force", &worktree.path],
    )?;
    run_git(git, repo, &["branch", "-D", &worktree.branch]).map(|_| ())
}

/// Removes a deleted session's worktree, unless it has uncommitted changes.
#[tauri::command(async)]
pub fn remove_session_worktree(
    store: State<'_, AppStore>,
    repo_path: String,
    path: String,
) -> Result<(), String> {
    ensure_known_workspace(&repo_path, |p| store.is_known_workspace(p))?;
    remove_worktree(
        &git_binary(),
        Path::new(&repo_path),
        &store.worktrees_root(),
        Path::new(&path),
    )
}
