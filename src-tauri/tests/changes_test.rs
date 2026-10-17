use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use agent_desktop_lib::changes::{commit_files, file_diff, list_changes, ChangeKind, FileChange};

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
        "agent-desktop-changes-{tag}-{}-{nanos}",
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

    let modified = file_diff(
        &git_path(),
        &repo,
        &change("src/app.ts", ChangeKind::Modified),
    )
    .expect("diff");
    let untracked = file_diff(
        &git_path(),
        &repo,
        &change("notes.md", ChangeKind::Untracked),
    )
    .expect("diff");

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
