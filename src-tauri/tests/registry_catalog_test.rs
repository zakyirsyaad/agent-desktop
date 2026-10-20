use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::json;

use zorvo_lib::installer::plan::InstalledTools;
use zorvo_lib::profiles::AgentProfile;
use zorvo_lib::registry::history::{VersionHistory, MIN_AGE_SECS};
use zorvo_lib::registry::npm_globals::npm_globals;
use zorvo_lib::registry::resolve::SystemTools;
use zorvo_lib::registry::schema::{Distribution, RegistryEntry};
use zorvo_lib::registry::Catalog;

const BUNDLE: &str = include_str!("../resources/registry-history.json");
const DAY: u64 = 24 * 60 * 60;
const T0: u64 = 1_790_000_000;

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "zorvo-catalog-{tag}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn npx_entry(id: &str, version: &str) -> RegistryEntry {
    RegistryEntry {
        id: id.to_string(),
        name: format!("Agent {id}"),
        version: version.to_string(),
        description: None,
        icon: None,
        distribution: Distribution::Npx {
            package: format!("{id}-pkg@{version}"),
            args: vec!["--acp".to_string()],
            env: BTreeMap::new(),
        },
    }
}

/// A bundled history holding each entry first seen at its given time.
fn bundle_of(records: &[(RegistryEntry, u64)]) -> String {
    let mut history = VersionHistory::default();
    for (entry, first_seen) in records {
        history.observe(std::slice::from_ref(entry), *first_seen);
    }
    history.to_json()
}

/// A registry document listing `entries`.
fn registry_of(entries: &[RegistryEntry]) -> String {
    json!({ "version": "1.0.0", "agents": entries }).to_string()
}

fn no_tools_profiles(
    catalog: &Catalog,
    versions: &BTreeMap<String, String>,
    now: u64,
) -> Vec<AgentProfile> {
    let npm = BTreeSet::new();
    let tools = SystemTools {
        path_var: Some(""),
        npm_globals: &npm,
        installed: &InstalledTools::none(),
    };
    catalog.profiles(&tools, versions, now)
}

fn find<'a>(profiles: &'a [AgentProfile], id: &str) -> &'a AgentProfile {
    profiles
        .iter()
        .find(|p| p.id == id)
        .unwrap_or_else(|| panic!("profile '{id}' must exist in {profiles:?}"))
}

#[test]
fn falls_back_to_the_bundle_without_a_cache() {
    let dir = TempDir::new("bundle");
    let bundle = VersionHistory::from_json(BUNDLE).expect("bundle parses");
    let latest_first_seen = bundle
        .agents
        .values()
        .flat_map(|versions| versions.values().map(|r| r.first_seen))
        .max()
        .expect("bundle has records");
    let catalog = Catalog::open(dir.path().to_path_buf(), BUNDLE);

    let profiles = no_tools_profiles(&catalog, &BTreeMap::new(), latest_first_seen + MIN_AGE_SECS);

    let ids: BTreeSet<&str> = profiles.iter().map(|p| p.id.as_str()).collect();
    let expected: BTreeSet<&str> = bundle.ids().collect();
    assert_eq!(ids, expected);
    for id in ["claude-acp", "codex-acp", "qwen-code"] {
        assert!(
            find(&profiles, id).listed,
            "{id} is listed before any fetch"
        );
    }
    assert_eq!(catalog.last_fetch(), None);
    assert!(
        std::fs::read_dir(dir.path())
            .expect("read dir")
            .next()
            .is_none(),
        "opening the catalog writes nothing"
    );
}

#[test]
fn refresh_records_new_versions_and_persists_them() {
    let dir = TempDir::new("persist");
    let bundle = bundle_of(&[(npx_entry("gemini", "1.0.0"), T0)]);
    let catalog = Catalog::open(dir.path().to_path_buf(), &bundle);
    let fetched_at = T0 + 30 * DAY;

    let changed = catalog
        .refresh(
            || Ok(registry_of(&[npx_entry("gemini", "2.0.0")])),
            fetched_at,
        )
        .expect("refresh succeeds");

    assert!(changed);
    assert_eq!(catalog.last_fetch(), Some(fetched_at));
    let later = fetched_at + MIN_AGE_SECS;
    let profiles = no_tools_profiles(&catalog, &BTreeMap::new(), later);
    assert_eq!(find(&profiles, "gemini").version.as_deref(), Some("2.0.0"));

    let reopened = Catalog::open(dir.path().to_path_buf(), &bundle);
    assert_eq!(reopened.last_fetch(), Some(fetched_at));
    let profiles = no_tools_profiles(&reopened, &BTreeMap::new(), later);
    assert_eq!(find(&profiles, "gemini").version.as_deref(), Some("2.0.0"));
    assert!(dir.path().join("registry-history.json").is_file());
    assert!(dir.path().join("registry-cache.json").is_file());
}

#[test]
fn a_new_version_waits_seven_days_before_it_is_offered() {
    let dir = TempDir::new("wait");
    let bundle = bundle_of(&[(npx_entry("gemini", "1.0.0"), T0)]);
    let catalog = Catalog::open(dir.path().to_path_buf(), &bundle);
    let fetched_at = T0 + 30 * DAY;
    catalog
        .refresh(
            || Ok(registry_of(&[npx_entry("gemini", "2.0.0")])),
            fetched_at,
        )
        .expect("refresh succeeds");

    let profiles = no_tools_profiles(&catalog, &BTreeMap::new(), fetched_at + DAY);

    assert_eq!(find(&profiles, "gemini").version.as_deref(), Some("1.0.0"));
}

#[test]
fn an_unchanged_registry_reports_no_change() {
    let dir = TempDir::new("unchanged");
    let bundle = bundle_of(&[(npx_entry("gemini", "1.0.0"), T0)]);
    let catalog = Catalog::open(dir.path().to_path_buf(), &bundle);
    let registry = registry_of(&[npx_entry("gemini", "1.0.0")]);

    let changed = catalog
        .refresh(|| Ok(registry.clone()), T0 + 30 * DAY)
        .expect("refresh succeeds");

    assert!(!changed, "the bundle already had every version and listing");
    assert_eq!(catalog.last_fetch(), Some(T0 + 30 * DAY));
}

#[test]
fn a_failed_refresh_keeps_the_cache() {
    let dir = TempDir::new("failed");
    let bundle = bundle_of(&[(npx_entry("gemini", "1.0.0"), T0)]);
    let catalog = Catalog::open(dir.path().to_path_buf(), &bundle);
    let first = T0 + 30 * DAY;
    catalog
        .refresh(|| Ok(registry_of(&[npx_entry("gemini", "2.0.0")])), first)
        .expect("first refresh succeeds");
    let now = first + 30 * DAY;
    let before = no_tools_profiles(&catalog, &BTreeMap::new(), now);

    let offline = catalog.refresh(|| Err("offline".to_string()), now + DAY);
    let malformed = catalog.refresh(|| Ok("not json".to_string()), now + DAY);

    assert!(offline.is_err());
    assert!(malformed.is_err());
    assert_eq!(catalog.last_fetch(), Some(first));
    assert_eq!(no_tools_profiles(&catalog, &BTreeMap::new(), now), before);
}

#[test]
fn launches_the_recorded_version_not_the_newer_offered_one() {
    let dir = TempDir::new("recorded");
    let bundle = bundle_of(&[
        (npx_entry("gemini", "1.0.0"), T0),
        (npx_entry("gemini", "2.0.0"), T0 + DAY),
    ]);
    let catalog = Catalog::open(dir.path().to_path_buf(), &bundle);
    let now = T0 + 30 * DAY;
    let versions = BTreeMap::from([("gemini".to_string(), "1.0.0".to_string())]);

    let recorded = no_tools_profiles(&catalog, &versions, now);
    let offered = no_tools_profiles(&catalog, &BTreeMap::new(), now);

    let gemini = find(&recorded, "gemini");
    assert_eq!(gemini.version.as_deref(), Some("1.0.0"));
    assert!(
        gemini.acp_args.contains(&"gemini-pkg@1.0.0".to_string()),
        "{:?}",
        gemini.acp_args
    );
    assert_eq!(find(&offered, "gemini").version.as_deref(), Some("2.0.0"));
}

#[test]
fn an_unknown_recorded_version_falls_back_to_the_offered_one() {
    let dir = TempDir::new("unknown-version");
    let bundle = bundle_of(&[(npx_entry("gemini", "1.0.0"), T0)]);
    let catalog = Catalog::open(dir.path().to_path_buf(), &bundle);
    let versions = BTreeMap::from([("gemini".to_string(), "9.9.9".to_string())]);

    let profiles = no_tools_profiles(&catalog, &versions, T0 + 30 * DAY);

    assert_eq!(find(&profiles, "gemini").version.as_deref(), Some("1.0.0"));
}

#[test]
fn leaves_out_an_agent_with_no_offered_or_recorded_version() {
    let dir = TempDir::new("too-new");
    let bundle = bundle_of(&[
        (npx_entry("gemini", "1.0.0"), T0),
        (npx_entry("fresh", "1.0.0"), T0 + 29 * DAY),
    ]);
    let catalog = Catalog::open(dir.path().to_path_buf(), &bundle);

    let profiles = no_tools_profiles(&catalog, &BTreeMap::new(), T0 + 30 * DAY);

    assert!(profiles.iter().all(|p| p.id != "fresh"), "{profiles:?}");
    find(&profiles, "gemini");
}

#[test]
fn lists_an_agent_dropped_from_the_registry_as_unlisted() {
    let dir = TempDir::new("dropped");
    let bundle = bundle_of(&[
        (npx_entry("gemini", "1.0.0"), T0),
        (npx_entry("goner", "1.0.0"), T0),
    ]);
    let catalog = Catalog::open(dir.path().to_path_buf(), &bundle);
    let now = T0 + 30 * DAY;

    let changed = catalog
        .refresh(|| Ok(registry_of(&[npx_entry("gemini", "1.0.0")])), now)
        .expect("refresh succeeds");

    assert!(changed, "an agent leaving the registry is a change");
    let profiles = no_tools_profiles(&catalog, &BTreeMap::new(), now);
    assert!(find(&profiles, "gemini").listed);
    let goner = find(&profiles, "goner");
    assert!(!goner.listed);
    assert_eq!(
        goner.version.as_deref(),
        Some("1.0.0"),
        "it keeps its last version"
    );
}

#[test]
fn needs_refresh_after_24_hours() {
    let dir = TempDir::new("interval");
    let bundle = bundle_of(&[(npx_entry("gemini", "1.0.0"), T0)]);
    let catalog = Catalog::open(dir.path().to_path_buf(), &bundle);
    assert!(catalog.needs_refresh(T0), "never fetched");

    catalog
        .refresh(|| Ok(registry_of(&[npx_entry("gemini", "1.0.0")])), T0)
        .expect("refresh succeeds");

    assert!(!catalog.needs_refresh(T0 + 60 * 60));
    assert!(!catalog.needs_refresh(T0 + DAY - 1));
    assert!(catalog.needs_refresh(T0 + DAY));
}

#[test]
fn exposes_the_registry_env_of_a_version() {
    let dir = TempDir::new("env");
    let mut entry = npx_entry("gemini", "1.0.0");
    entry.distribution = Distribution::Npx {
        package: "gemini-pkg@1.0.0".to_string(),
        args: Vec::new(),
        env: BTreeMap::from([("GEMINI_ACP".to_string(), "1".to_string())]),
    };
    let catalog = Catalog::open(dir.path().to_path_buf(), &bundle_of(&[(entry, T0)]));

    assert_eq!(
        catalog.launch_env("gemini", "1.0.0"),
        BTreeMap::from([("GEMINI_ACP".to_string(), "1".to_string())])
    );
    assert!(catalog.launch_env("gemini", "2.0.0").is_empty());
}

#[test]
fn marks_an_agent_installed_globally_with_npm() {
    let dir = TempDir::new("npm");
    let catalog = Catalog::open(
        dir.path().to_path_buf(),
        &bundle_of(&[(npx_entry("gemini", "1.0.0"), T0)]),
    );
    let installed = BTreeSet::from(["gemini-pkg".to_string()]);

    assert!(catalog.set_npm_globals(installed.clone()));
    assert!(
        !catalog.set_npm_globals(installed.clone()),
        "same set, no change"
    );
    let tools = SystemTools {
        path_var: Some(""),
        npm_globals: &catalog.npm_globals(),
        installed: &InstalledTools::none(),
    };
    let profiles = catalog.profiles(&tools, &BTreeMap::new(), T0 + 30 * DAY);

    assert!(find(&profiles, "gemini").installed_on_system);
}

fn bin_dir_with_npm(tag: &str, script: &str) -> TempDir {
    let dir = TempDir::new(tag);
    let npm = dir.path().join("npm");
    std::fs::write(&npm, script).expect("write fake npm");
    std::fs::set_permissions(&npm, std::fs::Permissions::from_mode(0o755)).expect("chmod");
    dir
}

fn env_with_path(path: &str) -> HashMap<String, String> {
    HashMap::from([("PATH".to_string(), path.to_string())])
}

#[test]
fn npm_globals_missing_npm_is_empty() {
    let started = Instant::now();

    let globals = npm_globals(&env_with_path(""), Duration::from_secs(5));

    assert!(globals.is_empty());
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[test]
fn npm_globals_reads_the_global_package_names() {
    let dir = bin_dir_with_npm(
        "npm-list",
        "#!/bin/sh\n[ \"$*\" = \"ls -g --depth=0 --json\" ] || exit 2\n\
         printf '{\"dependencies\":{\"@google/gemini-cli\":{\"version\":\"0.64.0\"},\"npm\":{}}}'\n",
    );

    let globals = npm_globals(
        &env_with_path(&dir.path().to_string_lossy()),
        Duration::from_secs(5),
    );

    assert_eq!(
        globals,
        BTreeSet::from(["@google/gemini-cli".to_string(), "npm".to_string()])
    );
}

#[test]
fn npm_globals_gives_up_on_a_slow_npm() {
    let dir = bin_dir_with_npm("npm-slow", "#!/bin/sh\nexec /bin/sleep 30\n");
    let started = Instant::now();

    let globals = npm_globals(
        &env_with_path(&dir.path().to_string_lossy()),
        Duration::from_millis(300),
    );

    assert!(globals.is_empty());
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "took {:?}",
        started.elapsed()
    );
}

#[test]
fn offers_no_version_newer_than_the_one_the_registry_lists() {
    let dir = TempDir::new("withdrawn");
    let bundle = bundle_of(&[
        (npx_entry("gemini", "1.0.0"), T0),
        (npx_entry("gemini", "2.0.0"), T0 + DAY),
    ]);
    let catalog = Catalog::open(dir.path().to_path_buf(), &bundle);
    let now = T0 + 30 * DAY;

    let rolled_back = catalog
        .refresh(|| Ok(registry_of(&[npx_entry("gemini", "1.0.0")])), now)
        .expect("refresh succeeds");

    assert!(rolled_back, "a withdrawn version changes the offered one");
    let profiles = no_tools_profiles(&catalog, &BTreeMap::new(), now);
    assert_eq!(find(&profiles, "gemini").version.as_deref(), Some("1.0.0"));
    let reopened = Catalog::open(dir.path().to_path_buf(), &bundle);
    let profiles = no_tools_profiles(&reopened, &BTreeMap::new(), now);
    assert_eq!(find(&profiles, "gemini").version.as_deref(), Some("1.0.0"));

    catalog
        .refresh(
            || Ok(registry_of(&[npx_entry("gemini", "2.0.0")])),
            now + DAY,
        )
        .expect("refresh succeeds");
    let profiles = no_tools_profiles(&catalog, &BTreeMap::new(), now + DAY);
    assert_eq!(
        find(&profiles, "gemini").version.as_deref(),
        Some("1.0.0"),
        "a withdrawn version stays withdrawn even if the registry lists it again"
    );
}

#[test]
fn loads_a_cache_written_before_listed_versions_were_recorded() {
    let dir = TempDir::new("old-cache");
    let bundle = bundle_of(&[
        (npx_entry("gemini", "1.0.0"), T0),
        (npx_entry("gemini", "2.0.0"), T0 + DAY),
    ]);
    std::fs::write(
        dir.path().join("registry-cache.json"),
        r#"{"last_fetch":1790000000,"listed":["gemini"]}"#,
    )
    .expect("write old cache");

    let catalog = Catalog::open(dir.path().to_path_buf(), &bundle);

    assert_eq!(catalog.last_fetch(), Some(T0));
    let profiles = no_tools_profiles(&catalog, &BTreeMap::new(), T0 + 30 * DAY);
    let gemini = find(&profiles, "gemini");
    assert!(gemini.listed);
    assert_eq!(gemini.version.as_deref(), Some("2.0.0"));
}

fn binary_entry(id: &str, version: &str) -> RegistryEntry {
    let target = zorvo_lib::registry::schema::BinaryTarget {
        archive: format!("https://example.com/{id}-{version}.tar.gz"),
        cmd: format!("./{id}"),
        args: Vec::new(),
        sha256: "a".repeat(64),
        env: BTreeMap::new(),
    };
    RegistryEntry {
        distribution: Distribution::Binary {
            platforms: BTreeMap::from([(
                zorvo_lib::registry::schema::current_platform().to_string(),
                target,
            )]),
        },
        ..npx_entry(id, version)
    }
}

#[test]
fn plans_the_install_of_the_version_in_use() {
    use zorvo_lib::installer::plan::PlannedStep;

    let dir = TempDir::new("plan");
    let bundle = bundle_of(&[
        (binary_entry("opencode", "1.0.0"), T0),
        (binary_entry("opencode", "2.0.0"), T0 + DAY),
    ]);
    let catalog = Catalog::open(dir.path().to_path_buf(), &bundle);
    let npm = BTreeSet::new();
    let installed = InstalledTools::none();
    let tools = SystemTools {
        path_var: Some(""),
        npm_globals: &npm,
        installed: &installed,
    };
    let now = T0 + 30 * DAY;
    let in_use = BTreeMap::from([("opencode".to_string(), "1.0.0".to_string())]);

    let (name, steps) = catalog
        .planned_steps_for("opencode", &tools, &in_use, now)
        .expect("opencode is in the catalog");
    let (_, offered) = catalog
        .planned_steps_for("opencode", &tools, &BTreeMap::new(), now)
        .expect("opencode is in the catalog");

    assert_eq!(name, "Agent opencode");
    assert!(
        matches!(&steps[..], [PlannedStep::Agent { version, .. }] if version == "1.0.0"),
        "{steps:?}"
    );
    assert!(
        matches!(&offered[..], [PlannedStep::Agent { version, .. }] if version == "2.0.0"),
        "{offered:?}"
    );
    assert!(catalog
        .planned_steps_for("unknown", &tools, &in_use, now)
        .is_none());
    // The name alone, read without planning, for the same entry.
    assert_eq!(
        catalog.agent_name("opencode", &in_use, now).as_deref(),
        Some("Agent opencode")
    );
    assert!(catalog.agent_name("unknown", &in_use, now).is_none());
}

/// A catalog of gemini 1.0.0 and 2.0.0 (both old enough) after a fetch listing `listed`.
fn catalog_listing(dir: &TempDir, listed: &str, now: u64) -> Catalog {
    let bundle = bundle_of(&[
        (npx_entry("gemini", "1.0.0"), T0),
        (npx_entry("gemini", "2.0.0"), T0 + DAY),
    ]);
    let catalog = Catalog::open(dir.path().to_path_buf(), &bundle);
    catalog
        .refresh(|| Ok(registry_of(&[npx_entry("gemini", listed)])), now)
        .expect("refresh succeeds");
    catalog
}

#[test]
fn a_recorded_version_the_registry_withdrew_is_not_launched() {
    let dir = TempDir::new("recorded-withdrawn");
    let now = T0 + 30 * DAY;
    let catalog = catalog_listing(&dir, "1.0.0", now);
    let recorded = BTreeMap::from([("gemini".to_string(), "2.0.0".to_string())]);

    let profiles = no_tools_profiles(&catalog, &recorded, now);

    let gemini = find(&profiles, "gemini");
    assert_eq!(gemini.version.as_deref(), Some("1.0.0"));
    assert!(
        gemini.acp_args.contains(&"gemini-pkg@1.0.0".to_string()),
        "{:?}",
        gemini.acp_args
    );
}

#[test]
fn a_recorded_version_the_registry_still_lists_is_launched() {
    let dir = TempDir::new("recorded-listed");
    let now = T0 + 30 * DAY;
    let catalog = catalog_listing(&dir, "2.0.0", now);
    let recorded = BTreeMap::from([("gemini".to_string(), "2.0.0".to_string())]);

    let profiles = no_tools_profiles(&catalog, &recorded, now);

    assert_eq!(find(&profiles, "gemini").version.as_deref(), Some("2.0.0"));
}

#[test]
fn a_recorded_version_older_than_the_listed_one_still_wins() {
    let dir = TempDir::new("recorded-older");
    let now = T0 + 30 * DAY;
    let catalog = catalog_listing(&dir, "2.0.0", now);
    let recorded = BTreeMap::from([("gemini".to_string(), "1.0.0".to_string())]);

    let profiles = no_tools_profiles(&catalog, &recorded, now);

    assert_eq!(find(&profiles, "gemini").version.as_deref(), Some("1.0.0"));
}

#[test]
fn profile_resolves_one_agent_like_profiles_does() {
    let dir = TempDir::new("one-profile");
    let now = T0 + 30 * DAY;
    let catalog = catalog_listing(&dir, "1.0.0", now);
    let npm = BTreeSet::new();
    let tools = SystemTools {
        path_var: Some(""),
        npm_globals: &npm,
        installed: &InstalledTools::none(),
    };

    for versions in [
        BTreeMap::new(),
        BTreeMap::from([("gemini".to_string(), "2.0.0".to_string())]),
        BTreeMap::from([("gemini".to_string(), "1.0.0".to_string())]),
    ] {
        let all = catalog.profiles(&tools, &versions, now);
        assert_eq!(
            catalog.profile("gemini", &tools, &versions, now).as_ref(),
            Some(find(&all, "gemini"))
        );
    }
    assert_eq!(
        catalog.profile("no-such-agent", &tools, &BTreeMap::new(), now),
        None
    );
}

/// A catalog whose bundle holds gemini at each of `versions`, all old enough.
fn catalog_of_versions(dir: &TempDir, versions: &[&str]) -> (Catalog, String) {
    let bundle = bundle_of(
        &versions
            .iter()
            .map(|v| (npx_entry("gemini", v), T0))
            .collect::<Vec<_>>(),
    );
    (Catalog::open(dir.path().to_path_buf(), &bundle), bundle)
}

#[test]
fn a_withdrawn_recorded_version_stays_withdrawn_after_a_newer_release() {
    let dir = TempDir::new("withdrawn-permanent");
    let (catalog, _) = catalog_of_versions(&dir, &["0.29.0", "0.30.0"]);
    let recorded = BTreeMap::from([("gemini".to_string(), "0.30.0".to_string())]);
    let first = T0 + 30 * DAY;
    catalog
        .refresh(|| Ok(registry_of(&[npx_entry("gemini", "0.29.0")])), first)
        .expect("refresh succeeds");
    let profiles = no_tools_profiles(&catalog, &recorded, first);
    assert_eq!(find(&profiles, "gemini").version.as_deref(), Some("0.29.0"));

    let second = first + DAY;
    catalog
        .refresh(|| Ok(registry_of(&[npx_entry("gemini", "0.31.0")])), second)
        .expect("refresh succeeds");

    let settled = second + MIN_AGE_SECS;
    let profiles = no_tools_profiles(&catalog, &recorded, settled);
    let gemini = find(&profiles, "gemini");
    assert_eq!(gemini.version.as_deref(), Some("0.31.0"));
    assert!(
        gemini.acp_args.contains(&"gemini-pkg@0.31.0".to_string()),
        "{:?}",
        gemini.acp_args
    );
    let offered = no_tools_profiles(&catalog, &BTreeMap::new(), second);
    assert_eq!(
        find(&offered, "gemini").version.as_deref(),
        Some("0.29.0"),
        "0.30.0 is never offered again"
    );
}

#[test]
fn a_withdrawn_recorded_version_keeps_running_when_nothing_else_is_offered() {
    let dir = TempDir::new("withdrawn-nothing-offered");
    let (catalog, _) = catalog_of_versions(&dir, &["0.30.0"]);
    let recorded = BTreeMap::from([("gemini".to_string(), "0.30.0".to_string())]);
    let now = T0 + 30 * DAY;
    catalog
        .refresh(|| Ok(registry_of(&[npx_entry("gemini", "0.29.1")])), now)
        .expect("refresh succeeds");

    let profiles = no_tools_profiles(&catalog, &recorded, now);

    assert_eq!(find(&profiles, "gemini").version.as_deref(), Some("0.30.0"));
}

#[test]
fn withdrawn_versions_survive_reopening_the_catalog() {
    let dir = TempDir::new("withdrawn-reopen");
    let (catalog, bundle) = catalog_of_versions(&dir, &["0.29.0", "0.30.0"]);
    let first = T0 + 30 * DAY;
    catalog
        .refresh(|| Ok(registry_of(&[npx_entry("gemini", "0.29.0")])), first)
        .expect("refresh succeeds");
    let second = first + DAY;
    catalog
        .refresh(|| Ok(registry_of(&[npx_entry("gemini", "0.31.0")])), second)
        .expect("refresh succeeds");

    let reopened = Catalog::open(dir.path().to_path_buf(), &bundle);

    let recorded = BTreeMap::from([("gemini".to_string(), "0.30.0".to_string())]);
    let profiles = no_tools_profiles(&reopened, &recorded, second);
    assert_eq!(find(&profiles, "gemini").version.as_deref(), Some("0.29.0"));
    let profiles = no_tools_profiles(&reopened, &BTreeMap::new(), second);
    assert_eq!(find(&profiles, "gemini").version.as_deref(), Some("0.29.0"));
}

#[test]
fn a_refresh_that_only_withdraws_a_version_is_a_change() {
    let dir = TempDir::new("withdrawn-change");
    let (catalog, _) = catalog_of_versions(&dir, &["1.0.0", "2.0.0"]);
    let now = T0 + 30 * DAY;
    catalog
        .refresh(|| Ok(registry_of(&[npx_entry("gemini", "2.0.0")])), now)
        .expect("refresh succeeds");
    // 2.0.0 is still offered (it is too new to be replaced), but a third
    // version appearing above the listed one must be withdrawn and reported.
    catalog
        .refresh(
            || Ok(registry_of(&[npx_entry("gemini", "3.0.0")])),
            now + DAY,
        )
        .expect("refresh succeeds");

    let changed = catalog
        .refresh(
            || Ok(registry_of(&[npx_entry("gemini", "2.0.0")])),
            now + 2 * DAY,
        )
        .expect("refresh succeeds");

    assert!(changed, "withdrawing 3.0.0 is a change");
}

#[test]
fn loads_a_cache_written_before_withdrawn_versions_were_recorded() {
    let dir = TempDir::new("old-cache-withdrawn");
    let (_, bundle) = catalog_of_versions(&dir, &["1.0.0", "2.0.0"]);
    std::fs::write(
        dir.path().join("registry-cache.json"),
        r#"{"last_fetch":1790000000,"listed":["gemini"],"listed_versions":{"gemini":"1.0.0"}}"#,
    )
    .expect("write old cache");

    let catalog = Catalog::open(dir.path().to_path_buf(), &bundle);

    assert_eq!(catalog.last_fetch(), Some(T0));
    let profiles = no_tools_profiles(&catalog, &BTreeMap::new(), T0 + 30 * DAY);
    assert_eq!(find(&profiles, "gemini").version.as_deref(), Some("1.0.0"));
}

#[test]
fn plans_the_offered_version_when_the_one_in_use_was_withdrawn() {
    use zorvo_lib::installer::plan::PlannedStep;

    let dir = TempDir::new("plan-withdrawn");
    let bundle = bundle_of(&[
        (binary_entry("opencode", "1.0.0"), T0),
        (binary_entry("opencode", "2.0.0"), T0 + DAY),
    ]);
    let catalog = Catalog::open(dir.path().to_path_buf(), &bundle);
    let now = T0 + 30 * DAY;
    catalog
        .refresh(
            || Ok(registry_of(&[binary_entry("opencode", "1.0.0")])),
            now,
        )
        .expect("refresh succeeds");
    let npm = BTreeSet::new();
    let installed = InstalledTools::none();
    let tools = SystemTools {
        path_var: Some(""),
        npm_globals: &npm,
        installed: &installed,
    };
    let in_use = BTreeMap::from([("opencode".to_string(), "2.0.0".to_string())]);

    let (_, steps) = catalog
        .planned_steps_for("opencode", &tools, &in_use, now)
        .expect("opencode is in the catalog");

    // The plan installs the version the profile shows, not the withdrawn one.
    let shown = catalog
        .profile("opencode", &tools, &in_use, now)
        .and_then(|p| p.version);
    assert_eq!(shown.as_deref(), Some("1.0.0"));
    assert!(
        matches!(&steps[..], [PlannedStep::Agent { version, .. }] if version == "1.0.0"),
        "{steps:?}"
    );
}
