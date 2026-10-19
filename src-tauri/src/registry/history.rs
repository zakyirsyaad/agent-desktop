//! A dated record of every registry version Zorvo has seen. A version is only
//! offered once it has been public for `MIN_AGE_SECS`, matching the app's
//! "pinned to releases at least two weeks old" spirit with a shorter window.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::schema::{parse_entry, RegistryEntry};

/// How long a version must have been seen before it is offered: seven days.
pub const MIN_AGE_SECS: u64 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct VersionHistory {
    pub agents: BTreeMap<String, BTreeMap<String, HistoryRecord>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HistoryRecord {
    /// Unix seconds when this version was first seen.
    pub first_seen: u64,
    pub entry: RegistryEntry,
}

/// A record is kept when its date is a number and its entry is valid and matches its keys.
fn parse_record(id: &str, version: &str, raw: &Value) -> Option<HistoryRecord> {
    let first_seen = raw.get("first_seen")?.as_u64()?;
    let entry = parse_entry(raw.get("entry")?)?;
    (entry.id == id && entry.version == version).then_some(HistoryRecord { first_seen, entry })
}

impl VersionHistory {
    /// Parses a history file, keeping every record that is valid and skipping the
    /// rest. Fails only when the file is not an object with an `agents` object.
    pub fn from_json(json: &str) -> Result<Self, String> {
        let root: Value =
            serde_json::from_str(json).map_err(|e| format!("version history is not valid: {e}"))?;
        let agents = root
            .get("agents")
            .and_then(Value::as_object)
            .ok_or_else(|| "version history has no agents object".to_string())?;
        let mut history = Self::default();
        for (id, versions) in agents {
            let Some(versions) = versions.as_object() else {
                continue;
            };
            for (version, raw) in versions {
                if let Some(record) = parse_record(id, version, raw) {
                    history
                        .agents
                        .entry(id.clone())
                        .or_default()
                        .insert(version.clone(), record);
                }
            }
        }
        Ok(history)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|_| "{\"agents\":{}}".into())
    }

    /// Adds each entry's (id, version) first seen at `now`; never changes an existing date.
    pub fn observe(&mut self, entries: &[RegistryEntry], now: u64) -> bool {
        let mut changed = false;
        for entry in entries {
            let versions = self.agents.entry(entry.id.clone()).or_default();
            if !versions.contains_key(&entry.version) {
                versions.insert(
                    entry.version.clone(),
                    HistoryRecord {
                        first_seen: now,
                        entry: entry.clone(),
                    },
                );
                changed = true;
            }
        }
        changed
    }

    /// Earliest date wins for a version both histories know.
    pub fn merge(&mut self, other: &VersionHistory) {
        for (id, versions) in &other.agents {
            let mine = self.agents.entry(id.clone()).or_default();
            for (version, record) in versions {
                match mine.get_mut(version) {
                    Some(existing) if existing.first_seen <= record.first_seen => {}
                    Some(existing) => *existing = record.clone(),
                    None => {
                        mine.insert(version.clone(), record.clone());
                    }
                }
            }
        }
    }

    /// Newest version (semver order) first seen at least `MIN_AGE_SECS` before `now`.
    pub fn offered(&self, id: &str, now: u64) -> Option<&RegistryEntry> {
        self.offered_up_to(id, now, None)
    }

    /// [`Self::offered`], ignoring versions newer than `ceiling` (the version the
    /// registry lists now), so a version the registry withdrew is not offered.
    pub fn offered_up_to(
        &self,
        id: &str,
        now: u64,
        ceiling: Option<&str>,
    ) -> Option<&RegistryEntry> {
        self.agents
            .get(id)?
            .iter()
            .filter(|(_, record)| now.saturating_sub(record.first_seen) >= MIN_AGE_SECS)
            .filter(|(version, _)| {
                ceiling.is_none_or(|top| compare_versions(version, top) != Ordering::Greater)
            })
            .max_by(|(a, _), (b, _)| compare_versions(a, b))
            .map(|(_, record)| &record.entry)
    }

    pub fn version(&self, id: &str, version: &str) -> Option<&RegistryEntry> {
        self.agents.get(id)?.get(version).map(|r| &r.entry)
    }

    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.agents.keys().map(String::as_str)
    }
}

/// Orders `x.y.z[-pre]` versions numerically; a pre-release sorts below its
/// release. Build metadata is ignored; unparseable parts count as zero.
fn compare_versions(a: &str, b: &str) -> Ordering {
    let (core_a, pre_a) = split_version(a);
    let (core_b, pre_b) = split_version(b);
    core_a
        .cmp(&core_b)
        .then_with(|| match (pre_a, pre_b) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(x), Some(y)) => compare_pre(x, y),
        })
        .then_with(|| a.cmp(b))
}

fn split_version(version: &str) -> (Vec<u64>, Option<&str>) {
    let without_build = version.split('+').next().unwrap_or(version);
    let (core, pre) = match without_build.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (without_build, None),
    };
    let numbers = core.split('.').map(|n| n.parse().unwrap_or(0)).collect();
    (numbers, pre)
}

fn compare_pre(a: &str, b: &str) -> Ordering {
    let mut left = a.split('.');
    let mut right = b.split('.');
    loop {
        match (left.next(), right.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                let order = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(m), Ok(n)) => m.cmp(&n),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => x.cmp(y),
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
        }
    }
}
