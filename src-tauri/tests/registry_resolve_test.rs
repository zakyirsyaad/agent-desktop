use std::collections::{BTreeMap, BTreeSet};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use zorvo_lib::registry::resolve::{
    canonical_agent_id, missing_reason, resolve_profile, SystemTools,
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

#[test]
fn npx_entry_runs_the_pinned_package_through_npx() {
    let dir = bin_dir_with(&["npx"]);
    let path = path_of(dir.path());
    let globals = BTreeSet::new();
    let tools = SystemTools {
        path_var: Some(&path),
        npm_globals: &globals,
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
    let tools = SystemTools {
        path_var: Some(&path),
        npm_globals: &globals,
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
    let tools = SystemTools {
        path_var: Some(&path),
        npm_globals: &globals,
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
    let tools = SystemTools {
        path_var: Some(&path),
        npm_globals: &globals,
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
    let tools = SystemTools {
        path_var: Some(&path),
        npm_globals: &globals,
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
    let tools = SystemTools {
        path_var: Some(&path),
        npm_globals: &globals,
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
    let none = SystemTools {
        path_var: Some(&empty_path),
        npm_globals: &globals,
    };
    let some = SystemTools {
        path_var: Some(&ready_path),
        npm_globals: &globals,
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
