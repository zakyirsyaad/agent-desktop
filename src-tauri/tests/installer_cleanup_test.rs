use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::ops::Deref;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use zorvo_lib::installer::cleanup::{clean_up, cleanup_inputs, CleanupInputs};
use zorvo_lib::installer::layout::ToolsDir;
use zorvo_lib::installer::prerequisites::prerequisites_for;
use zorvo_lib::installer::runtimes::{parse_manifest, RuntimeManifest, BUNDLED_RUNTIMES};
use zorvo_lib::profiles::AgentProfile;
use zorvo_lib::store::Settings;

static COUNTER: AtomicU64 = AtomicU64::new(0);
const PLATFORM: &str = "darwin-aarch64";

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
        "zorvo-cleanup-test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
}

fn manifest() -> RuntimeManifest {
    parse_manifest(BUNDLED_RUNTIMES).expect("the bundled manifest parses")
}

/// Makes `dir` look installed.
fn mark_installed(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    fs::write(
        dir.join("install.json"),
        r#"{"source":"test","sha256":null,"installed_at":1,"bin":"bin"}"#,
    )
    .unwrap();
}

fn inputs() -> CleanupInputs {
    CleanupInputs {
        agents_in_use: BTreeMap::new(),
        uses_npx: true,
        uses_uvx: true,
        prereqs_needed: BTreeSet::new(),
    }
}

fn run(tools: &ToolsDir, inputs: &CleanupInputs) -> Vec<String> {
    clean_up(tools, &manifest(), PLATFORM, inputs, &|_| false)
}

fn pinned_node(tools: &ToolsDir) -> PathBuf {
    tools.node_dir(&manifest().node.version, PLATFORM)
}

fn pinned_uv(tools: &ToolsDir) -> PathBuf {
    tools.uv_dir(&manifest().uv.version, PLATFORM)
}

#[test]
fn empties_staging() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    let left = tools.new_staging().unwrap();
    fs::write(left.content_path().join("half"), "x").unwrap();
    std::mem::forget(left);
    fs::write(tools.staging_root().join("stray"), "x").unwrap();

    let errors = run(&tools, &inputs());

    assert!(errors.is_empty(), "{errors:?}");
    let left_over: Vec<_> = fs::read_dir(tools.staging_root())
        .map(|entries| entries.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    assert!(left_over.is_empty(), "{left_over:?}");
}

#[test]
fn removes_versions_not_in_use() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    mark_installed(&tools.agent_dir("opencode", "1.0.0"));
    mark_installed(&tools.agent_dir("opencode", "2.0.0"));
    let inputs = CleanupInputs {
        agents_in_use: BTreeMap::from([("opencode".to_string(), "2.0.0".to_string())]),
        ..inputs()
    };

    let errors = run(&tools, &inputs);

    assert!(errors.is_empty(), "{errors:?}");
    assert!(!tools.agent_dir("opencode", "1.0.0").exists());
    assert!(tools.agent_dir("opencode", "2.0.0").exists());
}

#[test]
fn keeps_a_version_an_agent_is_running_from_even_when_not_in_use() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    let running = tools.agent_dir("opencode", "1.0.0");
    mark_installed(&running);
    mark_installed(&tools.agent_dir("opencode", "2.0.0"));
    mark_installed(&tools.agent_dir("goose", "0.5.0"));
    // A refresh withdrew 1.0.0, so 2.0.0 is in use now, but a session
    // started before it still runs 1.0.0; goose is no longer enabled.
    let inputs = CleanupInputs {
        agents_in_use: BTreeMap::from([("opencode".to_string(), "2.0.0".to_string())]),
        ..inputs()
    };
    let program = running.join("opencode");

    let errors = clean_up(&tools, &manifest(), PLATFORM, &inputs, &|dir| {
        program.starts_with(dir)
    });

    assert!(errors.is_empty(), "{errors:?}");
    assert!(running.exists(), "the running version survives");
    assert!(tools.agent_dir("opencode", "2.0.0").exists());
    assert!(!tools.root().join("agents").join("goose").exists());
}

#[test]
fn removes_agents_not_enabled() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    mark_installed(&tools.agent_dir("opencode", "1.0.0"));
    mark_installed(&tools.agent_dir("goose", "1.0.0"));
    let inputs = CleanupInputs {
        agents_in_use: BTreeMap::from([("goose".to_string(), "1.0.0".to_string())]),
        ..inputs()
    };

    let errors = run(&tools, &inputs);

    assert!(errors.is_empty(), "{errors:?}");
    assert!(!tools.root().join("agents").join("opencode").exists());
    assert!(tools.agent_dir("goose", "1.0.0").exists());
}

#[test]
fn removes_an_old_runtime_once_the_pinned_one_is_installed() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    let old = tools.node_dir("20.0.0", PLATFORM);
    mark_installed(&old);
    mark_installed(&pinned_node(&tools));

    let errors = run(&tools, &inputs());

    assert!(errors.is_empty(), "{errors:?}");
    assert!(!old.exists());
    assert!(pinned_node(&tools).exists());
}

#[test]
fn keeps_an_old_runtime_while_the_pinned_one_is_missing() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    let old = tools.uv_dir("0.1.0", PLATFORM);
    mark_installed(&old);

    let errors = run(&tools, &inputs());

    assert!(errors.is_empty(), "{errors:?}");
    assert!(old.exists(), "it is the only uv Zorvo has");
}

#[test]
fn removes_node_when_no_enabled_agent_uses_npx() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    mark_installed(&pinned_node(&tools));
    mark_installed(&tools.node_dir("20.0.0", PLATFORM));
    mark_installed(&pinned_uv(&tools));
    let inputs = CleanupInputs {
        uses_npx: false,
        ..inputs()
    };

    let errors = run(&tools, &inputs);

    assert!(errors.is_empty(), "{errors:?}");
    assert!(!tools.root().join("node").exists());
    assert!(pinned_uv(&tools).exists(), "an agent still uses uvx");
}

#[test]
fn removes_uv_when_no_enabled_agent_uses_uvx() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    mark_installed(&pinned_uv(&tools));
    let inputs = CleanupInputs {
        uses_uvx: false,
        ..inputs()
    };

    let errors = run(&tools, &inputs);

    assert!(errors.is_empty(), "{errors:?}");
    assert!(!tools.root().join("uv").exists());
}

#[test]
fn removes_unneeded_prereqs() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    mark_installed(&tools.prereq_dir("pi", "1.1.0"));
    mark_installed(&tools.prereq_dir("other", "2.0.0"));
    let inputs = CleanupInputs {
        prereqs_needed: BTreeSet::from(["other".to_string()]),
        ..inputs()
    };

    let errors = run(&tools, &inputs);

    assert!(errors.is_empty(), "{errors:?}");
    assert!(!tools.root().join("prereqs").join("pi").exists());
    assert!(tools.prereq_dir("other", "2.0.0").exists());
}

#[test]
fn removes_old_versions_of_a_needed_prereq_once_the_pinned_one_is_installed() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    let pinned = prerequisites_for("pi-acp")[0].version;
    mark_installed(&tools.prereq_dir("pi", "0.9.0"));
    let inputs = CleanupInputs {
        prereqs_needed: BTreeSet::from(["pi".to_string()]),
        ..inputs()
    };

    // Until the pinned version is installed, the old one is what runs.
    let errors = run(&tools, &inputs);
    assert!(errors.is_empty(), "{errors:?}");
    assert!(tools.prereq_dir("pi", "0.9.0").exists());

    mark_installed(&tools.prereq_dir("pi", pinned));
    let errors = run(&tools, &inputs);

    assert!(errors.is_empty(), "{errors:?}");
    assert!(!tools.prereq_dir("pi", "0.9.0").exists());
    assert!(tools.prereq_dir("pi", pinned).exists());
}

/// Gives a dir its permissions back when dropped, so the temp dir can go.
struct Locked(PathBuf);

impl Drop for Locked {
    fn drop(&mut self) {
        let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755));
    }
}

#[test]
fn an_unremovable_dir_is_reported_not_fatal() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    let stuck = tools.staging_root().join("stuck");
    fs::create_dir_all(stuck.join("content")).unwrap();
    fs::set_permissions(&stuck, fs::Permissions::from_mode(0o555)).unwrap();
    let _restore = Locked(stuck.clone());
    mark_installed(&tools.agent_dir("opencode", "1.0.0"));

    let errors = run(&tools, &inputs());

    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(errors[0].contains("stuck"), "{errors:?}");
    assert!(
        !tools.root().join("agents").join("opencode").exists(),
        "the rest of the clean-up still ran"
    );
}

#[test]
fn a_missing_tools_dir_is_nothing_to_clean() {
    let d = data_dir();
    let tools = ToolsDir::new(&d);

    assert!(run(&tools, &inputs()).is_empty());
}

fn profile(id: &str, version: &str, distribution: &str) -> AgentProfile {
    let mut profile = AgentProfile::new(id, id, distribution);
    profile.version = Some(version.to_string());
    profile.distribution = Some(distribution.to_string());
    profile
}

#[test]
fn inputs_come_from_the_enabled_agents_and_their_versions_in_use() {
    let settings = Settings {
        enabled_agents: Some(vec![
            "opencode".to_string(),
            "pi-acp".to_string(),
            "goose".to_string(),
            "gone".to_string(),
            "never-run".to_string(),
        ]),
        agent_versions: BTreeMap::from([
            ("opencode".to_string(), "1.0.0".to_string()),
            // The catalog no longer has it, so the resolver runs the offered one.
            ("goose".to_string(), "9.9.9".to_string()),
            ("gone".to_string(), "3.0.0".to_string()),
        ]),
        ..Settings::default()
    };
    let profiles = [
        profile("opencode", "1.0.0", "binary"),
        profile("goose", "2.0.0", "binary"),
        profile("pi-acp", "0.5.0", "npx"),
        profile("fast-agent", "1.0.0", "uvx"),
    ];

    let inputs = cleanup_inputs(&settings, &profiles);

    assert_eq!(
        inputs.agents_in_use,
        BTreeMap::from([
            ("gone".to_string(), "3.0.0".to_string()),
            ("goose".to_string(), "2.0.0".to_string()),
            ("opencode".to_string(), "1.0.0".to_string()),
            ("pi-acp".to_string(), "0.5.0".to_string()),
        ])
    );
    assert!(inputs.uses_npx);
    assert!(!inputs.uses_uvx, "fast-agent is not enabled");
    assert_eq!(inputs.prereqs_needed, BTreeSet::from(["pi".to_string()]));
}
