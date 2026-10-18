use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use zorvo_lib::changes::{commit_files, file_diff, list_changes, ChangeKind, FileChange};
use zorvo_lib::diff_stats::DiffTarget;

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

/// A repository with three committed files.
fn repo(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let repo = std::env::temp_dir().join(format!(
        "zorvo-changes-{tag}-{}-{nanos}",
        std::process::id()
    ));
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

fn change(path: &str, kind: ChangeKind) -> FileChange {
    FileChange {
        path: path.to_string(),
        old_path: None,
        kind,
    }
}

#[test]
fn lists_every_kind_of_change_sorted_by_path() {
    let repo = repo("list");
    fs::write(repo.join("src/app.ts"), "one\n2\nthree\n").expect("modify");
    fs::remove_file(repo.join("gone.txt")).expect("delete");
    fs::write(repo.join("src/new file.ts"), "new\n").expect("untracked");
    fs::write(repo.join("staged.ts"), "staged\n").expect("added");
    git(&repo, &["add", "staged.ts"]);
    git(&repo, &["mv", "old.md", "new.md"]);

    let changes = list_changes(&git_path(), &repo).expect("list changes");

    assert_eq!(
        changes,
        vec![
            change("gone.txt", ChangeKind::Deleted),
            FileChange {
                path: "new.md".to_string(),
                old_path: Some("old.md".to_string()),
                kind: ChangeKind::Renamed
            },
            change("src/app.ts", ChangeKind::Modified),
            change("src/new file.ts", ChangeKind::Untracked),
            change("staged.ts", ChangeKind::Added),
        ]
    );
    fs::remove_dir_all(repo).ok();
}

#[test]
fn lists_the_whole_repository_from_a_subfolder_with_root_relative_paths() {
    let repo = repo("subfolder");
    fs::write(repo.join("old.md"), "edited\n").expect("modify");

    let changes = list_changes(&git_path(), &repo.join("src")).expect("list changes");

    assert_eq!(changes, vec![change("old.md", ChangeKind::Modified)]);
    fs::remove_dir_all(repo).ok();
}

#[test]
fn diffs_a_changed_file_against_the_last_commit_and_shows_a_new_one_whole() {
    let repo = repo("diff");
    fs::write(repo.join("src/app.ts"), "one\n2\nthree\n").expect("modify");
    fs::write(repo.join("notes.md"), "hello\nworld\n").expect("untracked");

    let modified = file_diff(&git_path(), &repo, "src/app.ts", DiffTarget::Head).expect("diff");
    let untracked = file_diff(&git_path(), &repo, "notes.md", DiffTarget::Head).expect("diff");

    assert!(modified.contains("-two\n+2\n"), "{modified}");
    assert!(untracked.contains("+hello\n+world\n"), "{untracked}");
    fs::remove_dir_all(repo).ok();
}

#[test]
fn commits_only_the_chosen_files() {
    let repo = repo("commit");
    fs::write(repo.join("src/app.ts"), "changed\n").expect("modify");
    fs::write(repo.join("notes.md"), "new\n").expect("untracked");
    fs::remove_file(repo.join("gone.txt")).expect("delete");

    let hash = commit_files(
        &git_path(),
        &repo,
        &["notes.md".to_string(), "gone.txt".to_string()],
        "Add notes",
    )
    .expect("commit");

    assert_eq!(git(&repo, &["log", "-1", "--format=%s"]), "Add notes");
    assert_eq!(git(&repo, &["rev-parse", "--short", "HEAD"]), hash);
    let left = list_changes(&git_path(), &repo).expect("list changes");
    assert_eq!(
        left,
        vec![change("src/app.ts", ChangeKind::Modified)],
        "the unchosen file stays uncommitted"
    );
    fs::remove_dir_all(repo).ok();
}

#[test]
fn refuses_paths_outside_the_repository_and_an_empty_message() {
    let repo = repo("refuse");
    fs::write(repo.join("src/app.ts"), "changed\n").expect("modify");

    let outside =
        commit_files(&git_path(), &repo, &["../escape.txt".to_string()], "x").unwrap_err();
    let absolute = commit_files(&git_path(), &repo, &["/etc/hosts".to_string()], "x").unwrap_err();
    let option = commit_files(&git_path(), &repo, &["--all".to_string()], "x").unwrap_err();
    let empty = commit_files(&git_path(), &repo, &["src/app.ts".to_string()], "  ").unwrap_err();
    let none = commit_files(&git_path(), &repo, &[], "Message").unwrap_err();

    assert!(outside.contains("not a changed file"), "{outside}");
    assert!(absolute.contains("not a changed file"), "{absolute}");
    assert!(option.contains("not a changed file"), "{option}");
    assert!(empty.contains("message"), "{empty}");
    assert!(none.contains("No files"), "{none}");
    assert_eq!(
        git(&repo, &["rev-list", "--count", "HEAD"]),
        "1",
        "nothing was committed"
    );
    fs::remove_dir_all(repo).ok();
}

#[test]
fn keeps_a_rename_from_a_very_short_name() {
    let repo = repo("short");
    fs::write(repo.join("a.c"), "x\n").expect("write");
    git(&repo, &["add", "a.c"]);
    git(&repo, &["commit", "-q", "-m", "short"]);
    git(&repo, &["mv", "a.c", "main.c"]);

    let changes = list_changes(&git_path(), &repo).expect("list changes");

    assert_eq!(
        changes,
        vec![FileChange {
            path: "main.c".to_string(),
            old_path: Some("a.c".to_string()),
            kind: ChangeKind::Renamed
        }]
    );
    fs::remove_dir_all(repo).ok();
}

#[test]
fn commits_a_file_named_like_a_pattern_and_nothing_it_would_match() {
    let repo = repo("literal");
    fs::write(repo.join("*.txt"), "star\n").expect("write");
    fs::write(repo.join("other.txt"), "other\n").expect("write");

    commit_files(
        &git_path(),
        &repo,
        &["*.txt".to_string()],
        "Add the star file",
    )
    .expect("commit");

    let left = list_changes(&git_path(), &repo).expect("list changes");
    assert_eq!(
        left,
        vec![change("other.txt", ChangeKind::Untracked)],
        "the unchosen .txt file stays out"
    );
    fs::remove_dir_all(repo).ok();
}

#[test]
fn commits_a_staged_rename() {
    let repo = repo("rename-commit");
    git(&repo, &["mv", "old.md", "new.md"]);

    commit_files(
        &git_path(),
        &repo,
        &["new.md".to_string(), "old.md".to_string()],
        "Rename the notes",
    )
    .expect("commit");

    assert_eq!(
        list_changes(&git_path(), &repo).expect("list changes"),
        vec![]
    );
    assert_eq!(
        git(&repo, &["log", "-1", "--format=%s"]),
        "Rename the notes"
    );
    fs::remove_dir_all(repo).ok();
}

#[test]
fn refuses_to_show_a_file_outside_the_repository_through_a_link() {
    let repo = repo("link");
    let outside = repo.with_extension("outside");
    fs::create_dir_all(&outside).expect("create outside folder");
    fs::write(outside.join("secret.txt"), "top secret\n").expect("write secret");
    std::os::unix::fs::symlink(&outside, repo.join("linked-dir")).expect("link a folder");
    std::os::unix::fs::symlink(outside.join("secret.txt"), repo.join("linked-file"))
        .expect("link a file");

    let through_folder = file_diff(
        &git_path(),
        &repo,
        "linked-dir/secret.txt",
        DiffTarget::Head,
    );
    let through_file = file_diff(&git_path(), &repo, "linked-file", DiffTarget::Head);

    assert!(through_folder.is_err(), "{through_folder:?}");
    assert!(
        !format!("{through_file:?}").contains("top secret"),
        "{through_file:?}"
    );
    fs::remove_dir_all(repo).ok();
    fs::remove_dir_all(outside).ok();
}

#[test]
fn diffs_a_staged_file_before_the_first_commit() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let repo = std::env::temp_dir().join(format!(
        "zorvo-changes-fresh-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&repo).expect("create repo");
    git(&repo, &["init", "-q", "-b", "main"]);
    fs::write(repo.join("first.md"), "hello\n").expect("write");
    git(&repo, &["add", "first.md"]);

    let diff = file_diff(&git_path(), &repo, "first.md", DiffTarget::Head).expect("diff");

    assert!(diff.contains("+hello"), "{diff}");
    fs::remove_dir_all(repo).ok();
}

#[test]
fn cuts_a_huge_diff_without_reading_it_all() {
    let repo = repo("huge");
    let line = "x".repeat(99) + "\n";
    fs::write(repo.join("big.txt"), line.repeat(50_000)).expect("write a 5 MB file");

    let diff = file_diff(&git_path(), &repo, "big.txt", DiffTarget::Head).expect("diff");

    assert!(
        diff.chars().count() < 210_000,
        "{} characters",
        diff.chars().count()
    );
    assert!(diff.contains("diff cut"), "the cut is said");
    fs::remove_dir_all(repo).ok();
}

#[test]
fn shows_where_a_new_link_points_even_when_nothing_is_there() {
    let repo = repo("dangling");
    std::os::unix::fs::symlink("missing/target.md", repo.join("dangling"))
        .expect("make a dangling link");

    let diff = file_diff(&git_path(), &repo, "dangling", DiffTarget::Head).expect("diff");

    assert!(diff.contains("+missing/target.md"), "{diff}");
    fs::remove_dir_all(repo).ok();
}

#[test]
fn diffs_against_the_merge_base_for_the_base_target() {
    let repo = repo("base-diff");
    git(&repo, &["checkout", "-q", "-b", "feat"]);
    fs::write(repo.join("src/app.ts"), "one\nTWO\nthree\n").expect("modify");
    git(&repo, &["commit", "-q", "-am", "feature"]);

    let against_base = file_diff(&git_path(), &repo, "src/app.ts", DiffTarget::Base).expect("diff");
    let against_head = file_diff(&git_path(), &repo, "src/app.ts", DiffTarget::Head);

    assert!(against_base.contains("+TWO"), "{against_base}");
    assert!(against_head
        .expect_err("not changed against head")
        .contains("is not a changed file"));
}

#[test]
fn base_target_shows_branch_and_untracked_files_and_refuses_unchanged_ones() {
    let repo = repo("base-members");
    git(&repo, &["checkout", "-q", "-b", "feat"]);
    git(&repo, &["mv", "old.md", "new.md"]);
    git(&repo, &["commit", "-q", "-m", "rename"]);
    fs::write(repo.join("fresh.txt"), "hello\n").expect("write");

    let renamed = file_diff(&git_path(), &repo, "new.md", DiffTarget::Base).expect("rename diff");
    let untracked =
        file_diff(&git_path(), &repo, "fresh.txt", DiffTarget::Base).expect("untracked diff");
    let unchanged = file_diff(&git_path(), &repo, "src/app.ts", DiffTarget::Base);
    let missing = file_diff(&git_path(), &repo, "nowhere.txt", DiffTarget::Base);

    assert!(renamed.contains("rename from old.md"), "{renamed}");
    assert!(untracked.contains("+hello"), "{untracked}");
    assert!(unchanged
        .expect_err("unchanged against base")
        .contains("is not a changed file"));
    assert!(missing
        .expect_err("not in the repository")
        .contains("is not a changed file"));
    fs::remove_dir_all(repo).ok();
}
