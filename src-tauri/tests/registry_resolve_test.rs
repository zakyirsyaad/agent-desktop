use std::collections::{BTreeMap, BTreeSet};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use zorvo_lib::installer::plan::{InstallStep, InstalledTools, PlannedStep};
use zorvo_lib::installer::prerequisites::prerequisites_for;
use zorvo_lib::installer::runtimes::{
    parse_manifest, InstalledRuntime, RuntimeKind, RuntimeManifest, BUNDLED_RUNTIMES,
};
use zorvo_lib::registry::resolve::{
    canonical_agent_id, missing_reason, planned_steps, resolve_profile, SystemTools,
};
use zorvo_lib::registry::schema::{current_platform, BinaryTarget, Distribution, RegistryEntry};

fn entry(id: &str, name: &str, distribution: Distribution) -> RegistryEntry {
    RegistryEntry {
        id: id.to_string(),
        name: name.to_string(),
        version: "1.0.0".to_string(),
        description: Some("An agent".to_string()),
        icon: None,
        distribution,
    }
}

fn gemini() -> RegistryEntry {
    entry(
        "gemini",
        "Gemini CLI",
        Distribution::Npx {
            package: "@google/gemini-cli@0.64.0".to_string(),
            args: vec!["--acp".to_string()],
            env: BTreeMap::new(),
        },
    )
}

fn opencode() -> RegistryEntry {
    let mut platforms = BTreeMap::new();
    platforms.insert(
        current_platform().to_string(),
        BinaryTarget {
            archive: "https://example.com/opencode.tar.gz".to_string(),
            cmd: "./opencode".to_string(),
            args: vec!["acp".to_string()],
            sha256: "0".repeat(64),
            env: BTreeMap::new(),
        },
    );
    entry("opencode", "OpenCode", Distribution::Binary { platforms })
}

struct BinDir(std::path::PathBuf);

impl BinDir {
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for BinDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn bin_dir_with(names: &[&str]) -> BinDir {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = BinDir(std::env::temp_dir().join(format!(
        "zorvo-resolve-test-{}-{unique}",
        std::process::id()
    )));
    std::fs::create_dir_all(dir.path()).expect("temp dir");
    for name in names {
        let path = dir.path().join(name);
        std::fs::write(&path, "#!/bin/sh\n").expect("write binary");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    }
    dir
}

fn path_of(dir: &Path) -> String {
    dir.to_string_lossy().to_string()
}

fn manifest() -> RuntimeManifest {
    parse_manifest(BUNDLED_RUNTIMES).expect("bundled manifest parses")
}

/// The user's own Node at `major`, and nothing installed by Zorvo.
fn user_node(major: u32) -> InstalledTools {
    InstalledTools {
        user_node_major: Some(major),
        manifest: Some(manifest()),
        ..InstalledTools::none()
    }
}

fn runtime(bin_dir: &str, version: &str) -> Option<InstalledRuntime> {
    Some(InstalledRuntime {
        version: version.to_string(),
        bin_dir: PathBuf::from(bin_dir),
    })
}

fn system<'a>(
    path: &'a str,
    globals: &'a BTreeSet<String>,
    installed: &'a InstalledTools,
) -> SystemTools<'a> {
    SystemTools {
        path_var: Some(path),
        npm_globals: globals,
        installed,
    }
}

fn binary_entry(id: &str, name: &str, cmd: &str) -> RegistryEntry {
    let mut platforms = BTreeMap::new();
    platforms.insert(
        current_platform().to_string(),
        BinaryTarget {
            archive: format!("https://example.com/{id}.tar.gz"),
            cmd: cmd.to_string(),
            args: vec!["acp".to_string()],
            sha256: "a".repeat(64),
            env: BTreeMap::new(),
        },
    );
    entry(id, name, Distribution::Binary { platforms })
}

fn pi_acp() -> RegistryEntry {
    entry(
        "pi-acp",
        "Pi",
        Distribution::Npx {
            package: "pi-acp@0.0.34".to_string(),
            args: Vec::new(),
            env: BTreeMap::new(),
        },
    )
}

fn uvx_entry() -> RegistryEntry {
    entry(
        "pyagent",
        "Py Agent",
        Distribution::Uvx {
            package: "pyagent==1.0".to_string(),
            args: vec!["acp".to_string()],
            env: BTreeMap::new(),
        },
    )
}

fn node_step() -> InstallStep {
    let manifest = manifest();
    InstallStep {
        kind: "node".to_string(),
        name: "Node.js".to_string(),
        version: manifest.node.version.clone(),
        download_bytes: manifest
            .node
            .targets
            .get(current_platform())
            .map(|t| t.size),
    }
}

fn pi_step() -> InstallStep {
    let pi = &prerequisites_for("pi-acp")[0];
    InstallStep {
        kind: "prerequisite".to_string(),
        name: pi.command.to_string(),
        version: pi.version.to_string(),
        download_bytes: None,
    }
}

#[test]
fn npx_entry_runs_the_pinned_package_through_npx() {
    let dir = bin_dir_with(&["npx"]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let new_node = user_node(22);
    let tools = SystemTools {
        path_var: Some(&path),
        npm_globals: &globals,
        installed: &new_node,
    };

    let profile = resolve_profile(&gemini(), &tools, true);

    assert_eq!(profile.id, "gemini");
    assert_eq!(profile.transport, "acp");
    assert_eq!(profile.command, "npx");
    assert_eq!(profile.acp_program.as_deref(), Some("npx"));
    assert_eq!(
        profile.acp_args,
        vec!["-y", "@google/gemini-cli@0.64.0", "--acp"]
    );
    assert_eq!(profile.availability, "ready");
    assert_eq!(profile.distribution.as_deref(), Some("npx"));
    assert_eq!(profile.source, "registry");
    assert_eq!(profile.version.as_deref(), Some("1.0.0"));
    assert!(profile.detected);
    assert!(profile.acp_program_path.is_some());
    assert_eq!(profile.detected_path, profile.acp_program_path);
    assert!(profile.listed);
}

#[test]
fn uvx_entry_runs_the_package_through_uvx() {
    let dir = bin_dir_with(&["uvx"]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let new_node = user_node(22);
    let tools = SystemTools {
        path_var: Some(&path),
        npm_globals: &globals,
        installed: &new_node,
    };
    let uv = entry(
        "pyagent",
        "Py Agent",
        Distribution::Uvx {
            package: "pyagent==1.0".to_string(),
            args: vec!["acp".to_string()],
            env: BTreeMap::new(),
        },
    );

    let profile = resolve_profile(&uv, &tools, true);

    assert_eq!(profile.acp_args, vec!["pyagent==1.0", "acp"]);
    assert_eq!(profile.distribution.as_deref(), Some("uvx"));
    assert_eq!(profile.availability, "ready");
}

#[test]
fn npx_entry_without_npx_needs_a_runtime() {
    let dir = bin_dir_with(&[]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let new_node = user_node(22);
    let tools = SystemTools {
        path_var: Some(&path),
        npm_globals: &globals,
        installed: &new_node,
    };

    let profile = resolve_profile(&gemini(), &tools, true);

    assert_eq!(profile.availability, "needs_runtime");
    assert!(!profile.detected);
}

#[test]
fn binary_entry_on_path_is_ready_and_installed_on_system() {
    let dir = bin_dir_with(&["opencode"]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let new_node = user_node(22);
    let tools = SystemTools {
        path_var: Some(&path),
        npm_globals: &globals,
        installed: &new_node,
    };

    let profile = resolve_profile(&opencode(), &tools, false);

    assert_eq!(profile.command, "opencode");
    assert_eq!(profile.acp_program.as_deref(), Some("opencode"));
    assert_eq!(profile.acp_args, vec!["acp"]);
    assert_eq!(profile.availability, "ready");
    assert!(profile.detected);
    assert!(profile.installed_on_system);
    assert_eq!(profile.distribution.as_deref(), Some("binary"));
    assert!(!profile.listed);
}

#[test]
fn binary_entry_missing_is_not_installed() {
    let dir = bin_dir_with(&[]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let new_node = user_node(22);
    let tools = SystemTools {
        path_var: Some(&path),
        npm_globals: &globals,
        installed: &new_node,
    };

    let profile = resolve_profile(&opencode(), &tools, true);

    assert_eq!(profile.availability, "not_installed");
    assert!(!profile.detected);
    assert!(!profile.installed_on_system);
}

#[test]
fn npx_package_installed_globally_is_installed_on_system() {
    let dir = bin_dir_with(&["npx"]);
    let path = path_of(dir.path());
    let globals: BTreeSet<String> = ["@google/gemini-cli".to_string()].into();
    let new_node = user_node(22);
    let tools = SystemTools {
        path_var: Some(&path),
        npm_globals: &globals,
        installed: &new_node,
    };

    let profile = resolve_profile(&gemini(), &tools, true);

    assert!(profile.installed_on_system);
}

#[test]
fn maps_legacy_ids() {
    assert_eq!(canonical_agent_id("claude-code"), "claude-acp");
    assert_eq!(canonical_agent_id("codex"), "codex-acp");
    assert_eq!(canonical_agent_id("qwen"), "qwen-code");
    assert_eq!(canonical_agent_id("gemini"), "gemini");
}

#[test]
fn missing_reason_names_what_is_missing() {
    let empty = bin_dir_with(&[]);
    let empty_path = path_of(empty.path());
    let ready_dir = bin_dir_with(&["npx"]);
    let ready_path = path_of(ready_dir.path());
    let globals = BTreeSet::new();
    let new_node = user_node(22);
    let none = SystemTools {
        path_var: Some(&empty_path),
        npm_globals: &globals,
        installed: &new_node,
    };
    let some = SystemTools {
        path_var: Some(&ready_path),
        npm_globals: &globals,
        installed: &new_node,
    };

    assert_eq!(
        missing_reason(&resolve_profile(&gemini(), &none, true)).as_deref(),
        Some("Gemini CLI needs Node.js (npx), which was not found")
    );
    assert_eq!(
        missing_reason(&resolve_profile(&opencode(), &none, true)).as_deref(),
        Some("OpenCode is not installed (opencode was not found on PATH)")
    );
    assert_eq!(
        missing_reason(&resolve_profile(&gemini(), &some, true)),
        None
    );
}

#[test]
fn npx_with_a_new_enough_user_node_is_ready_and_leaves_path_alone() {
    let dir = bin_dir_with(&["npx"]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let installed = InstalledTools {
        node: runtime("/zorvo/node/bin", "24.21.0"),
        ..user_node(22)
    };

    let profile = resolve_profile(&gemini(), &system(&path, &globals, &installed), true);

    assert_eq!(profile.availability, "ready");
    assert_eq!(
        profile.acp_program_path,
        Some(path_of(&dir.path().join("npx")))
    );
    assert!(profile.acp_path_prepend.is_empty());
    assert!(profile.acp_path_append.is_empty());
    assert_eq!(profile.install_plan, None);
}

#[test]
fn npx_with_an_old_user_node_uses_zorvos_node_first_on_path() {
    let dir = bin_dir_with(&["npx"]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let installed = InstalledTools {
        node: runtime("/zorvo/node/bin", "24.21.0"),
        pinned_node_installed: true,
        ..user_node(20)
    };

    let profile = resolve_profile(&gemini(), &system(&path, &globals, &installed), true);

    assert_eq!(profile.availability, "ready");
    assert!(profile.detected);
    assert_eq!(
        profile.acp_program_path.as_deref(),
        Some("/zorvo/node/bin/npx")
    );
    assert_eq!(profile.acp_path_prepend, vec!["/zorvo/node/bin"]);
    assert!(profile.acp_path_append.is_empty());
    assert_eq!(profile.install_plan, None);
}

#[test]
fn npx_with_an_old_user_node_and_no_zorvo_node_needs_the_runtime() {
    let dir = bin_dir_with(&["npx"]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let installed = user_node(20);
    let tools = system(&path, &globals, &installed);

    let profile = resolve_profile(&gemini(), &tools, true);

    assert_eq!(profile.availability, "needs_runtime");
    assert!(!profile.detected);
    assert_eq!(profile.install_plan, Some(vec![node_step()]));
    assert!(node_step().download_bytes.is_some());
    assert_eq!(
        planned_steps(&gemini(), &tools),
        vec![PlannedStep::Runtime(RuntimeKind::Node)]
    );
}

#[test]
fn npx_without_a_known_user_node_needs_the_runtime() {
    let dir = bin_dir_with(&["npx"]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let installed = InstalledTools::none();

    let profile = resolve_profile(&gemini(), &system(&path, &globals, &installed), true);

    assert_eq!(profile.availability, "needs_runtime");
}

#[test]
fn uvx_without_user_uvx_uses_zorvos_uvx_appended() {
    let dir = bin_dir_with(&[]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let installed = InstalledTools {
        uv: runtime("/zorvo/uv", "0.13.0"),
        pinned_uv_installed: true,
        ..user_node(22)
    };

    let profile = resolve_profile(&uvx_entry(), &system(&path, &globals, &installed), true);

    assert_eq!(profile.availability, "ready");
    assert_eq!(profile.acp_program_path.as_deref(), Some("/zorvo/uv/uvx"));
    assert!(profile.acp_path_prepend.is_empty());
    assert_eq!(profile.acp_path_append, vec!["/zorvo/uv"]);
    assert_eq!(profile.install_plan, None);
}

#[test]
fn uvx_without_any_uvx_plans_uv() {
    let dir = bin_dir_with(&[]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let installed = user_node(22);

    let profile = resolve_profile(&uvx_entry(), &system(&path, &globals, &installed), true);

    assert_eq!(profile.availability, "needs_runtime");
    let plan = profile.install_plan.expect("a plan");
    assert_eq!(plan.len(), 1);
    assert_eq!(plan[0].kind, "uv");
    assert_eq!(plan[0].name, "uv");
}

#[test]
fn binary_on_path_beats_zorvos_copy() {
    let dir = bin_dir_with(&["opencode"]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let installed = InstalledTools {
        agents: BTreeMap::from([(
            ("opencode".to_string(), "1.0.0".to_string()),
            PathBuf::from("/zorvo/agents/opencode/1.0.0"),
        )]),
        ..user_node(22)
    };

    let profile = resolve_profile(&opencode(), &system(&path, &globals, &installed), true);

    assert_eq!(profile.availability, "ready");
    assert_eq!(
        profile.acp_program_path,
        Some(path_of(&dir.path().join("opencode")))
    );
    assert!(profile.installed_on_system);
}

#[test]
fn zorvo_copy_at_the_version_in_use_is_ready() {
    let dir = bin_dir_with(&[]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let installed = InstalledTools {
        agents: BTreeMap::from([(
            ("opencode".to_string(), "1.0.0".to_string()),
            PathBuf::from("/zorvo/agents/opencode/1.0.0"),
        )]),
        ..user_node(22)
    };

    let profile = resolve_profile(&opencode(), &system(&path, &globals, &installed), true);

    assert_eq!(profile.availability, "ready");
    assert!(profile.detected);
    assert_eq!(
        profile.acp_program_path.as_deref(),
        Some("/zorvo/agents/opencode/1.0.0/opencode")
    );
    assert!(
        !profile.installed_on_system,
        "Zorvo's copy is not the user's"
    );
    assert!(profile.acp_path_prepend.is_empty());
    assert!(profile.acp_path_append.is_empty());
    assert_eq!(profile.install_plan, None);
}

#[test]
fn zorvo_copy_with_nested_cmd_runs_by_full_path() {
    let dir = bin_dir_with(&[]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let cursor = binary_entry("cursor", "Cursor", "./dist-package/cursor-agent");
    let installed = InstalledTools {
        agents: BTreeMap::from([(
            ("cursor".to_string(), "1.0.0".to_string()),
            PathBuf::from("/zorvo/agents/cursor/1.0.0"),
        )]),
        ..user_node(22)
    };

    let profile = resolve_profile(&cursor, &system(&path, &globals, &installed), true);

    assert_eq!(profile.availability, "ready");
    assert_eq!(profile.command, "cursor-agent");
    assert_eq!(
        profile.acp_program_path.as_deref(),
        Some("/zorvo/agents/cursor/1.0.0/dist-package/cursor-agent")
    );
}

#[test]
fn zorvo_copy_at_another_version_is_not_installed() {
    let dir = bin_dir_with(&[]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let installed = InstalledTools {
        agents: BTreeMap::from([(
            ("opencode".to_string(), "0.9.0".to_string()),
            PathBuf::from("/zorvo/agents/opencode/0.9.0"),
        )]),
        ..user_node(22)
    };
    let tools = system(&path, &globals, &installed);

    let profile = resolve_profile(&opencode(), &tools, true);

    assert_eq!(profile.availability, "not_installed");
    assert_eq!(profile.acp_program_path, None);
    assert_eq!(
        profile.install_plan,
        Some(vec![InstallStep {
            kind: "agent".to_string(),
            name: "OpenCode".to_string(),
            version: "1.0.0".to_string(),
            download_bytes: None,
        }])
    );
    assert_eq!(
        planned_steps(&opencode(), &tools),
        vec![PlannedStep::Agent {
            id: "opencode".to_string(),
            name: "OpenCode".to_string(),
            version: "1.0.0".to_string(),
            url: "https://example.com/opencode.tar.gz".to_string(),
            sha256: "0".repeat(64),
            cmd: "./opencode".to_string(),
        }]
    );
}

#[test]
fn pi_acp_without_pi_is_not_installed_with_a_prerequisite_step() {
    let dir = bin_dir_with(&["npx"]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let installed = user_node(22);
    let tools = system(&path, &globals, &installed);

    let profile = resolve_profile(&pi_acp(), &tools, true);

    assert_eq!(profile.availability, "not_installed");
    assert!(!profile.detected);
    assert_eq!(profile.install_plan, Some(vec![pi_step()]));
    assert_eq!(
        planned_steps(&pi_acp(), &tools),
        vec![PlannedStep::Prerequisite(&prerequisites_for("pi-acp")[0])]
    );
}

#[test]
fn pi_acp_with_pi_on_path_is_ready() {
    let dir = bin_dir_with(&["npx", "pi"]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let installed = user_node(22);

    let profile = resolve_profile(&pi_acp(), &system(&path, &globals, &installed), true);

    assert_eq!(profile.availability, "ready");
    assert!(profile.acp_path_append.is_empty());
    assert_eq!(profile.install_plan, None);
}

#[test]
fn pi_acp_with_zorvos_pi_appends_its_bin() {
    let dir = bin_dir_with(&["npx"]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let installed = InstalledTools {
        prereq_bins: BTreeMap::from([(
            "pi".to_string(),
            PathBuf::from("/zorvo/prereqs/pi/1.1.0/bin"),
        )]),
        ..user_node(22)
    };

    let profile = resolve_profile(&pi_acp(), &system(&path, &globals, &installed), true);

    assert_eq!(profile.availability, "ready");
    assert!(profile.acp_path_prepend.is_empty());
    assert_eq!(profile.acp_path_append, vec!["/zorvo/prereqs/pi/1.1.0/bin"]);
}

#[test]
fn not_ready_npx_agent_with_an_older_zorvo_node_plans_the_pinned_node() {
    let dir = bin_dir_with(&["npx"]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let older = InstalledTools {
        node: runtime("/zorvo/node/22.0.0/bin", "22.0.0"),
        pinned_node_installed: false,
        ..user_node(20)
    };
    let pinned = InstalledTools {
        pinned_node_installed: true,
        ..older.clone()
    };

    let with_older = resolve_profile(&pi_acp(), &system(&path, &globals, &older), true);
    let with_pinned = resolve_profile(&pi_acp(), &system(&path, &globals, &pinned), true);

    assert_eq!(with_older.availability, "not_installed");
    assert_eq!(with_older.install_plan, Some(vec![node_step(), pi_step()]));
    assert_eq!(with_pinned.install_plan, Some(vec![pi_step()]));
}

#[test]
fn ready_npx_agent_on_an_older_zorvo_node_plans_nothing() {
    let dir = bin_dir_with(&["npx"]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let installed = InstalledTools {
        node: runtime("/zorvo/node/22.0.0/bin", "22.0.0"),
        ..user_node(20)
    };
    let tools = system(&path, &globals, &installed);

    assert_eq!(
        resolve_profile(&gemini(), &tools, true).availability,
        "ready"
    );
    assert!(planned_steps(&gemini(), &tools).is_empty());
}

#[test]
fn ready_profile_has_no_install_plan() {
    let dir = bin_dir_with(&["opencode"]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let installed = user_node(22);
    let tools = system(&path, &globals, &installed);

    let profile = resolve_profile(&opencode(), &tools, true);

    assert_eq!(profile.availability, "ready");
    assert_eq!(profile.install_plan, None);
    assert!(planned_steps(&opencode(), &tools).is_empty());
}

#[test]
fn install_plan_is_serialized_for_the_ui() {
    let dir = bin_dir_with(&[]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let installed = user_node(22);

    let profile = resolve_profile(&opencode(), &system(&path, &globals, &installed), true);
    let json = serde_json::to_value(&profile).expect("serializes");

    assert_eq!(json["install_plan"][0]["kind"], "agent");
    assert!(json["install_plan"][0]["download_bytes"].is_null());
    assert!(json.get("acp_path_prepend").is_none());
    assert!(json.get("acp_path_append").is_none());
}

#[test]
fn missing_reason_names_a_missing_prerequisite() {
    let dir = bin_dir_with(&["npx"]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let installed = user_node(22);

    let profile = resolve_profile(&pi_acp(), &system(&path, &globals, &installed), true);

    assert_eq!(
        missing_reason(&profile).as_deref(),
        Some("Pi needs pi, which was not found")
    );
}

#[test]
fn missing_reason_asks_for_a_newer_node_when_npx_is_found() {
    let dir = bin_dir_with(&["npx"]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let installed = user_node(20);

    let profile = resolve_profile(&gemini(), &system(&path, &globals, &installed), true);

    assert_eq!(profile.availability, "needs_runtime");
    assert_eq!(
        missing_reason(&profile).as_deref(),
        Some("Gemini CLI needs Node.js 22 or newer")
    );
}
