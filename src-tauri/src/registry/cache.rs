//! The catalog's files in the app data directory: this install's own version
//! observations and the result of the last successful registry fetch.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::history::VersionHistory;
use crate::store::atomic_write;

const HISTORY_FILE: &str = "registry-history.json";
const HISTORY_TMP_FILE: &str = "registry-history.json.tmp";
const CACHE_FILE: &str = "registry-cache.json";
const CACHE_TMP_FILE: &str = "registry-cache.json.tmp";

/// What the last successful fetch found.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(super) struct RegistryCache {
    /// Unix seconds of the fetch.
    pub last_fetch: u64,
    /// The agent ids the registry listed.
    pub listed: BTreeSet<String>,
    /// The version the registry listed for each listed id. Missing from caches
    /// written before it was recorded; those ids then have no ceiling until
    /// the next fetch.
    #[serde(default)]
    pub listed_versions: BTreeMap<String, String>,
}

impl RegistryCache {
    /// The version the registry lists now for `id`, when known.
    pub fn listed_version(&self, id: &str) -> Option<&str> {
        self.listed_versions.get(id).map(String::as_str)
    }
}

/// Reads a file, `None` when it does not exist yet. Other read errors are
/// logged and treated the same way: the catalog then runs on the bundle.
fn read_optional(path: &Path) -> Option<String> {
    match fs::read_to_string(path) {
        Ok(raw) => Some(raw),
        Err(e) if e.kind() == ErrorKind::NotFound => None,
        Err(e) => {
            eprintln!("Could not read {}: {e}", path.display());
            None
        }
    }
}

/// This install's own observations; empty when there are none or the file is unreadable.
pub(super) fn load_history(dir: &Path) -> VersionHistory {
    let path = dir.join(HISTORY_FILE);
    read_optional(&path)
        .and_then(|raw| {
            VersionHistory::from_json(&raw)
                .map_err(|e| eprintln!("Ignoring {}: {e}", path.display()))
                .ok()
        })
        .unwrap_or_default()
}

/// The last fetch's result; `None` before the first fetch or when the file is unreadable.
pub(super) fn load_cache(dir: &Path) -> Option<RegistryCache> {
    let path = dir.join(CACHE_FILE);
    let raw = read_optional(&path)?;
    serde_json::from_str(&raw)
        .map_err(|e| eprintln!("Ignoring {}: {e}", path.display()))
        .ok()
}

/// Writes both files atomically, the history first, so the cache never
/// records a fetch whose versions were not saved.
pub(super) fn save(
    dir: &Path,
    history: &VersionHistory,
    cache: &RegistryCache,
) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    let cache_json = serde_json::to_string_pretty(cache)
        .map_err(|e| format!("Failed to serialize the registry cache: {e}"))?;
    atomic_write(
        &dir.join(HISTORY_FILE),
        &dir.join(HISTORY_TMP_FILE),
        history.to_json().as_bytes(),
    )?;
    atomic_write(
        &dir.join(CACHE_FILE),
        &dir.join(CACHE_TMP_FILE),
        cache_json.as_bytes(),
    )
}
