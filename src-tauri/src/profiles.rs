use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::env_resolver;
use crate::installer::{
    self,
    plan::{InstallStep, PlannedStep},
};
use crate::registry::{
    self,
    resolve::{SystemTools, SOURCE_REGISTRY},
};

/// Static description of one ACP agent: what it is called and how Zorvo
/// launches and installs it. Registry agents fill in the ACP launch fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub command: String,
    pub detected: bool,
    /// Where `command` was found, even when it cannot run the agent (an `npx`
    /// whose Node is too old).
    pub detected_path: Option<String>,
    /// Program that speaks ACP for this agent (the CLI itself, or `npx` for an adapter).
    pub acp_program: Option<String>,
    pub acp_args: Vec<String>,
    /// Absolute path of `acp_program` on this machine, once detected.
    pub acp_program_path: Option<String>,
    /// Dirs put before the user's `PATH` at launch (Zorvo's Node).
    #[serde(skip)]
    pub acp_path_prepend: Vec<String>,
    /// Dirs put after the user's `PATH` at launch (Zorvo's uv, prerequisites).
    #[serde(skip)]
    pub acp_path_append: Vec<String>,
    /// Always `"registry"`: every agent comes from the ACP registry.
    pub source: String,
    pub version: Option<String>,
    /// `"npx"`, `"uvx"` or `"binary"` for registry agents.
    pub distribution: Option<String>,
    /// `"ready"`, `"needs_runtime"` or `"not_installed"`.
    pub availability: String,
    /// What an install would do; `None` when the agent is ready.
    pub install_plan: Option<Vec<InstallStep>>,
    pub description: Option<String>,
    /// The agent's own CLI is already installed on this machine.
    pub installed_on_system: bool,
    /// Still listed in the ACP registry (always true before the first fetch).
    pub listed: bool,
}

impl AgentProfile {
    pub fn new(id: impl Into<String>, name: impl Into<String>, command: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            command: command.into(),
            detected: false,
            detected_path: None,
            acp_program: None,
            acp_args: Vec::new(),
            acp_program_path: None,
            acp_path_prepend: Vec::new(),
            acp_path_append: Vec::new(),
            source: SOURCE_REGISTRY.to_string(),
            version: None,
            distribution: None,
            availability: "ready".to_string(),
            install_plan: None,
            description: None,
            installed_on_system: false,
            listed: true,
        }
    }
}

/// Every agent the app can run, detected against the user's `PATH` and what
/// Zorvo installed: the registry agents, each at the version in `versions`
/// when the catalog has it, else the offered one.
///
/// Uses the cached user environment to avoid launching the login shell multiple times.
pub fn agent_profiles(versions: &BTreeMap<String, String>) -> Vec<AgentProfile> {
    with_system_tools(|catalog, tools| catalog.profiles(tools, versions, registry::unix_now()))
}

/// The one profile [`agent_profiles`] would give for `id`, resolving only that
/// agent rather than every one; `None` for an unknown id.
pub fn agent_profile(id: &str, versions: &BTreeMap<String, String>) -> Option<AgentProfile> {
    with_system_tools(|catalog, tools| {
        agent_profile_from(catalog, tools, id, versions, registry::unix_now())
    })
}

/// [`agent_profile`] from a given catalog and system at time `now`.
pub fn agent_profile_from(
    catalog: &registry::Catalog,
    tools: &SystemTools,
    id: &str,
    versions: &BTreeMap<String, String>,
    now: u64,
) -> Option<AgentProfile> {
    catalog.profile(id, tools, versions, now)
}

/// Runs `f` with the catalog and what this machine has: the user's login-shell
/// `PATH` (this process's as a fallback), the global npm packages and what
/// Zorvo installed.
pub(crate) fn with_system_tools<R>(f: impl FnOnce(&registry::Catalog, &SystemTools) -> R) -> R {
    let path_var = env_resolver::cached_user_env()
        .ok()
        .and_then(|env_map| env_map.get("PATH").cloned())
        .or_else(|| std::env::var("PATH").ok());

    let catalog = registry::catalog();
    let npm_globals = catalog.npm_globals();
    let installed = installer::installed_tools();
    let tools = SystemTools {
        path_var: path_var.as_deref(),
        npm_globals: &npm_globals,
        installed: &installed,
    };
    f(catalog, &tools)
}

/// The registry agent's name at the version [`install_steps_for`] would plan,
/// read without probing the machine; `None` for an id the catalog cannot offer.
pub fn agent_name(id: &str, versions: &BTreeMap<String, String>) -> Option<String> {
    registry::catalog().agent_name(id, versions, registry::unix_now())
}

/// The registry agent's name and what an install of it would do, at the
/// version in `versions` when the catalog has it, else the offered one: the
/// same entry and machine [`agent_profiles`] resolve. `None` for an id the
/// catalog cannot offer.
pub fn install_steps_for(
    id: &str,
    versions: &BTreeMap<String, String>,
) -> Option<(String, Vec<PlannedStep>)> {
    with_system_tools(|catalog, tools| {
        catalog.planned_steps_for(id, tools, versions, registry::unix_now())
    })
}
