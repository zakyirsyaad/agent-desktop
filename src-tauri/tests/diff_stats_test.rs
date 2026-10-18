use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use zorvo_lib::changes::ChangeKind;
use zorvo_lib::diff_stats::{diff_stats, diff_targets, BaseBranch, DiffTarget, FileStat};

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

fn temp_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!("zorvo-stats-{tag}-{}-{nanos}", std::process::id()))
}

/// A repository with three committed files.
fn repo(tag: &str) -> PathBuf {
    let repo = temp_dir(tag);
    fs::create_dir_all(repo.join("src")).expect("create repo");
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    git(&repo, &["config", "user.name", "Test"]);
    fs::write(repo.join("src/app.ts"), "one\ntwo\nthree\n").expect("write");
    fs::write(repo.join("old.md"), "moving\n").expect("write");
    fs::write(repo.join("gone.txt"), "bye\n").expect("write");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    repo
}

fn git_path() -> PathBuf {
    PathBuf::from("git")
}

fn stat_of<'a>(stats: &'a [FileStat], path: &str) -> &'a FileStat {
    stats
        .iter()
        .find(|s| s.path == path)
        .unwrap_or_else(|| panic!("no stat for {path}: {stats:?}"))
}

#[test]
fn counts_added_and_removed_lines_per_file_against_head() {
    let repo = repo("counts");
    fs::write(repo.join("src/app.ts"), "one\nTWO\nthree\nfour\n").expect("modify");
    fs::remove_file(repo.join("gone.txt")).expect("delete");

    let stats = diff_stats(&git_path(), &repo, DiffTarget::Head).expect("stats");

    let app = stat_of(&stats, "src/app.ts");
    assert_eq!((app.added, app.removed), (2, 1));
    assert_eq!(app.kind, ChangeKind::Modified);
    let gone = stat_of(&stats, "gone.txt");
    assert_eq!((gone.added, gone.removed), (0, 1));
    assert_eq!(gone.kind, ChangeKind::Deleted);
    let paths: Vec<&str> = stats.iter().map(|s| s.path.as_str()).collect();
    assert_eq!(paths, ["gone.txt", "src/app.ts"]);
}

#[test]
fn counts_untracked_files_whole() {
    let repo = repo("untracked");
    fs::write(repo.join("new.md"), "a\nb\nc").expect("write");
    fs::write(repo.join("bin.dat"), [0u8, 1, 2]).expect("write");

    let stats = diff_stats(&git_path(), &repo, DiffTarget::Head).expect("stats");

    let new = stat_of(&stats, "new.md");
    assert_eq!((new.added, new.removed), (3, 0));
    assert_eq!(new.kind, ChangeKind::Untracked);
    assert!(!new.is_binary);
    let bin = stat_of(&stats, "bin.dat");
    assert!(bin.is_binary);
    assert_eq!(bin.added, 0);
}

#[test]
fn reads_paths_with_spaces_and_unicode() {
    let repo = repo("paths");
    fs::write(repo.join("my file.ts"), "x\n").expect("write");
    fs::write(repo.join("ü.ts"), "y\n").expect("write");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "more"]);
    fs::write(repo.join("my file.ts"), "x\nx2\n").expect("modify");
    fs::write(repo.join("ü.ts"), "y\ny2\n").expect("modify");

    let stats = diff_stats(&git_path(), &repo, DiffTarget::Head).expect("stats");

    assert_eq!(stat_of(&stats, "my file.ts").added, 1);
    assert_eq!(stat_of(&stats, "ü.ts").added, 1);
}

#[test]
fn offers_main_as_base_only_on_another_branch() {
    let repo = repo("base");
    let on_main = diff_targets(&git_path(), &repo).expect("targets");
    assert_eq!(on_main.base, None);

    git(&repo, &["checkout", "-q", "-b", "feat"]);
    fs::write(repo.join("src/app.ts"), "one\nTWO\nthree\n").expect("modify");
    git(&repo, &["commit", "-q", "-am", "feature"]);
    fs::write(repo.join("old.md"), "moving\nmore\n").expect("modify");

    let targets = diff_targets(&git_path(), &repo).expect("targets");
    assert_eq!(
        targets.base,
        Some(BaseBranch {
            name: "main".to_string()
        })
    );
    let against_base = diff_stats(&git_path(), &repo, DiffTarget::Base).expect("stats");
    let against_head = diff_stats(&git_path(), &repo, DiffTarget::Head).expect("stats");
    stat_of(&against_base, "src/app.ts");
    stat_of(&against_base, "old.md");
    assert_eq!(
        against_head
            .iter()
            .map(|s| s.path.as_str())
            .collect::<Vec<_>>(),
        ["old.md"]
    );
}

#[test]
fn prefers_origin_head_for_the_base_name() {
    let repo = repo("origin");
    git(&repo, &["branch", "develop"]);
    git(
        &repo,
        &["update-ref", "refs/remotes/origin/develop", "develop"],
    );
    git(
        &repo,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/develop",
        ],
    );
    git(&repo, &["checkout", "-q", "-b", "feat"]);

    let targets = diff_targets(&git_path(), &repo).expect("targets");

    assert_eq!(
        targets.base,
        Some(BaseBranch {
            name: "develop".to_string()
        })
    );
}

#[test]
fn compares_with_the_remote_branch_when_there_is_no_local_one() {
    let repo = repo("remote-only");
    git(
        &repo,
        &["update-ref", "refs/remotes/origin/develop", "HEAD"],
    );
    git(
        &repo,
        &[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/develop",
        ],
    );
    git(&repo, &["checkout", "-q", "-b", "feat"]);
    fs::write(repo.join("src/app.ts"), "one\nTWO\nthree\n").expect("write");
    git(&repo, &["commit", "-q", "-am", "feat"]);

    let targets = diff_targets(&git_path(), &repo).expect("targets");
    let stats = diff_stats(&git_path(), &repo, DiffTarget::Base).expect("stats");

    assert_eq!(
        targets.base,
        Some(BaseBranch {
            name: "develop".to_string()
        })
    );
    assert!(stats.iter().any(|s| s.path == "src/app.ts"));
}

#[test]
fn compares_with_the_branch_not_a_tag_of_the_same_name() {
    let repo = repo("tag-clash");
    git(&repo, &["checkout", "-q", "-b", "feat"]);
    fs::write(repo.join("src/app.ts"), "one\nTWO\nthree\n").expect("write");
    git(&repo, &["commit", "-q", "-am", "feat"]);
    // A tag named like the base branch, on the feature's own commit.
    git(&repo, &["tag", "main", "HEAD"]);

    let stats = diff_stats(&git_path(), &repo, DiffTarget::Base).expect("stats");

    assert!(stats.iter().any(|s| s.path == "src/app.ts"));
}

#[test]
fn offers_no_base_before_the_first_commit_or_when_detached() {
    let fresh = temp_dir("fresh");
    fs::create_dir_all(&fresh).expect("create");
    git(&fresh, &["init", "-q", "-b", "main"]);
    fs::write(fresh.join("a.txt"), "a\n").expect("write");

    let targets = diff_targets(&git_path(), &fresh).expect("targets");
    let stats = diff_stats(&git_path(), &fresh, DiffTarget::Head).expect("stats");
    assert_eq!(targets.base, None);
    stat_of(&stats, "a.txt");

    let detached = repo("detached");
    git(&detached, &["checkout", "-q", "--detach"]);
    let targets = diff_targets(&git_path(), &detached).expect("targets");
    assert_eq!(targets.base, None);
}

/// How long a stats read may take before it counts as stuck on a file.
const STUCK_AFTER: Duration = Duration::from_secs(20);

/// Reads the stats on another thread, so one stuck opening a file fails the
/// test instead of hanging it.
fn stats_within_limit(repo: &Path, target: DiffTarget) -> Option<Vec<FileStat>> {
    let (sender, receiver) = mpsc::channel();
    let dir = repo.to_path_buf();
    thread::spawn(move || {
        let _ = sender.send(diff_stats(&git_path(), &dir, target));
    });
    receiver
        .recv_timeout(STUCK_AFTER)
        .ok()
        .map(|stats| stats.expect("stats"))
}

#[test]
fn reads_the_stats_of_a_repository_holding_a_named_pipe_without_hanging() {
    let repo = repo("fifo");
    let status = Command::new("mkfifo")
        .arg(repo.join("pipe"))
        .status()
        .expect("run mkfifo");
    assert!(status.success(), "mkfifo failed");
    fs::write(repo.join("new.md"), "a\n").expect("write");

    let stats = stats_within_limit(&repo, DiffTarget::Head);
    fs::remove_dir_all(&repo).ok();

    let stats = stats.expect("reading the stats got stuck on the pipe");
    assert_eq!(stat_of(&stats, "new.md").added, 1);
}

#[cfg(unix)]
#[test]
fn keeps_an_unreadable_untracked_file_as_binary() {
    use std::os::unix::fs::PermissionsExt;

    let repo = repo("unreadable");
    let secret = repo.join("secret.txt");
    fs::write(&secret, "hidden\n").expect("write");
    fs::set_permissions(&secret, fs::Permissions::from_mode(0o000)).expect("chmod");

    let stats = diff_stats(&git_path(), &repo, DiffTarget::Head);
    fs::set_permissions(&secret, fs::Permissions::from_mode(0o644)).ok();
    fs::remove_dir_all(&repo).ok();

    let stats = stats.expect("stats");
    let secret = stat_of(&stats, "secret.txt");
    assert!(secret.is_binary);
    assert_eq!((secret.added, secret.removed), (0, 0));
}

#[test]
fn keeps_a_file_fingerprint_until_the_file_changes() {
    let repo = repo("fingerprint");
    fs::write(repo.join("src/app.ts"), "one\nTWO\nthree\n").expect("write");
    let first = diff_stats(&git_path(), &repo, DiffTarget::Head).expect("stats");
    let again = diff_stats(&git_path(), &repo, DiffTarget::Head).expect("stats");
    assert_eq!(
        stat_of(&first, "src/app.ts").fingerprint,
        stat_of(&again, "src/app.ts").fingerprint
    );

    // The same line counts, other contents: the diff to show is different.
    thread::sleep(Duration::from_millis(1100));
    fs::write(repo.join("src/app.ts"), "one\nTWX\nthree\n").expect("write");
    let edited = diff_stats(&git_path(), &repo, DiffTarget::Head).expect("stats");

    let (before, after) = (
        stat_of(&first, "src/app.ts"),
        stat_of(&edited, "src/app.ts"),
    );
    assert_eq!((before.added, before.removed), (after.added, after.removed));
    assert_ne!(before.fingerprint, after.fingerprint);
}

#[test]
fn changes_a_file_fingerprint_when_the_base_moves() {
    let repo = repo("fingerprint-base");
    fs::write(repo.join("src/app.ts"), "one\nTWO\nthree\n").expect("write");
    let first = diff_stats(&git_path(), &repo, DiffTarget::Head).expect("stats");

    // An unrelated commit: src/app.ts is untouched but now compared with another commit.
    fs::write(repo.join("old.md"), "moved on\n").expect("write");
    git(&repo, &["commit", "-q", "-m", "unrelated", "--", "old.md"]);
    let after = diff_stats(&git_path(), &repo, DiffTarget::Head).expect("stats");

    assert_ne!(
        stat_of(&first, "src/app.ts").fingerprint,
        stat_of(&after, "src/app.ts").fingerprint
    );
}
