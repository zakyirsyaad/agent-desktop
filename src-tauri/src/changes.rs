//! The uncommitted changes in a session's repository: listing them, showing
//! one file's diff, and committing a chosen set of files.
//!
//! Every path the UI sends back is checked against what `git status` reports,
//! and git reads paths literally, so a file named `*.txt` is that file alone.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::files::ensure_known_workspace;
use crate::git_info::git_binary;
use crate::store::AppStore;

/// The longest diff sent to the UI, in characters; a bigger one is cut.
const MAX_DIFF_CHARS: usize = 200_000;
/// How much of git's diff output is read at most: enough for the longest
/// diff in any text, and a bound on memory however big the file is.
const MAX_DIFF_BYTES: usize = MAX_DIFF_CHARS * 4;

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

/// git, reading paths literally rather than as patterns.
fn git_command(git: &Path, dir: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(git);
    command
        .arg("--literal-pathspecs")
        .arg("-C")
        .arg(dir)
        .args(args);
    command
}

/// Runs git in `dir`; `ok_codes` are the exit codes that mean success.
fn run_git_with(git: &Path, dir: &Path, args: &[&str], ok_codes: &[i32]) -> Result<String, String> {
    let output = git_command(git, dir, args)
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

/// Runs git and reads at most `MAX_DIFF_BYTES` of its output; the flag says
/// whether there was more, in which case git is stopped rather than drained.
fn run_git_bounded(
    git: &Path,
    dir: &Path,
    args: &[&str],
    ok_codes: &[i32],
) -> Result<(String, bool), String> {
    let mut child = git_command(git, dir, args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not run git: {e}"))?;
    // stderr is read on its own thread, so a chatty git cannot block on it.
    let stderr = child.stderr.take().map(|mut pipe| {
        thread::spawn(move || {
            let mut text = String::new();
            let _ = pipe.read_to_string(&mut text);
            text
        })
    });
    let mut output = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        stdout
            .take(MAX_DIFF_BYTES as u64 + 1)
            .read_to_end(&mut output)
            .map_err(|e| format!("Could not read git's output: {e}"))?;
    }
    let is_cut = output.len() > MAX_DIFF_BYTES;
    if is_cut {
        output.truncate(MAX_DIFF_BYTES);
        // Stopping git closes its pipes; failing to is no worse than waiting.
        let _ = child.kill();
    }
    let status = child
        .wait()
        .map_err(|e| format!("Could not run git: {e}"))?;
    let errors = stderr
        .and_then(|reader| reader.join().ok())
        .unwrap_or_default();
    if !is_cut && !status.code().is_some_and(|code| ok_codes.contains(&code)) {
        return Err(errors.trim().to_string());
    }
    Ok((String::from_utf8_lossy(&output).into_owned(), is_cut))
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

fn changes_at(git: &Path, toplevel: &Path) -> Result<Vec<FileChange>, String> {
    let output = run_git(
        git,
        toplevel,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    Ok(parse_status(&output))
}

/// Every uncommitted change in the repository `dir` is in, untracked files
/// one by one rather than as whole folders.
pub fn list_changes(git: &Path, dir: &Path) -> Result<Vec<FileChange>, String> {
    changes_at(git, &toplevel_of(git, dir)?)
}

/// What the working tree is compared with: the last commit, or an empty tree
/// in a repository that has none yet.
fn diff_base(git: &Path, toplevel: &Path) -> Result<String, String> {
    if run_git(git, toplevel, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok() {
        return Ok("HEAD".to_string());
    }
    run_git(git, toplevel, &["hash-object", "-t", "tree", "/dev/null"])
        .map(|hash| hash.trim().to_string())
}

/// True when `path` resolves to a place inside `toplevel`, links followed.
fn resolves_inside(toplevel: &Path, path: &str) -> bool {
    let (Ok(root), Ok(target)) = (toplevel.canonicalize(), toplevel.join(path).canonicalize())
    else {
        return false;
    };
    target.starts_with(root)
}

/// A changed file's unified diff against the last commit; a new file shows
/// whole. Only a file git reports as changed is shown, and a new file only
/// when it resolves inside the repository, so nothing outside can be read.
pub fn file_diff(git: &Path, dir: &Path, path: &str) -> Result<String, String> {
    let toplevel = toplevel_of(git, dir)?;
    let change = changes_at(git, &toplevel)?
        .into_iter()
        .find(|change| change.path == path)
        .ok_or_else(|| format!("{path} is not a changed file in this repository"))?;
    let (diff, is_cut) = match change.kind {
        ChangeKind::Untracked => {
            if !resolves_inside(&toplevel, &change.path) {
                return Err(format!(
                    "{path} points outside the repository, so it is not shown"
                ));
            }
            // `--no-index` exits with 1 when the files differ, which they always do here.
            run_git_bounded(
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
            )?
        }
        _ => {
            let base = diff_base(git, &toplevel)?;
            let mut args = vec!["diff", "--no-color", "-M", base.as_str(), "--"];
            if let Some(old) = &change.old_path {
                args.push(old);
            }
            args.push(&change.path);
            run_git_bounded(git, &toplevel, &args, &[0])?
        }
    };
    Ok(bounded(diff, is_cut))
}

/// Cuts a diff to `MAX_DIFF_CHARS`, on a character boundary, and says so.
fn bounded(diff: String, is_cut: bool) -> String {
    if !is_cut && diff.chars().count() <= MAX_DIFF_CHARS {
        return diff;
    }
    let kept: String = diff.chars().take(MAX_DIFF_CHARS).collect();
    format!("{kept}\n… diff cut: it is longer than {MAX_DIFF_CHARS} characters\n")
}

/// True for a plain relative path inside the repository.
fn is_inside(path: &str) -> bool {
    let path = Path::new(path);
    !path.as_os_str().is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)))
}

/// Commits `files` (paths from `list_changes`, a rename's old path included)
/// with `message`, leaving every other change uncommitted; returns the new
/// commit's short hash.
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
    let changes = changes_at(git, &toplevel)?;
    // Only files git itself reports as changed can be committed, which also
    // keeps out paths outside the repository and anything git could read as an option.
    let is_changed = |file: &String| {
        changes
            .iter()
            .any(|c| &c.path == file || c.old_path.as_ref() == Some(file))
    };
    if let Some(bad) = files.iter().find(|f| !is_inside(f) || !is_changed(f)) {
        return Err(format!("{bad} is not a changed file in this repository"));
    }

    // A rename's old path is already staged as removed; `git add` would find
    // nothing there and fail, but the commit still needs it.
    let staged_removals: Vec<&String> =
        changes.iter().filter_map(|c| c.old_path.as_ref()).collect();
    let mut add = vec!["add", "-A", "--"];
    add.extend(
        files
            .iter()
            .filter(|f| !staged_removals.contains(f))
            .map(String::as_str),
    );
    if add.len() > 3 {
        run_git(git, &toplevel, &add).map_err(|e| format!("Could not stage the files: {e}"))?;
    }
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

/// One changed file's diff, by its path relative to the repository's root.
#[tauri::command(async)]
pub fn session_file_diff(
    store: State<'_, AppStore>,
    path: String,
    file: String,
) -> Result<String, String> {
    ensure_known_workspace(&path, |p| store.is_known_workspace(p))?;
    if !is_inside(&file) {
        return Err(format!("{file} is not a file in this repository"));
    }
    file_diff(&git_binary(), Path::new(&path), &file)
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
