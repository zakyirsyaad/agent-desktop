use std::collections::{BTreeMap, BTreeSet};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use serde_json::json;

use zorvo_lib::installer::plan::InstalledTools;
use zorvo_lib::installer::runtimes::InstalledRuntime;
use zorvo_lib::registry::catalog_view::{AgentCatalog, CatalogAgent};
use zorvo_lib::registry::history::{VersionHistory, MIN_AGE_SECS};
use zorvo_lib::registry::resolve::SystemTools;
use zorvo_lib::registry::schema::{BinaryTarget, Distribution, RegistryEntry};
use zorvo_lib::registry::Catalog;

const DAY: u64 = 24 * 60 * 60;
const T0: u64 = 1_790_000_000;
const NOW: u64 = T0 + 30 * DAY;

struct BinDir(PathBuf);

impl BinDir {
    fn new(names: &[&str]) -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "zorvo-catalog-view-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        for name in names {
            let path = dir.join(name);
            std::fs::write(&path, "#!/bin/sh\n").expect("write binary");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn path_var(&self) -> String {
        self.0.to_string_lossy().to_string()
    }
}

impl Drop for BinDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn npx_entry(id: &str, version: &str) -> RegistryEntry {
    RegistryEntry {
        id: id.to_string(),
        name: format!("Agent {id}"),
        version: version.to_string(),
        description: Some(format!("About {id}")),
        icon: None,
        distribution: Distribution::Npx {
            package: format!("{id}-pkg@{version}"),
            args: vec!["--acp".to_string()],
            env: BTreeMap::new(),
        },
    }
}

fn binary_entry(id: &str, version: &str, platform: &str, cmd: &str) -> RegistryEntry {
    let target = BinaryTarget {
        archive: format!("https://example.com/{id}.tar.gz"),
        cmd: cmd.to_string(),
        args: vec!["acp".to_string()],
        sha256: "a".repeat(64),
        env: BTreeMap::new(),
    };
    RegistryEntry {
        distribution: Distribution::Binary {
            platforms: BTreeMap::from([(platform.to_string(), target)]),
        },
        ..npx_entry(id, version)
    }
}

fn current_binary(id: &str, version: &str, cmd: &str) -> RegistryEntry {
    binary_entry(
        id,
        version,
        zorvo_lib::registry::schema::current_platform(),
        cmd,
    )
}

fn bundle_of(records: &[(RegistryEntry, u64)]) -> String {
    let mut history = VersionHistory::default();
    for (entry, first_seen) in records {
        history.observe(std::slice::from_ref(entry), *first_seen);
    }
    history.to_json()
}

fn registry_of(entries: &[RegistryEntry]) -> String {
    json!({ "version": "1.0.0", "agents": entries }).to_string()
}

fn view(
    catalog: &Catalog,
    path_var: &str,
    globals: &BTreeSet<String>,
    installed: &InstalledTools,
    versions: &BTreeMap<String, String>,
) -> AgentCatalog {
    let tools = SystemTools {
        path_var: Some(path_var),
        npm_globals: globals,
        installed,
    };
    catalog.catalog_view(&tools, versions, NOW)
}

fn agent<'a>(catalog: &'a AgentCatalog, id: &str) -> &'a CatalogAgent {
    catalog
        .agents
        .iter()
        .find(|a| a.id == id)
        .unwrap_or_else(|| panic!("agent '{id}' must be in {catalog:?}"))
}

fn user_node(major: u32) -> InstalledTools {
    InstalledTools {
        user_node_major: Some(major),
        ..InstalledTools::none()
    }
}

#[test]
fn each_status_is_reported() {
    let dir = BinDir::new(&["npx", "onpath"]);
    let zorvo_dir = PathBuf::from("/tools/agents/by-zorvo-bin");
    let first_seen_recent = NOW - 2 * DAY;
    let bundle = bundle_of(&[
        (npx_entry("ready-npx", "1.0.0"), T0),
        (npx_entry("zorvo-npx", "1.0.0"), T0),
        (npx_entry("global-npx", "1.0.0"), T0),
        (current_binary("on-path", "1.0.0", "./onpath"), T0),
        (current_binary("zorvo-bin", "1.0.0", "./bin/zagent"), T0),
        (current_binary("missing", "1.0.0", "./missing-agent"), T0),
        (
            binary_entry("linux-only", "1.0.0", "linux-x86_64", "./x"),
            T0,
        ),
        (npx_entry("fresh", "1.0.0"), first_seen_recent),
    ]);
    let catalog = Catalog::bundled(&bundle);
    let globals = BTreeSet::from(["global-npx-pkg".to_string()]);

    // The user's Node serves ready-npx and global-npx.
    let mut installed = user_node(22);
    installed.agents.insert(
        ("zorvo-bin".to_string(), "1.0.0".to_string()),
        zorvo_dir.clone(),
    );
    let result = view(
        &catalog,
        &dir.path_var(),
        &globals,
        &installed,
        &BTreeMap::new(),
    );

    assert_eq!(agent(&result, "ready-npx").status, "ready");
    assert_eq!(agent(&result, "global-npx").status, "on_your_mac");
    assert_eq!(agent(&result, "global-npx").location, None);
    let on_path = agent(&result, "on-path");
    assert_eq!(on_path.status, "on_your_mac");
    assert_eq!(
        on_path.location.as_deref(),
        Some(dir.path().join("onpath").to_string_lossy().as_ref())
    );
    assert_eq!(agent(&result, "zorvo-bin").status, "by_zorvo");
    assert_eq!(agent(&result, "missing").status, "not_installed");
    assert_eq!(agent(&result, "linux-only").status, "unsupported");
    assert_eq!(agent(&result, "linux-only").distribution, "binary");
    let fresh = agent(&result, "fresh");
    assert_eq!(fresh.status, "waiting");
    assert_eq!(fresh.version, None);
    assert_eq!(fresh.available_from, Some(first_seen_recent + MIN_AGE_SECS));
    assert_eq!(fresh.name, "Agent fresh");

    // Only Zorvo's Node: npx runs on it.
    let zorvo_node = InstalledTools {
        user_node_major: Some(18),
        node: Some(InstalledRuntime {
            version: "22.0.0".to_string(),
            bin_dir: PathBuf::from("/tools/node/bin"),
        }),
        ..InstalledTools::none()
    };
    let result = view(
        &catalog,
        &dir.path_var(),
        &BTreeSet::new(),
        &zorvo_node,
        &BTreeMap::new(),
    );
    assert_eq!(agent(&result, "zorvo-npx").status, "by_zorvo");
    assert_eq!(
        result
            .agents
            .iter()
            .map(|a| a.id.as_str())
            .collect::<Vec<_>>(),
        {
            let mut ids: Vec<&str> = result.agents.iter().map(|a| a.id.as_str()).collect();
            ids.sort_unstable();
            ids
        },
        "agents are sorted by id"
    );
}

fn upgradable(newer_seen: u64) -> Catalog {
    Catalog::bundled(&bundle_of(&[
        (npx_entry("gemini", "1.0.0"), T0),
        (npx_entry("gemini", "1.1.0"), newer_seen),
    ]))
}

fn recorded_1_0_0() -> BTreeMap<String, String> {
    BTreeMap::from([("gemini".to_string(), "1.0.0".to_string())])
}

#[test]
fn update_version_is_the_newer_offered_version() {
    let dir = BinDir::new(&["npx"]);
    let installed = user_node(22);
    let globals = BTreeSet::new();

    let old_enough = upgradable(NOW - 8 * DAY);
    let result = view(
        &old_enough,
        &dir.path_var(),
        &globals,
        &installed,
        &recorded_1_0_0(),
    );
    let gemini = agent(&result, "gemini");
    assert_eq!(gemini.version.as_deref(), Some("1.0.0"));
    assert_eq!(gemini.update_version.as_deref(), Some("1.1.0"));

    let too_new = upgradable(NOW - 3 * DAY);
    let result = view(
        &too_new,
        &dir.path_var(),
        &globals,
        &installed,
        &recorded_1_0_0(),
    );
    assert_eq!(agent(&result, "gemini").update_version, None);
}

#[test]
fn update_version_is_none_when_the_recorded_version_was_withdrawn() {
    let dir = BinDir::new(&["npx"]);
    let catalog = upgradable(NOW - 20 * DAY);
    catalog
        .refresh(
            || Ok(registry_of(&[npx_entry("gemini", "1.0.0")])),
            NOW - DAY,
        )
        .expect("refresh succeeds");
    let versions = BTreeMap::from([("gemini".to_string(), "1.1.0".to_string())]);

    let result = view(
        &catalog,
        &dir.path_var(),
        &BTreeSet::new(),
        &user_node(22),
        &versions,
    );

    let gemini = agent(&result, "gemini");
    assert_eq!(gemini.version.as_deref(), Some("1.0.0"));
    assert_eq!(gemini.update_version, None);
    assert_eq!(result.last_checked, Some(NOW - DAY));
}

fn binary_upgradable() -> Catalog {
    Catalog::bundled(&bundle_of(&[
        (current_binary("tool", "1.0.0", "./onpath"), T0),
        (current_binary("tool", "1.1.0", "./onpath"), NOW - 8 * DAY),
    ]))
}

#[test]
fn update_version_is_none_for_a_binary_on_path() {
    let dir = BinDir::new(&["onpath"]);
    let versions = BTreeMap::from([("tool".to_string(), "1.0.0".to_string())]);

    let result = view(
        &binary_upgradable(),
        &dir.path_var(),
        &BTreeSet::new(),
        &InstalledTools::none(),
        &versions,
    );

    let tool = agent(&result, "tool");
    assert_eq!(tool.status, "on_your_mac");
    assert_eq!(tool.update_version, None);
}

#[test]
fn update_target_refuses_with_the_spec_copy() {
    let dir = BinDir::new(&["npx", "onpath"]);
    let installed = user_node(22);
    let globals = BTreeSet::new();
    let path_var = dir.path_var();
    let tools = SystemTools {
        path_var: Some(&path_var),
        npm_globals: &globals,
        installed: &installed,
    };

    let none_newer = upgradable(NOW - 3 * DAY);
    assert_eq!(
        none_newer
            .update_target("gemini", &tools, &recorded_1_0_0(), NOW)
            .unwrap_err(),
        "No newer version of Agent gemini is offered"
    );
    assert_eq!(
        none_newer
            .update_target("nope", &tools, &BTreeMap::new(), NOW)
            .unwrap_err(),
        "Unknown agent 'nope'"
    );

    let on_path = BTreeMap::from([("tool".to_string(), "1.0.0".to_string())]);
    assert_eq!(
        binary_upgradable()
            .update_target("tool", &tools, &on_path, NOW)
            .unwrap_err(),
        "Agent tool is managed outside Zorvo"
    );

    let newer = upgradable(NOW - 8 * DAY);
    let target = newer
        .update_target("gemini", &tools, &recorded_1_0_0(), NOW)
        .expect("a newer version is offered");
    assert_eq!(target.version, "1.1.0");
}

#[test]
fn catalog_serialises_in_camel_case() {
    let dir = BinDir::new(&["npx"]);
    let catalog = upgradable(NOW - 8 * DAY);
    let result = view(
        &catalog,
        &dir.path_var(),
        &BTreeSet::new(),
        &user_node(22),
        &recorded_1_0_0(),
    );

    let value = serde_json::to_value(&result).expect("serialises");

    assert!(value.get("lastChecked").is_some());
    let gemini = &value["agents"][0];
    assert_eq!(gemini["updateVersion"], "1.1.0");
    assert!(gemini.get("availableFrom").is_some());
}
