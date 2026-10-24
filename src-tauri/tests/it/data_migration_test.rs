use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use zorvo_lib::data_migration::{
    legacy_root_for, migrate_legacy_data, migrated_from_legacy, open_store, Migration,
    LEGACY_IDENTIFIER,
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

#[test]
fn skips_when_the_legacy_root_has_no_state_json() {
    let parent = unique_parent("no-legacy-state");
    let legacy = parent.join(LEGACY_IDENTIFIER);
    write(&legacy.join("transcripts/s1.json"), "[old]");
    let new_root = parent.join("xyz.zorvo.desktop");
    write(&new_root.join("transcripts/s1.json"), "[new]");

    let outcome = migrate_legacy_data(&legacy, &new_root).expect("migration succeeds");

    assert_eq!(outcome, Migration::NotNeeded);
    assert_eq!(read(&new_root.join("transcripts/s1.json")), "[new]");
    fs::remove_dir_all(&parent).ok();
}

#[cfg(unix)]
#[test]
fn does_not_follow_symlinks_out_of_the_legacy_root() {
    let parent = unique_parent("symlink");
    let legacy = seed_legacy(&parent);
    let outside = parent.join("outside");
    write(&outside.join("secret.txt"), "private");
    std::os::unix::fs::symlink(&outside, legacy.join("transcripts/linked")).expect("symlink");
    let new_root = parent.join("xyz.zorvo.desktop");

    migrate_legacy_data(&legacy, &new_root).expect("migration succeeds");

    assert!(!new_root.join("transcripts/linked").exists());
    assert_eq!(read(&new_root.join("transcripts/s1.json")), "[1]");
    fs::remove_dir_all(&parent).ok();
}

#[test]
fn open_store_on_a_fresh_install_accepts_only_its_own_worktrees() {
    let parent = unique_parent("open-fresh");
    let new_root = parent.join("xyz.zorvo.desktop");

    let (store, migration) = open_store(new_root.clone());

    assert_eq!(migration, Ok(Migration::NotNeeded));
    assert_eq!(store.worktree_roots(), vec![new_root.join("worktrees")]);
    fs::remove_dir_all(&parent).ok();
}

#[test]
fn open_store_accepts_legacy_worktrees_after_a_migration_and_on_later_launches() {
    let parent = unique_parent("open-migrated");
    let legacy = seed_legacy(&parent);
    let new_root = parent.join("xyz.zorvo.desktop");
    let expected = vec![new_root.join("worktrees"), legacy.join("worktrees")];

    let (first, first_migration) = open_store(new_root.clone());
    let (later, later_migration) = open_store(new_root.clone());

    assert_eq!(first_migration, Ok(Migration::Copied));
    assert_eq!(later_migration, Ok(Migration::NotNeeded));
    assert_eq!(first.worktree_roots(), expected);
    assert_eq!(later.worktree_roots(), expected);
    fs::remove_dir_all(&parent).ok();
}

#[test]
fn open_store_ignores_legacy_worktrees_when_the_new_root_was_already_in_use() {
    let parent = unique_parent("open-in-use");
    seed_legacy(&parent);
    let new_root = parent.join("xyz.zorvo.desktop");
    write(&new_root.join("state.json"), r#"{"version":1,"mine":true}"#);

    let (store, migration) = open_store(new_root.clone());

    assert_eq!(migration, Ok(Migration::NotNeeded));
    assert!(!migrated_from_legacy(&new_root));
    assert_eq!(store.worktree_roots(), vec![new_root.join("worktrees")]);
    fs::remove_dir_all(&parent).ok();
}

#[cfg(unix)]
#[test]
fn retries_a_failed_copy_even_after_the_store_saved_state() {
    use std::os::unix::fs::PermissionsExt;

    let parent = unique_parent("retry");
    let legacy = seed_legacy(&parent);
    let new_root = parent.join("xyz.zorvo.desktop");
    let unreadable = legacy.join("transcripts/s1.json");
    fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).expect("chmod");

    let (failed_store, failed) = open_store(new_root.clone());
    // The app started empty and saved its own state before the next launch.
    write(
        &new_root.join("state.json"),
        r#"{"version":1,"empty":true}"#,
    );
    fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o644)).expect("chmod");
    let (store, retried) = open_store(new_root.clone());

    assert!(failed.is_err(), "{failed:?}");
    assert_eq!(
        failed_store.worktree_roots(),
        vec![new_root.join("worktrees")]
    );
    assert_eq!(retried, Ok(Migration::Copied));
    assert_eq!(read(&new_root.join("state.json")), r#"{"version":1}"#);
    assert_eq!(read(&new_root.join("transcripts/s1.json")), "[1]");
    assert!(migrated_from_legacy(&new_root));
    assert_eq!(store.worktree_roots().len(), 2);
    fs::remove_dir_all(&parent).ok();
}
