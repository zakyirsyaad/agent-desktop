//! A workspace's local branches: listing them for the folder picker, and
//! switching the folder to one.
//!
//! The UI sends a branch name, so every name is checked to be an existing
//! local branch before it reaches git: a name git would read as an option
//! (`--detach`) or a remote-only branch never gets through.

use std::path::{Path, PathBuf};

use tauri::State;

use crate::acp::manager::AcpManager;
use crate::files::ensure_known_workspace;
use crate::git_info::git_binary;
use crate::store::AppStore;
use crate::worktrees::{branch_exists, run_git};

const HEADS_PREFIX: &str = "refs/heads/";

/// The local branches of the repository `dir` is in, most recently committed first.
pub fn local_branches(git: &Path, dir: &Path) -> Result<Vec<String>, String> {
    // Full ref names: `%(refname:short)` turns into `heads/x` when a tag is also named `x`.
    let listed = run_git(
        git,
        dir,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)",
            HEADS_PREFIX,
        ],
    )?;
    Ok(listed
        .lines()
        .filter_map(|line| line.strip_prefix(HEADS_PREFIX))
        .map(str::to_string)
        .collect())
}

/// Fails unless `name` is a local branch of the repository `dir` is in.
pub fn ensure_local_branch(git: &Path, dir: &Path, name: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('-') || !branch_exists(git, dir, name) {
        return Err(format!("{name:?} is not a local branch"));
    }
    Ok(())
}

/// The checkout `dir` belongs to: its repository's top folder, or the worktree's.
fn checkout_of(git: &Path, dir: &Path) -> Option<PathBuf> {
    let toplevel = run_git(git, dir, &["rev-parse", "--show-toplevel"]).ok()?;
    PathBuf::from(toplevel).canonicalize().ok()
}

/// Fails when a session in `live_folders` works in the same checkout as
/// `dir`: switching the branch would change the files under its agent. A
/// worktree is its own checkout, so its sessions block only that worktree.
pub fn ensure_no_live_session(
    git: &Path,
    dir: &Path,
    live_folders: &[PathBuf],
) -> Result<(), String> {
    let Some(checkout) = checkout_of(git, dir) else {
        return Ok(());
    };
    if live_folders
        .iter()
        .any(|folder| checkout_of(git, folder).as_ref() == Some(&checkout))
    {
        return Err(
            "An agent is still running in this repository. Stop its session, or turn on Worktree."
                .to_string(),
        );
    }
    Ok(())
}

/// Checks out the local branch `name` in `dir`. Uncommitted changes come
/// along as with `git switch`; when they would conflict git refuses, and
/// its message is returned with the folder left on its branch.
pub fn switch_to_branch(git: &Path, dir: &Path, name: &str) -> Result<(), String> {
    ensure_local_branch(git, dir, name)?;
    run_git(git, dir, &["switch", "--no-guess", name]).map(|_| ())
}

/// The local branches of the workspace `path`, for the folder picker.
#[tauri::command(async)]
pub fn list_branches(store: State<'_, AppStore>, path: String) -> Result<Vec<String>, String> {
    ensure_known_workspace(&path, |p| store.is_known_workspace(p))?;
    local_branches(&git_binary(), Path::new(&path))
}

/// Switches the workspace `path` to the local branch `branch`, unless a
/// session's agent works in the same checkout.
#[tauri::command(async)]
pub fn switch_branch(
    store: State<'_, AppStore>,
    manager: State<'_, AcpManager>,
    path: String,
    branch: String,
) -> Result<(), String> {
    ensure_known_workspace(&path, |p| store.is_known_workspace(p))?;
    let git = git_binary();
    let dir = Path::new(&path);
    ensure_no_live_session(&git, dir, &manager.session_folders())?;
    switch_to_branch(&git, dir, &branch)
}
