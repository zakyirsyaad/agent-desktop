use std::fs;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use zorvo_lib::installer::layout::{
    read_record, remove_path, CommitOutcome, InstallRecord, ToolsDir,
};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh, empty data dir unique to one test, removed when dropped.
struct TempDir(PathBuf);

impl Deref for TempDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn data_dir() -> TempDir {
    let dir = std::env::temp_dir().join(format!(
        "zorvo-layout-test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
}

fn record(source: &str) -> InstallRecord {
    InstallRecord {
        source: source.to_string(),
        sha256: Some("abc".to_string()),
        installed_at: 42,
        bin: Some("bin/x".to_string()),
    }
}

#[test]
fn paths_follow_the_spec_layout() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    assert_eq!(tools.root(), d.join("tools"));
    assert_eq!(tools.staging_root(), d.join("tools/staging"));
    assert_eq!(
        tools.agent_dir("opencode", "1.19.3"),
        d.join("tools/agents/opencode/1.19.3")
    );
    assert_eq!(
        tools.node_dir("24.11.1", "darwin-aarch64"),
        d.join("tools/node/24.11.1-darwin-aarch64")
    );
    assert_eq!(
        tools.uv_dir("0.9.0", "darwin-x86_64"),
        d.join("tools/uv/0.9.0-darwin-x86_64")
    );
    assert_eq!(
        tools.prereq_dir("npx", "24.11.1"),
        d.join("tools/prereqs/npx/24.11.1")
    );
}

#[test]
fn commit_moves_content_and_writes_the_record() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    let staging = tools.new_staging().unwrap();
    let staging_path = staging.path().to_path_buf();
    fs::write(staging.content_path().join("x"), "hi").unwrap();
    let dest = tools.agent_dir("opencode", "1.19.3");

    let outcome = staging
        .commit(&dest, &record("https://example.test/a"))
        .unwrap();

    assert_eq!(outcome, CommitOutcome::Installed);
    assert_eq!(fs::read_to_string(dest.join("x")).unwrap(), "hi");
    let read = read_record(&dest).unwrap();
    assert_eq!(read.source, "https://example.test/a");
    assert_eq!(read.installed_at, 42);
    assert!(!staging_path.exists());
}

#[test]
fn dropping_an_uncommitted_staging_deletes_it() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    let staging = tools.new_staging().unwrap();
    let path = staging.path().to_path_buf();
    fs::write(staging.download_path(), "partial").unwrap();
    assert!(path.exists());
    drop(staging);
    assert!(!path.exists());
}

#[test]
fn commit_onto_an_existing_dir_keeps_it_and_reports_already_present() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    let dest = tools.agent_dir("opencode", "1.19.3");
    fs::create_dir_all(&dest).unwrap();
    fs::write(dest.join("old"), "old").unwrap();
    let staging = tools.new_staging().unwrap();
    let staging_path = staging.path().to_path_buf();
    fs::write(staging.content_path().join("new"), "new").unwrap();

    let outcome = staging.commit(&dest, &record("s")).unwrap();

    assert_eq!(outcome, CommitOutcome::AlreadyPresent);
    assert!(dest.join("old").exists());
    assert!(!dest.join("new").exists());
    assert!(!staging_path.exists());
}

#[test]
fn two_stagings_get_different_dirs() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    let a = tools.new_staging().unwrap();
    let b = tools.new_staging().unwrap();
    assert_ne!(a.path(), b.path());
}

#[test]
fn remove_path_deletes_a_dir_or_a_file_and_never_follows_a_symlink() {
    let d = data_dir();
    let dir = d.join("dir");
    fs::create_dir_all(dir.join("inner")).unwrap();
    fs::write(dir.join("inner").join("file"), "x").unwrap();
    let file = d.join("file");
    fs::write(&file, "x").unwrap();
    let target = d.join("target");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("kept"), "x").unwrap();
    let link = d.join("link");
    std::os::unix::fs::symlink(&target, &link).unwrap();

    assert_eq!(remove_path(&dir), Ok(()));
    assert_eq!(remove_path(&file), Ok(()));
    assert_eq!(remove_path(&link), Ok(()));
    assert_eq!(
        remove_path(&d.join("missing")),
        Ok(()),
        "nothing there is fine"
    );

    assert!(!dir.exists() && !file.exists());
    assert!(fs::symlink_metadata(&link).is_err());
    assert!(
        target.join("kept").exists(),
        "the link's target is left alone"
    );
}
