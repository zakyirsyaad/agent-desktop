//! What the UI shows about a workspace: its git branch and where it lives.
//!
//! The branch is read from the repository's `HEAD` file rather than by
//! running git, so showing it costs one small file read and needs no git.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::files::ensure_known_workspace;
use crate::store::AppStore;

/// How many characters of a commit a detached `HEAD` is shown with.
const SHORT_COMMIT_LEN: usize = 7;

/// A workspace's folder line ("~/developer") and its branch, if it is a repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDetails {
    pub location: String,
    pub branch: Option<String>,
}

/// The `.git` directory of the repository `dir` is in, following the `.git`
/// file a worktree or submodule has in place of a directory.
fn git_dir_of(dir: &Path) -> Option<PathBuf> {
    dir.ancestors().find_map(|folder| {
        let dot_git = folder.join(".git");
        if dot_git.is_dir() {
            return Some(dot_git);
        }
        let pointer = fs::read_to_string(&dot_git).ok()?;
        let target = pointer.trim().strip_prefix("gitdir:")?.trim();
        Some(folder.join(target))
    })
}

/// The checked-out branch of the repository `dir` is in, or a short commit
/// when `HEAD` is detached; `None` outside a repository.
pub fn branch_of(dir: &Path) -> Option<String> {
    let head = fs::read_to_string(git_dir_of(dir)?.join("HEAD")).ok()?;
    let head = head.trim();
    if let Some(reference) = head.strip_prefix("ref:") {
        let reference = reference.trim();
        return Some(reference.strip_prefix("refs/heads/").unwrap_or(reference).to_string());
    }
    let is_commit = head.len() >= SHORT_COMMIT_LEN && head.chars().all(|c| c.is_ascii_hexdigit());
    is_commit.then(|| head[..SHORT_COMMIT_LEN].to_string())
}

/// The folder that holds `path`, with the home folder shown as `~`.
pub fn display_location(path: &Path, home: Option<&Path>) -> String {
    let parent = path.parent().unwrap_or(path);
    match home.and_then(|home| parent.strip_prefix(home).ok()) {
        Some(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Some(rest) => format!("~/{}", rest.display()),
        None => parent.display().to_string(),
    }
}

/// The folder line and branch shown for one of the user's workspaces.
#[tauri::command(async)]
pub fn workspace_details(store: State<'_, AppStore>, path: String) -> Result<WorkspaceDetails, String> {
    ensure_known_workspace(&path, |p| store.is_known_workspace(p))?;
    let path = Path::new(&path);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    Ok(WorkspaceDetails {
        location: display_location(path, home.as_deref()),
        branch: branch_of(path),
    })
}
