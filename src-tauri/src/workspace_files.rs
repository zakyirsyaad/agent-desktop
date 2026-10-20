//! Every file in a workspace, for the composer's @-mention list.
//!
//! In a git repository, git lists them, so what it ignores (build output,
//! dependencies) stays out. Elsewhere the folder is walked, skipping hidden
//! and well-known build folders.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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

/// True for a name the composer can offer: no control characters, which a
/// terminal would take as keys (Enter, Ctrl-C) rather than text.
fn is_plain_name(path: &str) -> bool {
    !path.chars().any(char::is_control)
}

/// The files git knows of or would add (tracked, or untracked and not
/// ignored) that exist as regular files, at most `limit` of them; None
/// outside a repository. git's output is read as it comes and git is
/// stopped at the limit, so a huge repository costs no more than that.
fn git_files(git: &Path, root: &Path, limit: usize) -> Option<Vec<String>> {
    let mut child = Command::new(git)
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut files = Vec::new();
    let mut is_cut = false;
    if let Some(stdout) = child.stdout.take() {
        for entry in BufReader::new(stdout).split(0) {
            let Ok(bytes) = entry else { break };
            let path = String::from_utf8_lossy(&bytes).into_owned();
            // The index also names files deleted from disk, and submodule folders.
            if !path.is_empty() && is_plain_name(&path) && root.join(&path).is_file() {
                files.push(path);
            }
            if files.len() >= limit {
                is_cut = true;
                break;
            }
        }
    }
    if is_cut {
        // Stopping git early is the point; failing to only means it finishes on its own.
        let _ = child.kill();
    }
    let status = child.wait().ok()?;
    (is_cut || status.success()).then_some(files)
}

/// The files under `root`, walked folder by folder and stopping at `MAX_FILES`.
fn walked_files(root: &Path, limit: usize) -> Vec<String> {
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
                    let relative = relative.to_string_lossy().replace('\\', "/");
                    if is_plain_name(&relative) {
                        files.push(relative);
                    }
                }
                if files.len() >= limit {
                    return files;
                }
            }
        }
    }
    files
}

/// The workspace's files as paths relative to `root`, sorted.
pub fn list_workspace_files(git: &Path, root: &Path) -> Result<Vec<String>, String> {
    list_workspace_files_up_to(git, root, MAX_FILES)
}

/// Like `list_workspace_files`, with at most `limit` files.
pub fn list_workspace_files_up_to(
    git: &Path,
    root: &Path,
    limit: usize,
) -> Result<Vec<String>, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let mut files = git_files(git, root, limit).unwrap_or_else(|| walked_files(root, limit));
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
