use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use zorvo_lib::data_migration::{
    legacy_root_for, migrate_legacy_data, Migration, LEGACY_IDENTIFIER,
};

/// A parent directory unique to this process and call, holding both the
/// legacy and the new data directory the way the platform app-data dir does.
fn unique_parent(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before the unix epoch")
        .as_nanos();
    let parent = std::env::temp_dir().join(format!(
        "zorvo-migration-{}-{}-{}",
        tag,
        std::process::id(),
        nanos
    ));
    fs::create_dir_all(&parent).expect("create test parent dir");
    parent
}

fn write(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().expect("file has a parent")).expect("create parent dir");
    fs::write(path, contents).expect("write test file");
}

fn read(path: &Path) -> String {
    fs::read_to_string(path).expect("read test file")
}

/// A legacy data dir with the files a real Agent Desktop install leaves.
fn seed_legacy(parent: &Path) -> PathBuf {
    let legacy = parent.join(LEGACY_IDENTIFIER);
    write(&legacy.join("state.json"), r#"{"version":1}"#);
    write(&legacy.join("transcripts/s1.json"), "[1]");
    write(&legacy.join("handoffs/h1.md"), "# handoff");
    write(
        &legacy.join("worktrees/repo/fix/.git"),
        "gitdir: /elsewhere",
    );
    legacy
}

#[test]
fn legacy_root_is_a_sibling_of_the_new_root() {
    let new_root = Path::new("/Users/dev/Library/Application Support/xyz.zorvo.desktop");

    assert_eq!(
        legacy_root_for(new_root),
        Some(PathBuf::from(
            "/Users/dev/Library/Application Support/com.agentdesktop.app"
        ))
    );
}

#[test]
fn copies_state_transcripts_and_handoffs_into_an_empty_new_root() {
    let parent = unique_parent("copy");
    let legacy = seed_legacy(&parent);
    let new_root = parent.join("xyz.zorvo.desktop");

    let outcome = migrate_legacy_data(&legacy, &new_root).expect("migration succeeds");

    assert_eq!(outcome, Migration::Copied);
    assert_eq!(read(&new_root.join("state.json")), r#"{"version":1}"#);
    assert_eq!(read(&new_root.join("transcripts/s1.json")), "[1]");
    assert_eq!(read(&new_root.join("handoffs/h1.md")), "# handoff");
    assert!(!new_root.join("state.json.tmp").exists());
    fs::remove_dir_all(&parent).ok();
}

#[test]
fn leaves_the_legacy_root_untouched() {
    let parent = unique_parent("untouched");
    let legacy = seed_legacy(&parent);
    let new_root = parent.join("xyz.zorvo.desktop");

    migrate_legacy_data(&legacy, &new_root).expect("migration succeeds");

    assert_eq!(read(&legacy.join("state.json")), r#"{"version":1}"#);
    assert_eq!(read(&legacy.join("transcripts/s1.json")), "[1]");
    assert!(legacy.join("worktrees/repo/fix/.git").exists());
    fs::remove_dir_all(&parent).ok();
}

#[test]
fn does_not_copy_git_worktrees() {
    let parent = unique_parent("worktrees");
    let legacy = seed_legacy(&parent);
    let new_root = parent.join("xyz.zorvo.desktop");

    migrate_legacy_data(&legacy, &new_root).expect("migration succeeds");

    assert!(!new_root.join("worktrees").exists());
    fs::remove_dir_all(&parent).ok();
}

#[test]
fn skips_when_the_new_root_already_has_state() {
    let parent = unique_parent("has-state");
    let legacy = seed_legacy(&parent);
    let new_root = parent.join("xyz.zorvo.desktop");
    write(&new_root.join("state.json"), r#"{"version":1,"mine":true}"#);

    let outcome = migrate_legacy_data(&legacy, &new_root).expect("migration succeeds");

    assert_eq!(outcome, Migration::NotNeeded);
    assert_eq!(
        read(&new_root.join("state.json")),
        r#"{"version":1,"mine":true}"#
    );
    assert!(!new_root.join("transcripts").exists());
    fs::remove_dir_all(&parent).ok();
}

#[test]
fn skips_when_there_is_no_legacy_root() {
    let parent = unique_parent("no-legacy");
    let new_root = parent.join("xyz.zorvo.desktop");

    let outcome = migrate_legacy_data(&parent.join(LEGACY_IDENTIFIER), &new_root)
        .expect("migration succeeds");

    assert_eq!(outcome, Migration::NotNeeded);
    assert!(!new_root.exists());
    fs::remove_dir_all(&parent).ok();
}

#[test]
fn runs_only_once() {
    let parent = unique_parent("once");
    let legacy = seed_legacy(&parent);
    let new_root = parent.join("xyz.zorvo.desktop");

    let first = migrate_legacy_data(&legacy, &new_root).expect("first run succeeds");
    write(&legacy.join("transcripts/s2.json"), "[2]");
    let second = migrate_legacy_data(&legacy, &new_root).expect("second run succeeds");

    assert_eq!(first, Migration::Copied);
    assert_eq!(second, Migration::NotNeeded);
    assert!(!new_root.join("transcripts/s2.json").exists());
    fs::remove_dir_all(&parent).ok();
}

#[test]
fn finishes_a_copy_that_was_interrupted_before_state_json() {
    let parent = unique_parent("resume");
    let legacy = seed_legacy(&parent);
    let new_root = parent.join("xyz.zorvo.desktop");
    // A previous launch copied a transcript, then died before state.json.
    write(&new_root.join("transcripts/s1.json"), "[1");

    let outcome = migrate_legacy_data(&legacy, &new_root).expect("migration succeeds");

    assert_eq!(outcome, Migration::Copied);
    assert_eq!(read(&new_root.join("transcripts/s1.json")), "[1]");
    assert_eq!(read(&new_root.join("state.json")), r#"{"version":1}"#);
    fs::remove_dir_all(&parent).ok();
}
