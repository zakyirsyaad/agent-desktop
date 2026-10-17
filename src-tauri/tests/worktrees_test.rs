use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use agent_desktop_lib::worktrees::{branch_slug, create_worktree, remove_worktree};

fn unique_temp_root(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before the unix epoch")
        .as_nanos();
    std::env::temp_dir()
        .join(format!(
            "agent-desktop-wt-{}-{}-{}",
            tag,
            std::process::id(),
            nanos
        ))
        .canonicalize_or_self()
}

trait CanonicalizeOrSelf {
    fn canonicalize_or_self(self) -> PathBuf;
}

impl CanonicalizeOrSelf for PathBuf {
    fn canonicalize_or_self(self) -> PathBuf {
        fs::create_dir_all(&self).expect("create temp root");
        self.canonicalize().expect("canonicalize temp root")
    }
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

/// A repository with one commit, and the folder worktrees go in.
fn repo(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
    let base = unique_temp_root(tag);
    let repo = base.join("my-app");
    fs::create_dir_all(repo.join("packages/web")).expect("create repo");
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.email", "test@example.com"]);
    git(&repo, &["config", "user.name", "Test"]);
    fs::write(repo.join("packages/web/README.md"), "hello\n").expect("write file");
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "init"]);
    (base.clone(), repo, base.join("worktrees"))
}

fn git_path() -> PathBuf {
    PathBuf::from("git")
}

#[test]
fn turns_a_session_title_into_a_branch_name() {
    assert_eq!(branch_slug("Fix the login bug!"), "fix-the-login-bug");
    assert_eq!(
        branch_slug("  Ünïcode / slashes \\ and  spaces "),
        "n-code-slashes-and-spaces"
    );
    assert_eq!(branch_slug("???"), "session");
    assert!(branch_slug(&"long ".repeat(40)).len() <= 40);
    assert!(!branch_slug(&"word ".repeat(40)).ends_with('-'));
}

#[test]
fn creates_a_worktree_on_a_new_branch_from_head() {
    let (base, repo, root) = repo("create");

    let worktree =
        create_worktree(&git_path(), &repo, &root, "Fix login").expect("create worktree");

    assert_eq!(worktree.branch, "agent/fix-login");
    assert_eq!(worktree.cwd, worktree.path);
    assert!(Path::new(&worktree.path)
        .join("packages/web/README.md")
        .is_file());
    assert_eq!(
        git(
            Path::new(&worktree.path),
            &["rev-parse", "--abbrev-ref", "HEAD"]
        ),
        "agent/fix-login"
    );
    assert!(Path::new(&worktree.path).starts_with(&root));
    fs::remove_dir_all(base).ok();
}

#[test]
fn picks_a_free_name_when_the_branch_exists() {
    let (base, repo, root) = repo("taken");
    let first = create_worktree(&git_path(), &repo, &root, "Fix login").expect("first");

    let second = create_worktree(&git_path(), &repo, &root, "Fix login").expect("second");

    assert_eq!(second.branch, "agent/fix-login-2");
    assert_ne!(first.path, second.path);
    fs::remove_dir_all(base).ok();
}

#[test]
fn keeps_the_subfolder_a_workspace_points_at() {
    let (base, repo, root) = repo("subfolder");

    let worktree =
        create_worktree(&git_path(), &repo.join("packages/web"), &root, "Docs").expect("create");

    assert_eq!(
        Path::new(&worktree.cwd),
        Path::new(&worktree.path).join("packages/web")
    );
    fs::remove_dir_all(base).ok();
}

#[test]
fn refuses_a_folder_that_is_not_a_repository() {
    let base = unique_temp_root("norepo");
    fs::create_dir_all(base.join("plain")).expect("create folder");

    let error = create_worktree(
        &git_path(),
        &base.join("plain"),
        &base.join("worktrees"),
        "x",
    )
    .unwrap_err();

    assert!(error.contains("not a git repository"), "{error}");
    fs::remove_dir_all(base).ok();
}

#[test]
fn removes_a_clean_worktree_but_keeps_its_branch() {
    let (base, repo, root) = repo("remove");
    let worktree = create_worktree(&git_path(), &repo, &root, "Cleanup").expect("create");

    remove_worktree(&git_path(), &repo, &root, Path::new(&worktree.path)).expect("remove");

    assert!(!Path::new(&worktree.path).exists());
    assert_eq!(
        git(&repo, &["branch", "--list", "agent/cleanup"]),
        "agent/cleanup"
    );
    fs::remove_dir_all(base).ok();
}

#[test]
fn keeps_a_worktree_with_uncommitted_changes() {
    let (base, repo, root) = repo("dirty");
    let worktree = create_worktree(&git_path(), &repo, &root, "Work").expect("create");
    fs::write(Path::new(&worktree.path).join("new.txt"), "draft\n").expect("write");

    let error = remove_worktree(&git_path(), &repo, &root, Path::new(&worktree.path)).unwrap_err();

    assert!(error.contains("uncommitted"), "{error}");
    assert!(Path::new(&worktree.path).join("new.txt").is_file());
    fs::remove_dir_all(base).ok();
}

#[test]
fn refuses_to_remove_a_folder_outside_the_worktrees_folder() {
    let (base, repo, root) = repo("outside");

    let error = remove_worktree(&git_path(), &repo, &root, &repo).unwrap_err();

    assert!(error.contains("not a session worktree"), "{error}");
    assert!(repo.join("packages/web/README.md").is_file());
    fs::remove_dir_all(base).ok();
}
