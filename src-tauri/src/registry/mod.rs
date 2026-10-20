//! The agent catalog: the bundled version history merged with this install's
//! own observations, refreshed from the ACP registry in the background.
//!
//! The app installs one process-wide [`Catalog`] during setup; anything that
//! asks before then (or a plain `cargo test`) gets a bundle-only catalog that
//! never touches the disk or the network.

mod cache;
pub mod catalog_view;
pub mod fetch;
pub mod history;
pub mod icons;
pub mod npm_globals;
pub mod resolve;
pub mod schema;

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::{OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::installer::{
    self,
    plan::PlannedStep,
    runtimes::{probe_user_node, NodeProbe, NODE_VERSION_TIMEOUT},
};
use crate::profiles::AgentProfile;
use cache::RegistryCache;
use catalog_view::{
    AgentCatalog, CatalogAgent, STATUS_BY_ZORVO, STATUS_NOT_INSTALLED, STATUS_ON_YOUR_MAC,
    STATUS_READY, STATUS_UNSUPPORTED, STATUS_WAITING,
};
use fetch::{fetch_registry, FETCH_TIMEOUT, MAX_REGISTRY_BYTES, REGISTRY_URL};
use history::{compare_versions, is_within, VersionHistory, MIN_AGE_SECS};
use icons::{IconSource, BUNDLED_ICONS, ICON_TIMEOUT, MAX_ICON_BYTES};
use npm_globals::{npm_globals, NPM_TIMEOUT};
use resolve::{
    install_status, is_supported, planned_steps, registry_env, resolve_profile, InstallStatus,
    SystemTools,
};
use schema::{parse_registry, RegistryEntry};
use std::cmp::Ordering;

/// Emitted when a refresh changed the agent profiles; the UI reloads them.
pub const AGENT_PROFILES_CHANGED: &str = "agent-profiles-changed";

/// How old the last successful fetch may be before the next start refetches.
pub const REFRESH_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// Where the downloaded icons live, inside the data dir.
const ICONS_DIR: &str = "icons";

/// The version history shipped with the app.
pub const BUNDLED_HISTORY: &str = include_str!("../../resources/registry-history.json");

pub struct Catalog {
    /// Where this install's files live; `None` for a bundle-only catalog.
    data_dir: Option<PathBuf>,
    state: RwLock<CatalogState>,
    /// Globally installed npm packages, read once per refresh rather than per lookup.
    npm_globals: RwLock<BTreeSet<String>>,
}

struct CatalogState {
    /// The bundle merged with `local`; every version the app may run.
    history: VersionHistory,
    /// Versions this install saw first, which is what it saves.
    local: VersionHistory,
    /// The last successful fetch, `None` before the first one.
    cache: Option<RegistryCache>,
}

impl CatalogState {
    /// Before any fetch every agent counts as listed.
    fn is_listed(&self, id: &str) -> bool {
        self.cache
            .as_ref()
            .is_none_or(|cache| cache.listed.contains(id))
    }

    /// The version the registry lists now for `id`; `None` before a fetch or when unlisted.
    fn ceiling(&self, id: &str) -> Option<&str> {
        self.cache.as_ref().and_then(|c| c.listed_version(id))
    }

    /// True when the registry withdrew `version` of `id`: some fetch listed an
    /// older version as its latest, or the version is newer than the one it lists now.
    fn is_withdrawn(&self, id: &str, version: &str) -> bool {
        !is_within(version, self.ceiling(id))
            || self
                .cache
                .as_ref()
                .is_some_and(|cache| cache.is_withdrawn(id, version))
    }

    /// The newest old-enough version the registry has not withdrawn.
    fn offered(&self, id: &str, now: u64) -> Option<&RegistryEntry> {
        self.history
            .offered_where(id, now, |version| !self.is_withdrawn(id, version))
    }

    /// The version to run: the one in use when the history has it and the
    /// registry has not withdrawn it, else the offered one. A withdrawn
    /// version in use keeps running when nothing else is offered, so the
    /// agent never disappears.
    fn entry_for(
        &self,
        id: &str,
        versions: &BTreeMap<String, String>,
        now: u64,
    ) -> Option<&RegistryEntry> {
        let recorded = versions
            .get(id)
            .filter(|version| self.is_old_enough(id, version, now))
            .and_then(|version| Some((version, self.history.version(id, version)?)));
        match recorded {
            Some((version, entry)) if self.is_withdrawn(id, version) => {
                self.offered(id, now).or(Some(entry))
            }
            Some((_, entry)) => Some(entry),
            None => self.offered(id, now),
        }
    }

    /// True when `version` was first seen at least `MIN_AGE_SECS` before `now`.
    fn is_old_enough(&self, id: &str, version: &str, now: u64) -> bool {
        self.history
            .first_seen(id, version)
            .is_some_and(|seen| now.saturating_sub(seen) >= MIN_AGE_SECS)
    }

    /// The catalog row for `id`, which is in the history.
    fn catalog_agent(
        &self,
        id: &str,
        tools: &SystemTools,
        versions: &BTreeMap<String, String>,
        now: u64,
    ) -> CatalogAgent {
        let listed = self.is_listed(id);
        let Some(entry) = self.entry_for(id, versions, now) else {
            return self.waiting_agent(id, listed);
        };
        let (status, location) = match install_status(entry, tools) {
            InstallStatus::ByZorvo => (STATUS_BY_ZORVO, None),
            InstallStatus::OnYourMac { location } => (STATUS_ON_YOUR_MAC, location),
            InstallStatus::Ready => (STATUS_READY, None),
            InstallStatus::NotInstalled => (STATUS_NOT_INSTALLED, None),
            InstallStatus::Unsupported => (STATUS_UNSUPPORTED, None),
        };
        let update_version = if status == STATUS_UNSUPPORTED
            || (status == STATUS_ON_YOUR_MAC && location.is_some())
        {
            None
        } else {
            self.newer_offered(id, &entry.version, now)
                .map(|offered| offered.version.clone())
        };
        CatalogAgent {
            id: id.to_string(),
            name: entry.name.clone(),
            description: entry.description.clone(),
            distribution: distribution_name(entry).to_string(),
            listed,
            version: Some(entry.version.clone()),
            update_version,
            status: status.to_string(),
            available_from: None,
            location,
        }
    }

    /// The offered entry when it is newer than `version`.
    fn newer_offered(&self, id: &str, version: &str, now: u64) -> Option<&RegistryEntry> {
        self.offered(id, now)
            .filter(|offered| compare_versions(&offered.version, version) == Ordering::Greater)
    }

    /// A row for an agent whose every version is still younger than the wait.
    fn waiting_agent(&self, id: &str, listed: bool) -> CatalogAgent {
        let newest = self
            .history
            .records(id)
            .max_by(|(a, _), (b, _)| compare_versions(a, b))
            .map(|(_, record)| &record.entry);
        let available_from = self
            .history
            .records(id)
            .filter(|(version, _)| !self.is_withdrawn(id, version))
            .map(|(_, record)| record.first_seen)
            .min()
            .map(|seen| seen + MIN_AGE_SECS);
        CatalogAgent {
            id: id.to_string(),
            name: newest.map_or_else(|| id.to_string(), |entry| entry.name.clone()),
            description: newest.and_then(|entry| entry.description.clone()),
            distribution: newest.map_or("npx", distribution_name).to_string(),
            listed,
            version: None,
            update_version: None,
            status: STATUS_WAITING.to_string(),
            available_from,
            location: None,
        }
    }

    fn profile(
        &self,
        id: &str,
        tools: &SystemTools,
        versions: &BTreeMap<String, String>,
        now: u64,
    ) -> Option<AgentProfile> {
        let entry = self.entry_for(id, versions, now)?;
        if !is_supported(entry) {
            return None;
        }
        Some(resolve_profile(entry, tools, self.is_listed(id)))
    }
}

impl Catalog {
    /// Loads the bundle plus `registry-history.json` and `registry-cache.json`
    /// from `data_dir`. Missing or unreadable files leave the bundle alone.
    pub fn open(data_dir: PathBuf, bundled_json: &str) -> Self {
        let local = cache::load_history(&data_dir);
        let last = cache::load_cache(&data_dir);
        Self::build(Some(data_dir), bundled_json, local, last)
    }

    /// A catalog of the bundle alone, which never reads or writes files.
    pub fn bundled(bundled_json: &str) -> Self {
        Self::build(None, bundled_json, VersionHistory::default(), None)
    }

    fn build(
        data_dir: Option<PathBuf>,
        bundled_json: &str,
        local: VersionHistory,
        cache: Option<RegistryCache>,
    ) -> Self {
        let mut history = VersionHistory::from_json(bundled_json).unwrap_or_else(|e| {
            eprintln!("The bundled registry history is not valid: {e}");
            VersionHistory::default()
        });
        history.merge(&local);
        Self {
            data_dir,
            state: RwLock::new(CatalogState {
                history,
                local,
                cache,
            }),
            npm_globals: RwLock::new(BTreeSet::new()),
        }
    }

    /// True before the first fetch and once the last one is a day old (or in the future).
    pub fn needs_refresh(&self, now: u64) -> bool {
        self.last_fetch()
            .is_none_or(|last| last > now || now - last >= REFRESH_INTERVAL_SECS)
    }

    /// Fetches the registry with `fetch`, records versions not seen before at
    /// `now`, and saves them. A failed fetch or a document that is not a
    /// registry changes nothing. Returns whether the profiles changed.
    pub fn refresh(
        &self,
        fetch: impl Fn() -> Result<String, String>,
        now: u64,
    ) -> Result<bool, String> {
        let entries = parse_registry(&fetch()?)?;
        let mut state = self.write_state();

        let unseen: Vec<RegistryEntry> = entries
            .iter()
            .filter(|e| state.history.version(&e.id, &e.version).is_none())
            .cloned()
            .collect();
        let mut history = state.history.clone();
        history.observe(&unseen, now);
        let mut local = state.local.clone();
        local.observe(&unseen, now);

        let listed_versions: BTreeMap<String, String> =
            entries.into_iter().map(|e| (e.id, e.version)).collect();
        let withdrawn = withdrawn_after(state.cache.as_ref(), &history, &listed_versions);
        let withdrawn_changed = state
            .cache
            .as_ref()
            .map_or(!withdrawn.is_empty(), |cache| cache.withdrawn != withdrawn);
        let cache = RegistryCache {
            last_fetch: now,
            listed: listed_versions.keys().cloned().collect(),
            listed_versions,
            withdrawn,
        };
        if let Some(dir) = &self.data_dir {
            cache::save(dir, &local, &cache)?;
        }

        let next = CatalogState {
            history,
            local,
            cache: Some(cache),
        };
        let profiles_changed = next.history.ids().any(|id| {
            state.is_listed(id) != next.is_listed(id)
                || state.offered(id, now).map(|e| &e.version)
                    != next.offered(id, now).map(|e| &e.version)
        });
        *state = next;
        Ok(!unseen.is_empty() || withdrawn_changed || profiles_changed)
    }

    /// [`Self::refresh`] from the one registry URL the app ever fetches.
    pub fn refresh_from_registry(&self, now: u64) -> Result<bool, String> {
        self.refresh(
            || fetch_registry(REGISTRY_URL, FETCH_TIMEOUT, MAX_REGISTRY_BYTES),
            now,
        )
    }

    /// One profile per agent in the history, at the version in `versions`
    /// when the history has it and it is not withdrawn, else at the offered
    /// version (or the withdrawn one when nothing is offered). Agents with
    /// neither are left out.
    pub fn profiles(
        &self,
        tools: &SystemTools,
        versions: &BTreeMap<String, String>,
        now: u64,
    ) -> Vec<AgentProfile> {
        let state = self.read_state();
        state
            .history
            .ids()
            .filter_map(|id| state.profile(id, tools, versions, now))
            .collect()
    }

    /// The one profile [`Self::profiles`] would give for `id`; `None` when the
    /// catalog has no such agent or no version of it to run.
    pub fn profile(
        &self,
        id: &str,
        tools: &SystemTools,
        versions: &BTreeMap<String, String>,
        now: u64,
    ) -> Option<AgentProfile> {
        self.read_state().profile(id, tools, versions, now)
    }

    /// The agent's name and what an install of it would do, for the same
    /// entry [`Self::profiles`] shows, so the plan that runs is the plan the
    /// UI saw. `None` when the catalog has no version of `id` to offer.
    pub fn planned_steps_for(
        &self,
        id: &str,
        tools: &SystemTools,
        versions: &BTreeMap<String, String>,
        now: u64,
    ) -> Option<(String, Vec<PlannedStep>)> {
        let state = self.read_state();
        let entry = state.entry_for(id, versions, now)?;
        Some((entry.name.clone(), planned_steps(entry, tools)))
    }

    /// The agent's name at the entry [`Self::planned_steps_for`] would plan,
    /// without looking at what the machine has; `None` for the same ids.
    pub fn agent_name(
        &self,
        id: &str,
        versions: &BTreeMap<String, String>,
        now: u64,
    ) -> Option<String> {
        let state = self.read_state();
        state
            .entry_for(id, versions, now)
            .map(|entry| entry.name.clone())
    }

    /// The agent's name when the catalog has it but it has no build for this
    /// Mac; `None` for a supported or unknown id.
    pub fn unsupported_agent_name(
        &self,
        id: &str,
        versions: &BTreeMap<String, String>,
        now: u64,
    ) -> Option<String> {
        let state = self.read_state();
        state
            .entry_for(id, versions, now)
            .filter(|entry| !is_supported(entry))
            .map(|entry| entry.name.clone())
    }

    /// One row per agent in the history, sorted by id, with where it stands on
    /// this Mac and the newer version Update would move to.
    pub fn catalog_view(
        &self,
        tools: &SystemTools,
        versions: &BTreeMap<String, String>,
        now: u64,
    ) -> AgentCatalog {
        let state = self.read_state();
        AgentCatalog {
            last_checked: state.cache.as_ref().map(|cache| cache.last_fetch),
            agents: state
                .history
                .ids()
                .map(|id| state.catalog_agent(id, tools, versions, now))
                .collect(),
        }
    }

    /// The entry Update moves `id` to; the error is the message to show when
    /// there is nothing to move to.
    pub fn update_target(
        &self,
        id: &str,
        tools: &SystemTools,
        versions: &BTreeMap<String, String>,
        now: u64,
    ) -> Result<RegistryEntry, String> {
        let state = self.read_state();
        if !state.history.ids().any(|known| known == id) {
            return Err(format!("Unknown agent '{id}'"));
        }
        let row = state.catalog_agent(id, tools, versions, now);
        if row.status == STATUS_ON_YOUR_MAC && row.location.is_some() {
            return Err(format!("{} is managed outside Zorvo", row.name));
        }
        row.update_version
            .and_then(|version| state.history.version(id, &version))
            .cloned()
            .ok_or_else(|| format!("No newer version of {} is offered", row.name))
    }

    /// The registry's environment variables for `id` at `version`; empty when unknown.
    pub fn launch_env(&self, id: &str, version: &str) -> BTreeMap<String, String> {
        self.read_state()
            .history
            .version(id, version)
            .map(registry_env)
            .unwrap_or_default()
    }

    /// The icon of the version the registry lists for each listed agent.
    pub fn icon_sources(&self) -> Vec<IconSource> {
        let state = self.read_state();
        let Some(cache) = &state.cache else {
            return Vec::new();
        };
        cache
            .listed_versions
            .iter()
            .filter_map(|(id, version)| {
                let url = state.history.version(id, version)?.icon.clone()?;
                Some(IconSource {
                    id: id.clone(),
                    version: version.clone(),
                    url,
                })
            })
            .collect()
    }

    /// Downloads the icons that changed into the data dir; true when any did.
    /// Does nothing for a bundle-only catalog.
    pub fn refresh_icons(&self, fetch: impl Fn(&str) -> Result<String, String>) -> bool {
        let Some(dir) = &self.data_dir else {
            return false;
        };
        icons::refresh_icons(&dir.join(ICONS_DIR), &self.icon_sources(), fetch)
    }

    /// Data URLs of the agents' icons: cached copies, else the bundled ones.
    pub fn icon_data_urls(&self) -> BTreeMap<String, String> {
        let dir = self.data_dir.as_ref().map(|dir| dir.join(ICONS_DIR));
        icons::icon_data_urls(dir.as_deref(), BUNDLED_ICONS)
    }

    /// Unix seconds of the last successful fetch.
    pub fn last_fetch(&self) -> Option<u64> {
        self.read_state()
            .cache
            .as_ref()
            .map(|cache| cache.last_fetch)
    }

    pub fn npm_globals(&self) -> BTreeSet<String> {
        self.npm_globals
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Replaces the global npm packages; true when the set changed.
    pub fn set_npm_globals(&self, packages: BTreeSet<String>) -> bool {
        let mut current = self
            .npm_globals
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let changed = *current != packages;
        *current = packages;
        changed
    }

    // A panic while holding a lock leaves no half-written state (every write
    // replaces the whole value), so a poisoned lock is still usable.
    fn read_state(&self) -> RwLockReadGuard<'_, CatalogState> {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write_state(&self) -> RwLockWriteGuard<'_, CatalogState> {
        self.state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn distribution_name(entry: &RegistryEntry) -> &'static str {
    match entry.distribution {
        schema::Distribution::Npx { .. } => "npx",
        schema::Distribution::Uvx { .. } => "uvx",
        schema::Distribution::Binary { .. } => "binary",
    }
}

/// The withdrawn versions after a fetch listing `listed`: the previous ones
/// plus, for each listed id, every version in `history` newer than the listed
/// one. Never smaller than before.
fn withdrawn_after(
    previous: Option<&RegistryCache>,
    history: &VersionHistory,
    listed: &BTreeMap<String, String>,
) -> BTreeMap<String, BTreeSet<String>> {
    let mut withdrawn = previous
        .map(|cache| cache.withdrawn.clone())
        .unwrap_or_default();
    for (id, version) in listed {
        let newer: BTreeSet<String> = history
            .versions_above(id, version)
            .map(str::to_string)
            .collect();
        if !newer.is_empty() {
            withdrawn.entry(id.clone()).or_default().extend(newer);
        }
    }
    withdrawn
}

/// Re-reads the user's Node version and the global npm packages with the
/// user's environment `env` and, when `force` or the last fetch is stale, the
/// registry; the local reads and the fetch run at the same time. A failed
/// fetch is logged and otherwise ignored. Returns whether the profiles changed.
///
/// It runs `node` and `npm` and may fetch, so call it off the main thread.
pub fn refresh_catalog(catalog: &Catalog, env: &HashMap<String, String>, force: bool) -> bool {
    let now = unix_now();
    let should_fetch = force || catalog.needs_refresh(now);
    let ((node, found), fetched) = std::thread::scope(|scope| {
        let local = scope.spawn(|| {
            (
                probe_user_node(env, NODE_VERSION_TIMEOUT),
                npm_globals(env, NPM_TIMEOUT),
            )
        });
        let fetched = should_fetch.then(|| catalog.refresh_from_registry(now));
        let local = local.join().unwrap_or_else(|_| {
            eprintln!("Reading the user's Node.js and npm packages panicked");
            (NodeProbe::Inconclusive, BTreeSet::new())
        });
        (local, fetched)
    });

    // A probe that cannot answer (empty env, timeout) keeps the known major.
    let node_changed = installer::record_node_probe(node);
    // A working `npm ls -g` always lists npm itself, so an empty set means
    // detection failed (no npm, an error, the timeout): keep what was found.
    let npm_changed = !found.is_empty() && catalog.set_npm_globals(found);
    let local_changed = npm_changed || node_changed;
    let fetch_changed = match fetched {
        Some(Ok(changed)) => {
            // Only the CDN is ever asked for an icon; a failed one keeps its old copy.
            let icons_changed =
                catalog.refresh_icons(|url| fetch_registry(url, ICON_TIMEOUT, MAX_ICON_BYTES));
            changed || icons_changed
        }
        Some(Err(error)) => {
            eprintln!("Could not refresh the ACP registry: {error}");
            false
        }
        None => false,
    };
    local_changed || fetch_changed
}

static INSTALLED: OnceLock<Catalog> = OnceLock::new();
static BUNDLE_ONLY: OnceLock<Catalog> = OnceLock::new();

/// Makes `catalog` the one [`catalog`] returns. Called once, during setup.
pub fn install(catalog: Catalog) {
    if INSTALLED.set(catalog).is_err() {
        eprintln!("The agent catalog was already installed; keeping the first one");
    }
}

/// The installed catalog, or a bundle-only one when none is installed.
pub fn catalog() -> &'static Catalog {
    INSTALLED
        .get()
        .unwrap_or_else(|| BUNDLE_ONLY.get_or_init(|| Catalog::bundled(BUNDLED_HISTORY)))
}

/// Current unix time in seconds, or `0` if the clock predates the epoch.
pub fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}
