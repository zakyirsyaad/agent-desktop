//! Which commits the working tree can be compared with, and how many lines
//! each changed file adds and removes against that choice.

use std::collections::HashMap;
use std::fs::File;
use std::fs::Metadata;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::changes::{
    changes_at, diff_base, resolves_inside, run_git, run_git_with, toplevel_of, ChangeKind,
    FileChange,
};
use crate::files::ensure_known_workspace;
use crate::git_info::git_binary;
use crate::store::AppStore;

/// What the working tree is compared with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffTarget {
    /// The last commit.
    Head,
    /// Where this branch left the default branch.
    Base,
}

/// The default branch a session's branch can be compared with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaseBranch {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffTargets {
    pub base: Option<BaseBranch>,
}

/// One changed file and the lines it adds and removes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub old_path: Option<String>,
    pub kind: ChangeKind,
    pub added: u64,
    pub removed: u64,
    pub is_binary: bool,
    /// Changes whenever this file's diff may have: the base commit, or the
    /// file's size or modification time. Equal means the diff shown still holds.
    pub fingerprint: String,
}

/// How much of a file is read at a time when counting its lines.
const CHUNK_BYTES: usize = 64 * 1024;
/// How much of a file's start is searched for a NUL byte to tell it is binary.
const BINARY_SNIFF_BYTES: usize = 8 * 1024;
/// Names tried, in order, for the default branch when the remote names none.
const DEFAULT_BRANCHES: [&str; 2] = ["main", "master"];

fn git_succeeds(git: &Path, dir: &Path, args: &[&str]) -> bool {
    run_git(git, dir, args).is_ok()
}

/// A branch to compare with: its short name, and the full ref to read it
/// from, so a tag or a remote branch of the same name is never picked up.
struct BaseRef {
    name: String,
    reference: String,
}

fn ref_exists(git: &Path, toplevel: &Path, reference: &str) -> bool {
    git_succeeds(
        git,
        toplevel,
        &["rev-parse", "--verify", "--quiet", reference],
    )
}

/// The default branch: the remote's HEAD (read locally when that branch is
/// checked out here, else from the remote), else a local `main` or `master`.
fn default_branch(git: &Path, toplevel: &Path) -> Option<BaseRef> {
    let remote = run_git(
        git,
        toplevel,
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
    )
    .ok()
    .map(|name| name.trim().trim_start_matches("origin/").to_string())
    .filter(|name| !name.is_empty());
    if let Some(name) = remote {
        let local = format!("refs/heads/{name}");
        let tracking = format!("refs/remotes/origin/{name}");
        let reference = [local, tracking]
            .into_iter()
            .find(|reference| ref_exists(git, toplevel, reference))?;
        return Some(BaseRef { name, reference });
    }
    DEFAULT_BRANCHES.iter().find_map(|name| {
        let reference = format!("refs/heads/{name}");
        ref_exists(git, toplevel, &reference).then(|| BaseRef {
            name: name.to_string(),
            reference,
        })
    })
}

/// The default branch to compare with, when there is a point in doing so:
/// there is a commit, a branch is checked out other than the default one,
/// and the two share history.
fn base_branch(git: &Path, toplevel: &Path) -> Option<BaseRef> {
    if !git_succeeds(git, toplevel, &["rev-parse", "--verify", "--quiet", "HEAD"]) {
        return None;
    }
    let current = run_git(
        git,
        toplevel,
        &["symbolic-ref", "--quiet", "--short", "HEAD"],
    )
    .ok()?;
    let base = default_branch(git, toplevel)?;
    let shares_history = git_succeeds(git, toplevel, &["merge-base", &base.reference, "HEAD"]);
    (current.trim() != base.name && shares_history).then_some(base)
}

pub fn diff_targets(git: &Path, dir: &Path) -> Result<DiffTargets, String> {
    let toplevel = toplevel_of(git, dir)?;
    Ok(DiffTargets {
        base: base_branch(git, &toplevel).map(|base| BaseBranch { name: base.name }),
    })
}

/// The commit (or the empty tree, in a repository with none) the working tree
/// is compared with for `target`.
pub fn base_commit(git: &Path, toplevel: &Path, target: DiffTarget) -> Result<String, String> {
    match target {
        DiffTarget::Head => diff_base(git, toplevel),
        DiffTarget::Base => {
            let base = base_branch(git, toplevel)
                .ok_or_else(|| "There is no base branch to compare with".to_string())?;
            run_git(git, toplevel, &["merge-base", &base.reference, "HEAD"])
                .map(|hash| hash.trim().to_string())
        }
    }
}

fn kind_of_status(code: &str) -> ChangeKind {
    match code.chars().next() {
        Some('A') | Some('C') => ChangeKind::Added,
        Some('D') => ChangeKind::Deleted,
        Some('R') => ChangeKind::Renamed,
        _ => ChangeKind::Modified,
    }
}

/// Parses `git diff --name-status -z -M`: `M\0path\0`, and `R100\0old\0new\0`.
fn parse_name_status(output: &str) -> Vec<FileChange> {
    let mut changes = Vec::new();
    let mut pieces = output.split('\0').filter(|piece| !piece.is_empty());
    while let Some(code) = pieces.next() {
        let kind = kind_of_status(code);
        let is_pair = matches!(code.chars().next(), Some('R') | Some('C'));
        let first = pieces.next();
        let (old_path, path) = if is_pair {
            (first.map(str::to_string), pieces.next())
        } else {
            (None, first)
        };
        if let Some(path) = path {
            changes.push(FileChange {
                path: path.to_string(),
                old_path,
                kind,
            });
        }
    }
    changes
}

/// Lines added and removed, and whether the file is binary.
#[derive(Clone, Copy)]
struct Counts {
    added: u64,
    removed: u64,
    is_binary: bool,
}

/// Parses `git diff --numstat -z -M`: `added\tremoved\tpath\0`, and for a
/// rename `added\tremoved\t\0old\0new\0`; a binary file's counts are `-`.
fn parse_numstat(output: &str) -> HashMap<String, Counts> {
    let mut counts = HashMap::new();
    let mut pieces = output.split('\0').filter(|piece| !piece.is_empty());
    while let Some(record) = pieces.next() {
        let mut fields = record.splitn(3, '\t');
        let (Some(added), Some(removed), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            let _old = pieces.next();
            pieces.next().unwrap_or_default()
        } else {
            path
        };
        counts.insert(
            path.to_string(),
            Counts {
                added: added.parse().unwrap_or(0),
                removed: removed.parse().unwrap_or(0),
                is_binary: added == "-" && removed == "-",
            },
        );
    }
    counts
}

/// Tracked files that differ from `base`, by path only.
fn tracked_changes(git: &Path, toplevel: &Path, base: &str) -> Result<Vec<FileChange>, String> {
    run_git(
        git,
        toplevel,
        &["diff", "--name-status", "-z", "-M", base, "--"],
    )
    .map(|status| parse_name_status(&status))
}

/// Every file that differs from `base`, tracked or untracked, by path only:
/// no line is counted and no file is read.
pub(crate) fn changes_since(
    git: &Path,
    toplevel: &Path,
    base: &str,
) -> Result<Vec<FileChange>, String> {
    let mut changes = tracked_changes(git, toplevel, base)?;
    changes.extend(
        untracked_paths(git, toplevel)?
            .into_iter()
            .map(|path| FileChange {
                path,
                old_path: None,
                kind: ChangeKind::Untracked,
            }),
    );
    Ok(changes)
}

/// Tracked files that differ from `base`, with their line counts.
fn tracked_stats(git: &Path, toplevel: &Path, base: &str) -> Result<Vec<FileStat>, String> {
    let changes = tracked_changes(git, toplevel, base)?;
    let numstat = run_git(
        git,
        toplevel,
        &["diff", "--numstat", "-z", "-M", base, "--"],
    )?;
    let counts = parse_numstat(&numstat);
    Ok(changes
        .into_iter()
        .map(|change| {
            let found = counts.get(&change.path).copied();
            FileStat {
                added: found.map_or(0, |c| c.added),
                removed: found.map_or(0, |c| c.removed),
                is_binary: found.is_some_and(|c| c.is_binary),
                path: change.path,
                old_path: change.old_path,
                kind: change.kind,
                fingerprint: String::new(),
            }
        })
        .collect())
}

/// The untracked files, not counting what `.gitignore` leaves out.
fn untracked_paths(git: &Path, toplevel: &Path) -> Result<Vec<String>, String> {
    let output = run_git_with(
        git,
        toplevel,
        &["ls-files", "--others", "--exclude-standard", "-z"],
        &[0],
    )?;
    Ok(output
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_string)
        .collect())
}

/// Counts the lines of a file read in chunks: its newlines, plus one for a
/// last line that has none. A NUL in the first bytes makes it binary.
fn count_lines(path: &Path) -> std::io::Result<Counts> {
    let mut file = File::open(path)?;
    let mut buffer = vec![0u8; CHUNK_BYTES];
    let mut lines = 0u64;
    let mut seen = 0usize;
    let mut last_byte = None;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        if seen < BINARY_SNIFF_BYTES {
            let sniffed = &chunk[..chunk.len().min(BINARY_SNIFF_BYTES - seen)];
            if sniffed.contains(&0) {
                return Ok(Counts {
                    added: 0,
                    removed: 0,
                    is_binary: true,
                });
            }
        }
        seen += read;
        lines += chunk.iter().filter(|byte| **byte == b'\n').count() as u64;
        last_byte = chunk.last().copied();
    }
    if last_byte.is_some_and(|byte| byte != b'\n') {
        lines += 1;
    }
    Ok(Counts {
        added: lines,
        removed: 0,
        is_binary: false,
    })
}

/// How many untracked files' counts are remembered; past this the memory starts over.
const MAX_REMEMBERED_COUNTS: usize = 20_000;

/// A file's size and modification time: while both stay, its lines are not
/// read again (the same test git's index uses).
type Stamp = (u64, u128);

/// A file modified this recently may change again within the same timestamp
/// tick (2 s on exFAT) keeping its size, so its size and time prove nothing
/// yet: git calls such an entry "racily clean" and checks its contents.
const RACY_WITHIN: Duration = Duration::from_secs(3);

/// Whether `meta`'s modification time is too recent to trust.
fn is_racy(meta: &Metadata) -> bool {
    meta.modified()
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_none_or(|age| age < RACY_WITHIN)
}

fn stamp_of(meta: &Metadata) -> Option<Stamp> {
    if is_racy(meta) {
        return None;
    }
    let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some((meta.len(), modified.as_nanos()))
}

/// Untracked files' line counts by path, with the stamp they were read at.
fn remembered_counts() -> &'static Mutex<HashMap<PathBuf, (Stamp, Counts)>> {
    static COUNTS: OnceLock<Mutex<HashMap<PathBuf, (Stamp, Counts)>>> = OnceLock::new();
    COUNTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `count_lines` for a regular file, read only when it changed since the
/// last count; the counts are read on every focus, so a big untracked file
/// must not be read each time.
fn count_lines_once(path: &Path, meta: &Metadata) -> std::io::Result<Counts> {
    let Some(stamp) = stamp_of(meta) else {
        return count_lines(path);
    };
    if let Ok(counts) = remembered_counts().lock() {
        if let Some((seen, counts)) = counts.get(path) {
            if *seen == stamp {
                return Ok(*counts);
            }
        }
    }
    let counts = count_lines(path)?;
    if let Ok(mut remembered) = remembered_counts().lock() {
        if remembered.len() >= MAX_REMEMBERED_COUNTS {
            remembered.clear();
        }
        remembered.insert(path.to_path_buf(), (stamp, counts));
    }
    Ok(counts)
}

/// A file listed as changed whose lines are not counted: it cannot be read,
/// or it is not a regular file (a pipe or socket, which reading could block
/// on). It is kept as binary, so the UI still shows it, without contents.
const UNCOUNTED: Counts = Counts {
    added: 0,
    removed: 0,
    is_binary: true,
};

/// A new file counted whole; a new link is one line, where it points. A
/// file that cannot be read, or is not a regular file, is kept uncounted.
/// None for a path that resolves outside the repository, or no longer
/// resolves at all (it is gone).
fn untracked_stat(toplevel: &Path, path: String) -> Option<FileStat> {
    let full = toplevel.join(&path);
    let meta = full.symlink_metadata();
    let counts = match &meta {
        Ok(meta) if meta.file_type().is_symlink() => Counts {
            added: 1,
            removed: 0,
            is_binary: false,
        },
        _ if !resolves_inside(toplevel, &path) => return None,
        Ok(meta) if meta.file_type().is_file() => {
            count_lines_once(&full, meta).unwrap_or(UNCOUNTED)
        }
        _ => UNCOUNTED,
    };
    Some(FileStat {
        path,
        old_path: None,
        kind: ChangeKind::Untracked,
        added: counts.added,
        removed: counts.removed,
        is_binary: counts.is_binary,
        fingerprint: String::new(),
    })
}

fn untracked_stats(
    git: &Path,
    toplevel: &Path,
    target: DiffTarget,
) -> Result<Vec<FileStat>, String> {
    let paths = match target {
        DiffTarget::Head => changes_at(git, toplevel)?
            .into_iter()
            .filter(|change| change.kind == ChangeKind::Untracked)
            .map(|change| change.path)
            .collect(),
        DiffTarget::Base => untracked_paths(git, toplevel)?,
    };
    Ok(paths
        .into_iter()
        .filter_map(|path| untracked_stat(toplevel, path))
        .collect())
}

/// The changed files in the repository `dir` is in, against `target`, with
/// the lines each adds and removes, sorted by path.
pub fn diff_stats(git: &Path, dir: &Path, target: DiffTarget) -> Result<Vec<FileStat>, String> {
    let toplevel = toplevel_of(git, dir)?;
    let base = base_commit(git, &toplevel, target)?;
    let mut stats = tracked_stats(git, &toplevel, &base)?;
    stats.extend(untracked_stats(git, &toplevel, target)?);
    stats.sort_by(|a, b| a.path.cmp(&b.path));
    let base_id = run_git(git, &toplevel, &["rev-parse", &base])
        .map(|id| id.trim().to_string())
        .unwrap_or(base);
    Ok(stats
        .into_iter()
        .map(|stat| FileStat {
            fingerprint: fingerprint(&toplevel, &base_id, &stat.path),
            ..stat
        })
        .collect())
}

/// `base_id` with the size and modification time of `path` as it is now;
/// a file that is gone has neither. A file changed a moment ago gets a new
/// fingerprint on every read (see `is_racy`), so its diff is read again.
fn fingerprint(toplevel: &Path, base_id: &str, path: &str) -> String {
    let file = toplevel.join(path).symlink_metadata().ok().map(|meta| {
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |since| since.as_nanos());
        if is_racy(&meta) {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |since| since.as_nanos());
            format!("{}:{modified}:racy-{now}", meta.len())
        } else {
            format!("{}:{modified}", meta.len())
        }
    });
    format!("{base_id}:{}", file.unwrap_or_else(|| "gone".to_string()))
}

/// Which target comparisons are on offer for a session's folder.
#[tauri::command(async)]
pub fn session_diff_targets(
    store: State<'_, AppStore>,
    path: String,
) -> Result<DiffTargets, String> {
    ensure_known_workspace(&path, |p| store.is_known_workspace(p))?;
    diff_targets(&git_binary(), Path::new(&path))
}

/// Per-file line counts of a session's changes against `target`.
#[tauri::command(async)]
pub fn session_diff_stats(
    store: State<'_, AppStore>,
    path: String,
    target: DiffTarget,
) -> Result<Vec<FileStat>, String> {
    ensure_known_workspace(&path, |p| store.is_known_workspace(p))?;
    diff_stats(&git_binary(), Path::new(&path), target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn keeps_a_named_pipe_uncounted_without_opening_it() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("zorvo-stats-pipe-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create dir");
        let status = Command::new("mkfifo")
            .arg(dir.join("pipe"))
            .status()
            .expect("run mkfifo");
        assert!(status.success(), "mkfifo failed");

        // Opening a pipe with no writer blocks, so returning at all shows it was not opened.
        let stat = untracked_stat(&dir, "pipe".to_string());
        std::fs::remove_dir_all(&dir).ok();

        let stat = stat.expect("the pipe is listed");
        assert!(stat.is_binary);
        assert_eq!((stat.added, stat.removed), (0, 0));
        assert_eq!(stat.kind, ChangeKind::Untracked);
    }
}
