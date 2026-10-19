//! The agent catalog: the bundled version history merged with this install's
//! own observations, refreshed from the ACP registry in the background.
//!
//! The app installs one process-wide [`Catalog`] during setup; anything that
//! asks before then (or a plain `cargo test`) gets a bundle-only catalog that
//! never touches the disk or the network.

mod cache;
pub mod fetch;
pub mod history;
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
    runtimes::{probe_user_node, NODE_VERSION_TIMEOUT},
};
use crate::profiles::AgentProfile;
use cache::RegistryCache;
use fetch::{fetch_registry, FETCH_TIMEOUT, MAX_REGISTRY_BYTES, REGISTRY_URL};
use history::VersionHistory;
use npm_globals::{npm_globals, NPM_TIMEOUT};
use resolve::{planned_steps, registry_env, resolve_profile, SystemTools};
use schema::{parse_registry, RegistryEntry};

/// Emitted when a refresh changed the agent profiles; the UI reloads them.
pub const AGENT_PROFILES_CHANGED: &str = "agent-profiles-changed";

/// How old the last successful fetch may be before the next start refetches.
pub const REFRESH_INTERVAL_SECS: u64 = 24 * 60 * 60;

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

    /// The newest old-enough version, never newer than the one the registry lists now.
    fn offered(&self, id: &str, now: u64) -> Option<&RegistryEntry> {
        let ceiling = self.cache.as_ref().and_then(|c| c.listed_version(id));
        self.history.offered_up_to(id, now, ceiling)
    }

    /// The version to run: the one in use when the history has it, else the offered one.
    fn entry_for(
        &self,
        id: &str,
        versions: &BTreeMap<String, String>,
        now: u64,
    ) -> Option<&RegistryEntry> {
        versions
            .get(id)
            .and_then(|version| self.history.version(id, version))
            .or_else(|| self.offered(id, now))
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
        let cache = RegistryCache {
            last_fetch: now,
            listed: listed_versions.keys().cloned().collect(),
            listed_versions,
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
        Ok(!unseen.is_empty() || profiles_changed)
    }

    /// [`Self::refresh`] from the one registry URL the app ever fetches.
    pub fn refresh_from_registry(&self, now: u64) -> Result<bool, String> {
        self.refresh(
            || fetch_registry(REGISTRY_URL, FETCH_TIMEOUT, MAX_REGISTRY_BYTES),
            now,
        )
    }

    /// One profile per agent in the history, at the version in `versions`
    /// when the history has it, else at the offered version. Agents with
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
            .filter_map(|id| {
                let entry = state.entry_for(id, versions, now)?;
                Some(resolve_profile(entry, tools, state.is_listed(id)))
            })
            .collect()
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

    /// The registry's environment variables for `id` at `version`; empty when unknown.
    pub fn launch_env(&self, id: &str, version: &str) -> BTreeMap<String, String> {
        self.read_state()
            .history
            .version(id, version)
            .map(registry_env)
            .unwrap_or_default()
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

/// Re-reads the user's Node version and the global npm packages with the
/// user's environment `env` and, when `force` or the last fetch is stale, the
/// registry. A failed fetch is logged and otherwise ignored. Returns whether
/// the profiles changed.
///
/// It runs `node` and `npm` and may fetch, so call it off the main thread.
pub fn refresh_catalog(catalog: &Catalog, env: &HashMap<String, String>, force: bool) -> bool {
    // A probe that cannot answer (empty env, timeout) keeps the known major.
    let node_changed = installer::record_node_probe(probe_user_node(env, NODE_VERSION_TIMEOUT));
    // A working `npm ls -g` always lists npm itself, so an empty set means
    // detection failed (no npm, an error, the timeout): keep what was found.
    let found = npm_globals(env, NPM_TIMEOUT);
    let local_changed = (!found.is_empty() && catalog.set_npm_globals(found)) || node_changed;
    let now = unix_now();
    if !force && !catalog.needs_refresh(now) {
        return local_changed;
    }
    match catalog.refresh_from_registry(now) {
        Ok(changed) => local_changed || changed,
        Err(error) => {
            eprintln!("Could not refresh the ACP registry: {error}");
            local_changed
        }
    }
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
