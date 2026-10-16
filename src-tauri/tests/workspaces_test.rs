use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use agent_desktop_lib::workspaces::{list_workspaces_in, Workspace};

/// Builds a root path that is unique to this process and this call, so tests
/// running in parallel (or a leftover directory from a killed run) cannot
/// collide.
fn unique_temp_root(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before the unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "agent-desktop-workspaces-{}-{}-{}",
        tag,
        std::process::id(),
        nanos
    ))
}

#[test]
fn lists_direct_child_directories_sorted_by_name() {
    let root = unique_temp_root("sorted");
    // Created out of alphabetical order to prove the result is sorted, not
    // merely following readdir order.
    fs::create_dir_all(root.join("beta")).expect("create beta");
    fs::create_dir_all(root.join("alpha")).expect("create alpha");
    fs::create_dir_all(root.join(".hidden")).expect("create .hidden");
    fs::write(root.join("notes.txt"), "not a workspace").expect("write notes.txt");

    let workspaces = list_workspaces_in(&root);

    assert_eq!(
        workspaces,
        vec![
            Workspace {
                name: "alpha".to_string(),
                path: root.join("alpha").to_string_lossy().to_string(),
            },
            Workspace {
                name: "beta".to_string(),
                path: root.join("beta").to_string_lossy().to_string(),
            },
        ]
    );

    fs::remove_dir_all(&root).expect("remove temp root");
}

#[test]
fn returns_empty_for_a_missing_root() {
    let root = unique_temp_root("missing").join("no-such-directory");

    assert!(!root.exists(), "test precondition: root must not exist");
    assert_eq!(list_workspaces_in(&root), Vec::new());
}
