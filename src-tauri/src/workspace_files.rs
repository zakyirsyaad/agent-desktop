//! Every file in a workspace, for the composer's @-mention list.
//!
//! In a git repository, git lists them, so what it ignores (build output,
//! dependencies) stays out. Elsewhere the folder is walked, skipping hidden
//! and well-known build folders.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::State;

use crate::files::ensure_known_workspace;
use crate::git_info::git_binary;
use crate::store::AppStore;

/// The most files listed, so a huge folder cannot stall the composer.
const MAX_FILES: usize = 20_000;
/// Folders a plain walk skips: dependencies and build output, never worth mentioning.
const SKIPPED_FOLDERS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "vendor",
    "__pycache__",
];

/// The files git knows of or would add (tracked, or untracked and not ignored), or None outside a repository.
fn git_files(git: &Path, root: &Path) -> Option<Vec<String>> {
    let output = Command::new(git)
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let listed = String::from_utf8_lossy(&output.stdout);
    Some(
        listed
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

/// The files under `root`, walked folder by folder and stopping at `MAX_FILES`.
fn walked_files(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let mut folders: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(folder) = folders.pop() {
        let Ok(entries) = fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                if !SKIPPED_FOLDERS.contains(&name.as_str()) {
                    folders.push(path);
                }
            } else if kind.is_file() {
                if let Ok(relative) = path.strip_prefix(root) {
                    files.push(relative.to_string_lossy().replace('\\', "/"));
                }
                if files.len() >= MAX_FILES {
                    return files;
                }
            }
        }
    }
    files
}

/// The workspace's files as paths relative to `root`, sorted.
pub fn list_workspace_files(git: &Path, root: &Path) -> Result<Vec<String>, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let mut files = git_files(git, root).unwrap_or_else(|| walked_files(root));
    files.truncate(MAX_FILES);
    files.sort();
    files.dedup();
    Ok(files)
}

/// The files of one of the user's workspaces, for @-mentions.
#[tauri::command(async)]
pub fn workspace_files(store: State<'_, AppStore>, root: String) -> Result<Vec<String>, String> {
    ensure_known_workspace(&root, |p| store.is_known_workspace(p))?;
    list_workspace_files(&git_binary(), Path::new(&root))
}
