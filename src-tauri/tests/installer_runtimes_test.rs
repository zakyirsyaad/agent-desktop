use std::collections::HashMap;
use std::fs;
use std::ops::Deref;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use zorvo_lib::installer::layout::ToolsDir;
use zorvo_lib::installer::runtimes::{
    installed_runtime, parse_manifest, parse_node_major, user_node_major, RuntimeKind,
    BUNDLED_RUNTIMES,
};

static COUNTER: AtomicU64 = AtomicU64::new(0);

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

fn temp_dir() -> TempDir {
    let dir = std::env::temp_dir().join(format!(
        "zorvo-runtimes-test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
}

fn script(dir: &Path, name: &str, body: &str) {
    let path = dir.join(name);
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn env_with_path(dir: &Path) -> HashMap<String, String> {
    HashMap::from([("PATH".to_string(), dir.to_string_lossy().into_owned())])
}

fn manifest_with(node_url: &str, uv_url: &str, sha: &str, bin: &str) -> String {
    format!(
        r#"{{
  "node": {{ "version": "24.1.0", "released": "2026-01-01", "targets": {{
    "darwin-aarch64": {{ "url": "{node_url}", "sha256": "{sha}", "size": 1, "bin": "{bin}" }} }} }},
  "uv": {{ "version": "0.1.0", "released": "2026-01-01", "targets": {{
    "darwin-aarch64": {{ "url": "{uv_url}", "sha256": "{sha}", "size": 1, "bin": "uv" }} }} }}
}}"#
    )
}

const NODE_URL: &str = "https://nodejs.org/dist/v24.1.0/node.tar.gz";
const UV_URL: &str = "https://github.com/astral-sh/uv/releases/download/0.1.0/uv.tar.gz";
const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

#[test]
fn the_committed_manifest_is_valid() {
    let manifest = parse_manifest(BUNDLED_RUNTIMES).unwrap();
    for kind in [RuntimeKind::Node, RuntimeKind::Uv] {
        let release = manifest.release(kind);
        assert!(release.targets.contains_key("darwin-aarch64"));
        assert!(release.targets.contains_key("darwin-x86_64"));
    }
}

#[test]
fn a_well_formed_manifest_parses() {
    assert!(parse_manifest(&manifest_with(NODE_URL, UV_URL, SHA, "node/bin")).is_ok());
}

#[test]
fn rejects_a_node_url_outside_nodejs_org() {
    let json = manifest_with(
        "https://evil.example/dist/v24.1.0/n.tar.gz",
        UV_URL,
        SHA,
        "b",
    );
    assert!(parse_manifest(&json).is_err());
}

#[test]
fn rejects_a_uv_url_outside_the_uv_releases() {
    let json = manifest_with(
        NODE_URL,
        "https://github.com/other/uv/releases/download/1/u.tgz",
        SHA,
        "b",
    );
    assert!(parse_manifest(&json).is_err());
}

#[test]
fn rejects_a_short_sha256() {
    let json = manifest_with(NODE_URL, UV_URL, &SHA[..63], "b");
    assert!(parse_manifest(&json).is_err());
}

#[test]
fn rejects_an_absolute_bin() {
    let json = manifest_with(NODE_URL, UV_URL, SHA, "/usr/bin");
    assert!(parse_manifest(&json).is_err());
}

#[test]
fn rejects_a_bin_with_parent_components() {
    let json = manifest_with(NODE_URL, UV_URL, SHA, "node/../../bin");
    assert!(parse_manifest(&json).is_err());
}

#[test]
fn parses_node_versions() {
    assert_eq!(parse_node_major("v22.0.0\n"), Some(22));
    assert_eq!(parse_node_major("v20.18.1"), Some(20));
    assert_eq!(parse_node_major("node"), None);
    assert_eq!(parse_node_major(""), None);
}

#[test]
fn user_node_major_needs_npx_beside_node() {
    let dir = temp_dir();
    script(&dir, "node", "echo v24.1.0");
    let env = env_with_path(&dir);
    assert_eq!(user_node_major(&env, Duration::from_secs(5)), None);
    script(&dir, "npx", "exit 0");
    assert_eq!(user_node_major(&env, Duration::from_secs(5)), Some(24));
}

#[test]
fn user_node_major_gives_up_after_the_timeout() {
    let dir = temp_dir();
    script(&dir, "node", "/bin/sleep 3; echo v24.1.0");
    script(&dir, "npx", "exit 0");
    let env = env_with_path(&dir);
    let started = std::time::Instant::now();
    assert_eq!(user_node_major(&env, Duration::from_secs(1)), None);
    assert!(started.elapsed() < Duration::from_millis(2500));
}

fn install(tools: &ToolsDir, version: &str, platform: &str, bin: &str) -> PathBuf {
    let dir = tools.node_dir(version, platform);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("install.json"),
        format!(r#"{{"source":"s","sha256":null,"installed_at":1,"bin":"{bin}"}}"#),
    )
    .unwrap();
    dir
}

#[test]
fn installed_runtime_prefers_the_pinned_version() {
    let data = temp_dir();
    let tools = ToolsDir::new(&data);
    let manifest = parse_manifest(&manifest_with(NODE_URL, UV_URL, SHA, "node-24/bin")).unwrap();
    install(&tools, "22.0.0", "darwin-aarch64", "old/bin");
    let pinned = install(&tools, "24.1.0", "darwin-aarch64", "ignored");
    let found = installed_runtime(&tools, RuntimeKind::Node, &manifest, "darwin-aarch64").unwrap();
    assert_eq!(found.version, "24.1.0");
    assert_eq!(found.bin_dir, pinned.join("node-24/bin"));
}

#[test]
fn installed_runtime_falls_back_to_an_older_install() {
    let data = temp_dir();
    let tools = ToolsDir::new(&data);
    let manifest = parse_manifest(&manifest_with(NODE_URL, UV_URL, SHA, "node-24/bin")).unwrap();
    let older = install(&tools, "22.5.0", "darwin-aarch64", "node-22/bin");
    // Another platform, and a crash leftover without install.json, are ignored.
    install(&tools, "23.0.0", "darwin-x86_64", "x/bin");
    fs::create_dir_all(tools.node_dir("24.1.0", "darwin-aarch64")).unwrap();
    let found = installed_runtime(&tools, RuntimeKind::Node, &manifest, "darwin-aarch64").unwrap();
    assert_eq!(found.version, "22.5.0");
    assert_eq!(found.bin_dir, older.join("node-22/bin"));
    assert!(installed_runtime(&tools, RuntimeKind::Uv, &manifest, "darwin-aarch64").is_none());
}
