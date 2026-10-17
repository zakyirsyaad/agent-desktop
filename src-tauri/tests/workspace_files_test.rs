use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use agent_desktop_lib::workspace_files::{list_workspace_files, list_workspace_files_up_to};

fn unique_root(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "agent-desktop-files-{tag}-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&root).expect("create root");
    root
}

fn write(root: &Path, relative: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().expect("parent")).expect("create folders");
    fs::write(path, "x\n").expect("write file");
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .status()
        .expect("run git");
    assert!(status.success(), "git {args:?} failed");
}

#[test]
fn lists_a_repositorys_files_without_what_it_ignores() {
    let root = unique_root("repo");
    git(&root, &["init", "-q"]);
    write(&root, ".gitignore");
    fs::write(root.join(".gitignore"), "dist/\n*.log\n").expect("write ignore");
    write(&root, "src/app.ts");
    write(&root, "src/new file.ts");
    write(&root, "dist/bundle.js");
    write(&root, "debug.log");
    git(&root, &["add", ".gitignore", "src/app.ts"]);

    let files = list_workspace_files(Path::new("git"), &root).expect("list files");

    assert_eq!(files, vec![".gitignore", "src/app.ts", "src/new file.ts"]);
    fs::remove_dir_all(root).ok();
}

#[test]
fn walks_a_plain_folder_skipping_hidden_and_build_folders() {
    let root = unique_root("plain");
    write(&root, "notes.md");
    write(&root, "docs/guide.md");
    write(&root, ".cache/blob");
    write(&root, "node_modules/pkg/index.js");
    write(&root, "target/debug/app");

    let files = list_workspace_files(Path::new("git"), &root).expect("list files");

    assert_eq!(files, vec!["docs/guide.md", "notes.md"]);
    fs::remove_dir_all(root).ok();
}

#[test]
fn offers_only_files_that_exist_and_have_plain_names() {
    let root = unique_root("existing");
    git(&root, &["init", "-q"]);
    write(&root, "kept.ts");
    write(&root, "deleted.ts");
    write(&root, "bad\rname.ts");
    git(&root, &["add", "kept.ts", "deleted.ts"]);
    fs::remove_file(root.join("deleted.ts")).expect("delete a tracked file");

    let files = list_workspace_files(Path::new("git"), &root).expect("list files");

    assert_eq!(
        files,
        vec!["kept.ts"],
        "a deleted file and a name with a control character are left out"
    );
    fs::remove_dir_all(root).ok();
}

#[test]
fn stops_reading_git_at_the_limit() {
    let root = unique_root("limit");
    git(&root, &["init", "-q"]);
    for name in ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] {
        write(&root, name);
    }

    let files = list_workspace_files_up_to(Path::new("git"), &root, 2).expect("list files");

    assert_eq!(files.len(), 2);
    fs::remove_dir_all(root).ok();
}
