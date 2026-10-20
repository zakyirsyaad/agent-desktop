use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use zorvo_lib::branches::{ensure_no_live_session, local_branches, switch_to_branch};

fn unique_repo(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before the unix epoch")
        .as_nanos();
    let dir =
        std::env::temp_dir().join(format!("zorvo-br-{}-{}-{}", tag, std::process::id(), nanos));
    fs::create_dir_all(&dir).expect("create repo dir");
    dir.canonicalize().expect("canonicalize repo dir")
}

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

/// Commits `file` with `content`, `seconds` after a fixed date, so branch order is deterministic.
fn commit(repo: &Path, file: &str, content: &str, seconds: u64) {
    fs::write(repo.join(file), content).expect("write file");
    git(repo, &["add", "."]);
    let date = format!("{} +0000", 1_700_000_000 + seconds);
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["commit", "-q", "-m", file])
        .env("GIT_AUTHOR_DATE", &date)
        .env("GIT_COMMITTER_DATE", &date)
        .output()
        .expect("run git commit");
    assert!(output.status.success(), "git commit failed");
}

/// A repository on `main` with branches `older` and `newer`, `newer` committed last.
fn repo(tag: &str) -> PathBuf {
    let repo = unique_repo(tag);
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    git(&repo, &["config", "user.name", "Test"]);
    commit(&repo, "README.md", "hello\n", 0);
    git(&repo, &["switch", "-q", "-c", "older"]);
    commit(&repo, "older.txt", "older\n", 10);
    git(&repo, &["switch", "-q", "-c", "newer", "main"]);
    commit(&repo, "newer.txt", "newer\n", 20);
    git(&repo, &["switch", "-q", "main"]);
    repo
}

fn git_path() -> PathBuf {
    PathBuf::from("git")
}

fn current_branch(repo: &Path) -> String {
    git(repo, &["rev-parse", "--abbrev-ref", "HEAD"])
}

#[test]
fn lists_local_branches_most_recently_committed_first() {
    let repo = repo("list");

    let branches = local_branches(&git_path(), &repo).expect("list branches");

    assert_eq!(branches, vec!["newer", "older", "main"]);
    fs::remove_dir_all(repo).ok();
}

#[test]
fn lists_a_branch_by_its_full_name_when_a_tag_shares_it() {
    let repo = repo("tag");
    git(&repo, &["tag", "older"]);

    let branches = local_branches(&git_path(), &repo).expect("list branches");

    assert!(branches.contains(&"older".to_string()));
    fs::remove_dir_all(repo).ok();
}

#[test]
fn refuses_to_list_branches_outside_a_repository() {
    let dir = unique_repo("norepo");

    let error = local_branches(&git_path(), &dir).expect_err("not a repository");

    assert!(error.contains("not a git repository"), "{error}");
    fs::remove_dir_all(dir).ok();
}

#[test]
fn switches_the_folder_to_a_local_branch() {
    let repo = repo("switch");

    switch_to_branch(&git_path(), &repo, "older").expect("switch");

    assert_eq!(current_branch(&repo), "older");
    fs::remove_dir_all(repo).ok();
}

#[test]
fn carries_uncommitted_changes_that_do_not_conflict() {
    let repo = repo("carry");
    fs::write(repo.join("notes.txt"), "draft\n").expect("write untracked file");

    switch_to_branch(&git_path(), &repo, "older").expect("switch");

    assert_eq!(current_branch(&repo), "older");
    assert!(repo.join("notes.txt").is_file());
    fs::remove_dir_all(repo).ok();
}

#[test]
fn keeps_the_branch_when_git_refuses_a_conflicting_switch() {
    let repo = repo("conflict");
    git(&repo, &["switch", "-q", "older"]);
    fs::write(repo.join("older.txt"), "edited\n").expect("edit tracked file");

    let error = switch_to_branch(&git_path(), &repo, "main").expect_err("conflict");

    assert!(!error.is_empty());
    assert_eq!(current_branch(&repo), "older");
    fs::remove_dir_all(repo).ok();
}

#[test]
fn refuses_a_branch_that_does_not_exist_locally() {
    let repo = repo("missing");

    let error = switch_to_branch(&git_path(), &repo, "nope").expect_err("missing");

    assert!(error.contains("nope"), "{error}");
    assert_eq!(current_branch(&repo), "main");
    fs::remove_dir_all(repo).ok();
}

#[test]
fn refuses_a_name_git_would_read_as_an_option() {
    let repo = repo("option");

    for name in ["-", "--detach", "-c", ""] {
        assert!(
            switch_to_branch(&git_path(), &repo, name).is_err(),
            "accepted {name:?}"
        );
    }
    assert_eq!(current_branch(&repo), "main");
    fs::remove_dir_all(repo).ok();
}

#[test]
fn passes_git_s_own_message_when_branches_cannot_be_listed() {
    let dir = unique_repo("message");

    let error = local_branches(&git_path(), &dir).expect_err("not a repository");

    assert!(error.starts_with("fatal:"), "{error}");
    fs::remove_dir_all(dir).ok();
}

#[test]
fn a_live_session_anywhere_in_the_repository_blocks_a_switch() {
    let repo = repo("live-sibling");
    fs::create_dir_all(repo.join("api")).expect("create subfolder");
    fs::create_dir_all(repo.join("web")).expect("create subfolder");

    let error = ensure_no_live_session(&git_path(), &repo.join("web"), &[repo.join("api")])
        .expect_err("a sibling subfolder shares the checkout");

    assert!(error.contains("Worktree"), "{error}");
    fs::remove_dir_all(repo).ok();
}

#[test]
fn a_session_in_another_checkout_does_not_block_a_switch() {
    let repo = repo("live-elsewhere");
    let worktree = repo.with_extension("wt");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            &worktree.to_string_lossy(),
            "older",
        ],
    );
    let unrelated = unique_repo("unrelated");

    ensure_no_live_session(&git_path(), &repo, &[worktree.clone(), unrelated.clone()])
        .expect("a worktree and an unrelated folder have their own files");

    fs::remove_dir_all(&worktree).ok();
    fs::remove_dir_all(unrelated).ok();
    fs::remove_dir_all(repo).ok();
}

#[test]
fn a_live_session_in_a_worktree_blocks_switching_that_worktree() {
    let repo = repo("live-worktree");
    let worktree = repo.with_extension("wt");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            &worktree.to_string_lossy(),
            "older",
        ],
    );

    assert!(
        ensure_no_live_session(&git_path(), &worktree, std::slice::from_ref(&worktree)).is_err()
    );

    fs::remove_dir_all(&worktree).ok();
    fs::remove_dir_all(repo).ok();
}
