//! A snapshot of what Zorvo has installed, and the steps an install plan is
//! made of. The resolver reads the snapshot; the orchestrator runs the steps.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde::Serialize;

use super::layout::{read_record, ToolsDir};
use super::prerequisites::{all_prerequisites, Prerequisite};
use super::runtimes::{installed_runtime, InstalledRuntime, RuntimeKind, RuntimeManifest};

/// What is on disk now. A tool counts only when its dir has `install.json`,
/// since a crash can leave an empty dir.
#[derive(Debug, Clone, Default)]
pub struct InstalledTools {
    pub user_node_major: Option<u32>,
    pub node: Option<InstalledRuntime>,
    pub uv: Option<InstalledRuntime>,
    pub pinned_node_installed: bool,
    pub pinned_uv_installed: bool,
    /// `(id, version)` to the agent's install dir.
    pub agents: BTreeMap<(String, String), PathBuf>,
    /// Prerequisite command to the `bin` folder of its pinned install.
    pub prereq_bins: BTreeMap<String, PathBuf>,
    pub manifest: Option<RuntimeManifest>,
}

impl InstalledTools {
    /// Nothing installed and no manifest, for when the snapshot is unavailable.
    pub fn none() -> Self {
        Self::default()
    }

    pub fn scan(
        tools: &ToolsDir,
        manifest: &RuntimeManifest,
        platform: &str,
        user_node_major: Option<u32>,
    ) -> Self {
        let pinned = |kind: RuntimeKind| {
            let version = &manifest.release(kind).version;
            let dir = match kind {
                RuntimeKind::Node => tools.node_dir(version, platform),
                RuntimeKind::Uv => tools.uv_dir(version, platform),
            };
            read_record(&dir).is_some()
        };
        let prereq_bins = all_prerequisites()
            .filter_map(|p| {
                let dir = tools.prereq_dir(p.command, p.version);
                read_record(&dir)?;
                Some((p.command.to_string(), dir.join("bin")))
            })
            .collect();

        Self {
            user_node_major,
            node: installed_runtime(tools, RuntimeKind::Node, manifest, platform),
            uv: installed_runtime(tools, RuntimeKind::Uv, manifest, platform),
            pinned_node_installed: pinned(RuntimeKind::Node),
            pinned_uv_installed: pinned(RuntimeKind::Uv),
            agents: installed_agents(tools),
            prereq_bins,
            manifest: Some(manifest.clone()),
        }
    }
}

/// Every `tools/agents/<id>/<version>` dir that holds an install record.
fn installed_agents(tools: &ToolsDir) -> BTreeMap<(String, String), PathBuf> {
    let mut found = BTreeMap::new();
    for id_dir in subdirs(&tools.root().join("agents")) {
        let Some(id) = id_dir
            .file_name()
            .and_then(|n| n.to_str())
            .map(String::from)
        else {
            continue;
        };
        for version_dir in subdirs(&id_dir) {
            let Some(version) = version_dir
                .file_name()
                .and_then(|n| n.to_str())
                .map(String::from)
            else {
                continue;
            };
            if read_record(&version_dir).is_some() {
                found.insert((id.clone(), version), version_dir);
            }
        }
    }
    found
}

fn subdirs(dir: &std::path::Path) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect()
}

/// One thing an install plan will install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlannedStep {
    Runtime(RuntimeKind),
    Agent {
        id: String,
        name: String,
        version: String,
        url: String,
        sha256: String,
        cmd: String,
    },
    Prerequisite(&'static Prerequisite),
}

/// A step as the UI shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InstallStep {
    /// `node`, `uv`, `agent` or `prerequisite`.
    pub kind: String,
    pub name: String,
    pub version: String,
    pub download_bytes: Option<u64>,
}

impl PlannedStep {
    /// Runtime sizes come from the manifest; agent and prerequisite sizes are
    /// not known before the download.
    pub fn display(&self, manifest: Option<&RuntimeManifest>, platform: &str) -> InstallStep {
        match self {
            Self::Runtime(kind) => {
                let release = manifest.map(|m| m.release(*kind));
                InstallStep {
                    kind: match kind {
                        RuntimeKind::Node => "node",
                        RuntimeKind::Uv => "uv",
                    }
                    .to_string(),
                    name: kind.display_name().to_string(),
                    version: release.map(|r| r.version.clone()).unwrap_or_default(),
                    download_bytes: release
                        .and_then(|r| r.targets.get(platform))
                        .map(|t| t.size),
                }
            }
            Self::Agent { name, version, .. } => InstallStep {
                kind: "agent".to_string(),
                name: name.clone(),
                version: version.clone(),
                download_bytes: None,
            },
            Self::Prerequisite(p) => InstallStep {
                kind: "prerequisite".to_string(),
                name: p.command.to_string(),
                version: p.version.to_string(),
                download_bytes: None,
            },
        }
    }
}
