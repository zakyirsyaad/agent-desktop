//! A workspace's local branches: listing them for the folder picker, and
//! switching the folder to one.
//!
//! The UI sends a branch name, so every name is checked to be an existing
//! local branch before it reaches git: a name git would read as an option
//! (`--detach`) or a remote-only branch never gets through.

use std::path::Path;

use tauri::State;

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
    )
    .map_err(|_| format!("{} is not a git repository", dir.display()))?;
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

/// Switches the workspace `path` to the local branch `branch`.
#[tauri::command(async)]
pub fn switch_branch(
    store: State<'_, AppStore>,
    path: String,
    branch: String,
) -> Result<(), String> {
    ensure_known_workspace(&path, |p| store.is_known_workspace(p))?;
    switch_to_branch(&git_binary(), Path::new(&path), &branch)
}
