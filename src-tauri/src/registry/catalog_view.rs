//! The read model behind the agent catalog screen: every agent in the history
//! with where it stands on this Mac, apart from the profiles the app launches.

use serde::Serialize;

pub const STATUS_BY_ZORVO: &str = "by_zorvo";
pub const STATUS_ON_YOUR_MAC: &str = "on_your_mac";
pub const STATUS_READY: &str = "ready";
pub const STATUS_NOT_INSTALLED: &str = "not_installed";
pub const STATUS_UNSUPPORTED: &str = "unsupported";
/// Every version is younger than the seven-day wait, so none can run yet.
pub const STATUS_WAITING: &str = "waiting";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogAgent {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// `npx`, `uvx` or `binary`.
    pub distribution: String,
    pub listed: bool,
    /// The version that runs; `None` while the agent is waiting.
    pub version: Option<String>,
    /// A newer offered version Update can move to.
    pub update_version: Option<String>,
    pub status: String,
    /// Unix seconds when a waiting agent first becomes available.
    pub available_from: Option<u64>,
    /// Where a binary agent found on the Mac lives.
    pub location: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCatalog {
    pub last_checked: Option<u64>,
    pub agents: Vec<CatalogAgent>,
}
