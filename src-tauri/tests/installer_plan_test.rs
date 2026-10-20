use std::fs;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use zorvo_lib::installer::layout::ToolsDir;
use zorvo_lib::installer::plan::{InstalledTools, PlannedStep};
use zorvo_lib::installer::prerequisites::prerequisites_for;
use zorvo_lib::installer::runtimes::{parse_manifest, RuntimeKind, BUNDLED_RUNTIMES};

static COUNTER: AtomicU64 = AtomicU64::new(0);
const PLATFORM: &str = "darwin-aarch64";

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
        "zorvo-plan-test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
}

/// Makes `dir` look installed.
fn mark_installed(dir: &Path, bin: Option<&str>) {
    fs::create_dir_all(dir).unwrap();
    let bin = bin.map_or("null".to_string(), |b| format!("\"{b}\""));
    fs::write(
        dir.join("install.json"),
        format!(r#"{{"source":"test","sha256":null,"installed_at":1,"bin":{bin}}}"#),
    )
    .unwrap();
}

#[test]
fn scan_finds_agents_runtimes_and_prereqs() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    let manifest = parse_manifest(BUNDLED_RUNTIMES).unwrap();
    let pi = &prerequisites_for("pi-acp")[0];

    let node_dir = tools.node_dir(&manifest.node.version, PLATFORM);
    mark_installed(&node_dir, None);
    mark_installed(&tools.uv_dir(&manifest.uv.version, PLATFORM), None);
    let agent = tools.agent_dir("opencode", "1.19.3");
    mark_installed(&agent, None);
    mark_installed(&tools.prereq_dir(pi.command, pi.version), None);
    // A crash left these empty: they must not count.
    fs::create_dir_all(tools.agent_dir("opencode", "1.20.0")).unwrap();
    fs::create_dir_all(tools.prereq_dir(pi.command, "0.0.1")).unwrap();

    let found = InstalledTools::scan(&tools, &manifest, PLATFORM, Some(22));

    assert_eq!(found.user_node_major, Some(22));
    assert!(found.pinned_node_installed);
    assert!(found.pinned_uv_installed);
    assert_eq!(found.node.unwrap().version, manifest.node.version);
    assert_eq!(found.uv.unwrap().version, manifest.uv.version);
    assert_eq!(found.agents.len(), 1);
    assert_eq!(
        found.agents[&("opencode".to_string(), "1.19.3".to_string())],
        agent
    );
    assert_eq!(
        found.prereq_bins[pi.command],
        tools.prereq_dir(pi.command, pi.version).join("bin")
    );
    assert_eq!(found.manifest, Some(manifest));
}

#[test]
fn scan_of_an_empty_tools_dir_finds_nothing() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    let manifest = parse_manifest(BUNDLED_RUNTIMES).unwrap();

    let found = InstalledTools::scan(&tools, &manifest, PLATFORM, None);

    assert!(found.node.is_none() && found.uv.is_none());
    assert!(!found.pinned_node_installed && !found.pinned_uv_installed);
    assert!(found.agents.is_empty() && found.prereq_bins.is_empty());
    assert!(InstalledTools::none().manifest.is_none());
}

#[test]
fn scan_ignores_staging() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    let manifest = parse_manifest(BUNDLED_RUNTIMES).unwrap();
    let real = tools.agent_dir("opencode", "1.19.3");
    mark_installed(&real, None);
    mark_installed(&tools.staging_root().join("1-2-3/content"), None);
    // Shaped like real installs, but under staging.
    mark_installed(&tools.staging_root().join("agents/opencode/9.9.9"), None);
    mark_installed(&tools.staging_root().join("opencode/9.9.9"), None);

    let found = InstalledTools::scan(&tools, &manifest, PLATFORM, None);

    assert_eq!(found.agents.len(), 1);
    assert_eq!(
        found.agents[&("opencode".to_string(), "1.19.3".to_string())],
        real
    );
    assert!(found.node.is_none() && found.uv.is_none());
}

#[test]
fn dirs_without_install_json_do_not_count() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    let manifest = parse_manifest(BUNDLED_RUNTIMES).unwrap();
    let pi = &prerequisites_for("pi-acp")[0];
    fs::create_dir_all(tools.node_dir(&manifest.node.version, PLATFORM)).unwrap();
    fs::create_dir_all(tools.uv_dir(&manifest.uv.version, PLATFORM)).unwrap();
    fs::create_dir_all(tools.prereq_dir(pi.command, pi.version)).unwrap();

    let found = InstalledTools::scan(&tools, &manifest, PLATFORM, None);

    assert!(!found.pinned_node_installed);
    assert!(!found.pinned_uv_installed);
    assert!(found.node.is_none());
    assert!(found.uv.is_none());
    assert!(found.prereq_bins.is_empty());
}

#[test]
fn display_of_a_node_step_has_the_manifest_size() {
    let manifest = parse_manifest(BUNDLED_RUNTIMES).unwrap();

    let step = PlannedStep::Runtime(RuntimeKind::Node).display(Some(&manifest), PLATFORM);

    assert_eq!(step.kind, "node");
    assert_eq!(step.name, "Node.js");
    assert_eq!(step.version, manifest.node.version);
    assert_eq!(
        step.download_bytes,
        Some(manifest.node.targets[PLATFORM].size)
    );
}

#[test]
fn display_of_a_uv_step_without_a_manifest_has_no_size() {
    let step = PlannedStep::Runtime(RuntimeKind::Uv).display(None, PLATFORM);

    assert_eq!(step.kind, "uv");
    assert_eq!(step.name, "uv");
    assert_eq!(step.download_bytes, None);
}

#[test]
fn display_of_an_agent_step_has_no_size() {
    let step = PlannedStep::Agent {
        id: "opencode".into(),
        name: "OpenCode".into(),
        version: "1.19.3".into(),
        url: "https://example.com/a.tgz".into(),
        sha256: "0".repeat(64),
        cmd: "bin/opencode".into(),
    }
    .display(None, PLATFORM);

    assert_eq!(step.kind, "agent");
    assert_eq!(step.name, "OpenCode");
    assert_eq!(step.version, "1.19.3");
    assert_eq!(step.download_bytes, None);
}

#[test]
fn display_of_a_prerequisite_step_names_the_command() {
    let pi = &prerequisites_for("pi-acp")[0];

    let step = PlannedStep::Prerequisite(pi).display(None, PLATFORM);

    assert_eq!(step.kind, "prerequisite");
    assert_eq!(step.name, pi.command);
    assert_eq!(step.version, pi.version);
    assert_eq!(step.download_bytes, None);
}
