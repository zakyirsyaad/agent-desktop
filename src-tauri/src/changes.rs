//! The uncommitted changes in a session's repository: listing them, showing
//! one file's diff, and committing a chosen set of files.

use std::path::{Component, Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::files::ensure_known_workspace;
use crate::git_info::git_binary;
use crate::store::AppStore;

/// The longest diff sent to the UI, in characters; a bigger one is cut.
const MAX_DIFF_CHARS: usize = 200_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
}

/// One changed file, its path relative to the repository's root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// Where a renamed file came from.
    pub old_path: Option<String>,
    pub kind: ChangeKind,
}

/// Runs git in `dir`; `ok_codes` are the exit codes that mean success.
fn run_git_with(git: &Path, dir: &Path, args: &[&str], ok_codes: &[i32]) -> Result<String, String> {
    let output = Command::new(git)
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run git: {e}"))?;
    if output
        .status
        .code()
        .is_some_and(|code| ok_codes.contains(&code))
    {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn run_git(git: &Path, dir: &Path, args: &[&str]) -> Result<String, String> {
    run_git_with(git, dir, args, &[0])
}

/// The root of the repository `dir` is in.
fn toplevel_of(git: &Path, dir: &Path) -> Result<PathBuf, String> {
    run_git(git, dir, &["rev-parse", "--show-toplevel"])
        .map(|out| PathBuf::from(out.trim()))
        .map_err(|_| format!("{} is not a git repository", dir.display()))
}

/// What a porcelain status code says about a file.
fn kind_of(code: &str) -> ChangeKind {
    let (index, worktree) = code.split_at(1);
    if code == "??" {
        ChangeKind::Untracked
    } else if index == "R" {
        ChangeKind::Renamed
    } else if index == "D" || worktree == "D" {
        ChangeKind::Deleted
    } else if index == "A" {
        ChangeKind::Added
    } else {
        ChangeKind::Modified
    }
}

/// Parses `git status --porcelain=v1 -z`: `XY path\0`, and for a rename
/// `XY new\0old\0`.
fn parse_status(output: &str) -> Vec<FileChange> {
    let mut changes = Vec::new();
    // Empty pieces only come from the trailing separator; a short old path is kept.
    let mut entries = output.split('\0').filter(|entry| !entry.is_empty());
    while let Some(entry) = entries.next() {
        if entry.len() <= 3 || !entry.is_char_boundary(3) {
            continue;
        }
        let (code, path) = entry.split_at(3);
        let kind = kind_of(&code[..2]);
        let old_path = if matches!(kind, ChangeKind::Renamed) {
            entries.next().map(str::to_string)
        } else {
            None
        };
        changes.push(FileChange {
            path: path.to_string(),
            old_path,
            kind,
        });
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    changes
}

/// Every uncommitted change in the repository `dir` is in, untracked files
/// one by one rather than as whole folders.
pub fn list_changes(git: &Path, dir: &Path) -> Result<Vec<FileChange>, String> {
    let toplevel = toplevel_of(git, dir)?;
    let output = run_git(
        git,
        &toplevel,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    Ok(parse_status(&output))
}

/// Cuts a diff to `MAX_DIFF_CHARS`, on a character boundary.
fn bounded(diff: String) -> String {
    if diff.chars().count() <= MAX_DIFF_CHARS {
        return diff;
    }
    let kept: String = diff.chars().take(MAX_DIFF_CHARS).collect();
    format!("{kept}\n… diff cut: it is longer than {MAX_DIFF_CHARS} characters\n")
}

/// A file's unified diff against the last commit; a new file shows whole.
pub fn file_diff(git: &Path, dir: &Path, change: &FileChange) -> Result<String, String> {
    let toplevel = toplevel_of(git, dir)?;
    let diff = match change.kind {
        // `--no-index` exits with 1 when the files differ, which they always do here.
        ChangeKind::Untracked => run_git_with(
            git,
            &toplevel,
            &[
                "diff",
                "--no-color",
                "--no-index",
                "--",
                "/dev/null",
                &change.path,
            ],
            &[0, 1],
        )?,
        _ => {
            let mut args = vec!["diff", "--no-color", "-M", "HEAD", "--"];
            if let Some(old) = &change.old_path {
                args.push(old);
            }
            args.push(&change.path);
            run_git(git, &toplevel, &args)?
        }
    };
    Ok(bounded(diff))
}

/// True for a plain relative path inside the repository.
fn is_inside(path: &str) -> bool {
    let path = Path::new(path);
    !path.as_os_str().is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)))
}

/// Commits `files` (paths from `list_changes`) with `message`, leaving every
/// other change uncommitted; returns the new commit's short hash.
pub fn commit_files(
    git: &Path,
    dir: &Path,
    files: &[String],
    message: &str,
) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Write a commit message first".to_string());
    }
    if files.is_empty() {
        return Err("No files are chosen to commit".to_string());
    }
    let toplevel = toplevel_of(git, dir)?;
    // Only files git itself reports as changed can be committed, which also
    // keeps out paths outside the repository and anything git could read as an option.
    let changed: Vec<String> = list_changes(git, &toplevel)?
        .into_iter()
        .flat_map(|c| std::iter::once(c.path).chain(c.old_path))
        .collect();
    if let Some(bad) = files.iter().find(|f| !is_inside(f) || !changed.contains(f)) {
        return Err(format!("{bad} is not a changed file in this repository"));
    }

    let mut add = vec!["add", "-A", "--"];
    add.extend(files.iter().map(String::as_str));
    run_git(git, &toplevel, &add).map_err(|e| format!("Could not stage the files: {e}"))?;
    let mut commit = vec!["commit", "-m", message, "--"];
    commit.extend(files.iter().map(String::as_str));
    run_git(git, &toplevel, &commit).map_err(|e| format!("Could not commit: {e}"))?;
    run_git(git, &toplevel, &["rev-parse", "--short", "HEAD"]).map(|hash| hash.trim().to_string())
}

/// The uncommitted changes in the repository a session's folder is in.
#[tauri::command(async)]
pub fn session_changes(
    store: State<'_, AppStore>,
    path: String,
) -> Result<Vec<FileChange>, String> {
    ensure_known_workspace(&path, |p| store.is_known_workspace(p))?;
    list_changes(&git_binary(), Path::new(&path))
}

/// One changed file's diff.
#[tauri::command(async)]
pub fn session_file_diff(
    store: State<'_, AppStore>,
    path: String,
    change: FileChange,
) -> Result<String, String> {
    ensure_known_workspace(&path, |p| store.is_known_workspace(p))?;
    if !is_inside(&change.path)
        || change
            .old_path
            .as_deref()
            .is_some_and(|old| !is_inside(old))
    {
        return Err(format!("{} is not a file in this repository", change.path));
    }
    file_diff(&git_binary(), Path::new(&path), &change)
}

/// Commits the chosen changed files.
#[tauri::command(async)]
pub fn commit_session_changes(
    store: State<'_, AppStore>,
    path: String,
    files: Vec<String>,
    message: String,
) -> Result<String, String> {
    ensure_known_workspace(&path, |p| store.is_known_workspace(p))?;
    commit_files(&git_binary(), Path::new(&path), &files, &message)
}
