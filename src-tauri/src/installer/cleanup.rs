//! Deletes, at start, what no enabled agent uses any more: unfinished
//! installs, agent versions not in use, superseded runtimes and prerequisites.
//! Every failure is logged and skipped, so a clean-up never blocks start.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use super::layout::{read_record, remove_path, ToolsDir};
use super::prerequisites::prerequisites_for;
use super::runtimes::{RuntimeKind, RuntimeManifest};
use crate::profiles::AgentProfile;
use crate::store::Settings;

/// What the enabled agents still use.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CleanupInputs {
    /// Each enabled agent id, to the version the resolver runs it at.
    pub agents_in_use: BTreeMap<String, String>,
    pub uses_npx: bool,
    pub uses_uvx: bool,
    /// The commands of the prerequisites the enabled agents need.
    pub prereqs_needed: BTreeSet<String>,
}

/// The inputs for the enabled agents in `settings`, given `profiles`
/// resolved with `settings.agent_versions`. An agent's version in use is its
/// profile's: the recorded one when the catalog has it, else the offered
/// one. Without a profile the recorded version is kept.
pub fn cleanup_inputs(settings: &Settings, profiles: &[AgentProfile]) -> CleanupInputs {
    let enabled = settings.enabled_agent_ids();
    let enabled_profiles: Vec<&AgentProfile> = profiles
        .iter()
        .filter(|p| enabled.contains(&p.id))
        .collect();
    let agents_in_use = enabled
        .iter()
        .filter_map(|id| {
            let version = enabled_profiles
                .iter()
                .find(|p| &p.id == id)
                .and_then(|p| p.version.clone())
                .or_else(|| settings.agent_versions.get(id).cloned())?;
            Some((id.clone(), version))
        })
        .collect();
    let uses = |distribution: &str| {
        enabled_profiles
            .iter()
            .any(|p| p.distribution.as_deref() == Some(distribution))
    };
    CleanupInputs {
        agents_in_use,
        uses_npx: uses("npx"),
        uses_uvx: uses("uvx"),
        prereqs_needed: prereqs_needed_by(&enabled),
    }
}

/// The commands of every prerequisite the agents `ids` need.
pub fn prereqs_needed_by(ids: &[String]) -> BTreeSet<String> {
    ids.iter()
        .flat_map(|id| prerequisites_for(id))
        .map(|p| p.command.to_string())
        .collect()
}

/// Deletes what `inputs` says no enabled agent uses, except a dir
/// `is_running_under` reports a running agent in (a session that started
/// before a refresh changed the version in use). Returns the errors it
/// logged; one failed deletion never stops the rest.
pub fn clean_up(
    tools: &ToolsDir,
    manifest: &RuntimeManifest,
    platform: &str,
    inputs: &CleanupInputs,
    is_running_under: &dyn Fn(&Path) -> bool,
) -> Vec<String> {
    let doomed = [
        entries(&tools.staging_root()),
        unused_agents(tools, &inputs.agents_in_use),
        unused_runtime(
            tools,
            manifest,
            platform,
            RuntimeKind::Node,
            inputs.uses_npx,
        ),
        unused_runtime(tools, manifest, platform, RuntimeKind::Uv, inputs.uses_uvx),
        unused_prereqs(tools, &inputs.prereqs_needed),
    ]
    .concat();
    doomed
        .iter()
        .filter(|path| !is_running_under(path))
        .filter_map(|path| remove_path(path).err())
        .inspect(|error| eprintln!("Clean-up of old installs: {error}"))
        .collect()
}

/// Agents not enabled, and the versions of enabled ones not in use.
fn unused_agents(tools: &ToolsDir, in_use: &BTreeMap<String, String>) -> Vec<PathBuf> {
    entries(&tools.root().join("agents"))
        .into_iter()
        .flat_map(|agent| match in_use.get(&name_of(&agent)) {
            None => vec![agent],
            Some(version) => entries(&agent)
                .into_iter()
                .filter(|dir| name_of(dir) != *version)
                .collect(),
        })
        .collect()
}

/// The whole runtime when no enabled agent uses it, else every version but
/// the pinned one once that is installed.
fn unused_runtime(
    tools: &ToolsDir,
    manifest: &RuntimeManifest,
    platform: &str,
    kind: RuntimeKind,
    used: bool,
) -> Vec<PathBuf> {
    let pinned = kind.dir(tools, &manifest.release(kind).version, platform);
    let Some(root) = pinned.parent() else {
        return Vec::new();
    };
    if !used {
        return vec![root.to_path_buf()];
    }
    if read_record(&pinned).is_none() {
        return Vec::new();
    }
    entries(root)
        .into_iter()
        .filter(|dir| *dir != pinned)
        .collect()
}

fn unused_prereqs(tools: &ToolsDir, needed: &BTreeSet<String>) -> Vec<PathBuf> {
    entries(&tools.root().join("prereqs"))
        .into_iter()
        .filter(|dir| !needed.contains(&name_of(dir)))
        .collect()
}

/// The entries of `dir`; none when it is missing or unreadable.
fn entries(dir: &Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect()
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}
