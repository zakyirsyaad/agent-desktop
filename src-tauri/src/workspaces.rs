//! Discovery of the project folders the UI offers as agent spawn targets.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// A project folder: `name` is shown in the UI, `path` is the absolute spawn cwd.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Workspace {
    pub name: String,
    pub path: String,
}

/// Workspaces are the folders directly under `$HOME/developer`.
pub const WORKSPACE_ROOT_DIR: &str = "developer";

/// Lists the direct child directories of `root`, sorted by name.
///
/// Hidden entries and plain files are skipped because neither is a project an
/// agent can be spawned in. A missing or unreadable root yields an empty vec
/// rather than an error: "no workspaces yet" is a state the UI reports to the
/// user, not a failure to recover from.
pub fn list_workspaces_in(root: &Path) -> Vec<Workspace> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };

    let mut workspaces: Vec<Workspace> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            Some(Workspace {
                name,
                path: entry.path().to_string_lossy().to_string(),
            })
        })
        .collect();

    workspaces.sort_by(|a, b| a.name.cmp(&b.name));
    workspaces
}

/// Resolves the workspace root to `$HOME/developer`, or `None` when `HOME` is unset.
pub fn default_workspace_root() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| Path::new(&home).join(WORKSPACE_ROOT_DIR))
}
