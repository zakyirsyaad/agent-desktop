use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use zorvo_lib::git_info::{branch_of, display_location};

fn unique_temp_root(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before the unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "zorvo-git-{}-{}-{}",
        tag,
        std::process::id(),
        nanos
    ))
}

fn write(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
    fs::write(path, content).expect("write file");
}

#[test]
fn reads_the_branch_from_head() {
    let root = unique_temp_root("branch");
    write(&root.join(".git/HEAD"), "ref: refs/heads/feat/sidebar\n");

    assert_eq!(branch_of(&root), Some("feat/sidebar".to_string()));
    fs::remove_dir_all(&root).ok();
}

#[test]
fn finds_the_repository_from_a_subfolder() {
    let root = unique_temp_root("subfolder");
    write(&root.join(".git/HEAD"), "ref: refs/heads/main\n");
    fs::create_dir_all(root.join("packages/app")).expect("create subfolder");

    assert_eq!(
        branch_of(&root.join("packages/app")),
        Some("main".to_string())
    );
    fs::remove_dir_all(&root).ok();
}

#[test]
fn shows_a_short_commit_when_head_is_detached() {
    let root = unique_temp_root("detached");
    write(
        &root.join(".git/HEAD"),
        "0123456789abcdef0123456789abcdef01234567\n",
    );

    assert_eq!(branch_of(&root), Some("0123456".to_string()));
    fs::remove_dir_all(&root).ok();
}

#[test]
fn follows_a_worktree_git_file_to_its_head() {
    let root = unique_temp_root("worktree");
    let gitdir = root.join("main/.git/worktrees/wt");
    write(&gitdir.join("HEAD"), "ref: refs/heads/claude/wt\n");
    write(
        &root.join("wt/.git"),
        &format!("gitdir: {}\n", gitdir.display()),
    );

    assert_eq!(branch_of(&root.join("wt")), Some("claude/wt".to_string()));
    fs::remove_dir_all(&root).ok();
}

#[test]
fn has_no_branch_outside_a_repository_or_with_an_unreadable_head() {
    let root = unique_temp_root("none");
    fs::create_dir_all(&root).expect("create root");
    assert_eq!(branch_of(&root), None);

    write(&root.join("repo/.git/HEAD"), "garbage");
    assert_eq!(branch_of(&root.join("repo")), None);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn shows_the_parent_folder_relative_to_home() {
    let home = Path::new("/Users/mac");
    assert_eq!(
        display_location(Path::new("/Users/mac/developer/zorvo"), Some(home)),
        "~/developer"
    );
    assert_eq!(
        display_location(Path::new("/Users/mac/project"), Some(home)),
        "~"
    );
    assert_eq!(
        display_location(Path::new("/opt/work/app"), Some(home)),
        "/opt/work"
    );
    assert_eq!(
        display_location(Path::new("/Users/macbook/app"), Some(home)),
        "/Users/macbook"
    );
    assert_eq!(
        display_location(Path::new("/opt/work/app"), None),
        "/opt/work"
    );
}
