//! Zorvo's own installer for ACP agents, Node.js and uv.
//!
//! The app sets its tools dir once during setup, and each read of the user's
//! environment records what their Node is; [`installed_tools`] snapshots both
//! for the resolver. Before setup (or in a plain `cargo test`) no tool counts
//! as installed.

pub mod archive;
pub mod cleanup;
pub mod commands;
pub mod download;
pub mod install;
pub mod layout;
pub mod plan;
pub mod prerequisites;
pub mod runtimes;

use std::sync::{OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard};

use crate::env_resolver::cached_user_env;
use crate::registry::schema::current_platform;
use layout::ToolsDir;
use plan::InstalledTools;
use runtimes::{
    parse_manifest, probe_user_node, NodeProbe, RuntimeManifest, BUNDLED_RUNTIMES,
    NODE_VERSION_TIMEOUT,
};

/// The user's Node major as last probed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UserNode {
    NotProbed,
    Probed(Option<u32>),
}

static TOOLS_DIR: OnceLock<ToolsDir> = OnceLock::new();
static USER_NODE: RwLock<UserNode> = RwLock::new(UserNode::NotProbed);
static MANIFEST: OnceLock<Option<RuntimeManifest>> = OnceLock::new();

/// Makes `tools` the dir [`installed_tools`] scans. Called once, during setup.
pub fn set_tools_dir(tools: ToolsDir) {
    if TOOLS_DIR.set(tools).is_err() {
        eprintln!("The tools dir was already set; keeping the first one");
    }
}

/// Records what a probe of the user's Node found; true when the major
/// changed, since that can change which agents are ready.
pub fn record_node_probe(probe: NodeProbe) -> bool {
    record(&USER_NODE, probe)
}

/// A probe that found a major or a confirmed absence replaces the known
/// major; one that could not answer keeps it, as a missed `npm ls` keeps the
/// known npm globals.
fn record(state: &RwLock<UserNode>, probe: NodeProbe) -> bool {
    let mut current = write(state);
    let known = match *current {
        UserNode::Probed(major) => major,
        UserNode::NotProbed => None,
    };
    let next = UserNode::Probed(match probe {
        NodeProbe::Found(major) => Some(major),
        NodeProbe::Absent => None,
        NodeProbe::Inconclusive => known,
    });
    let changed = *current != next;
    *current = next;
    changed
}

/// The known major, running `probe` first when there has been none yet.
fn major_or_probe(state: &RwLock<UserNode>, probe: impl FnOnce() -> NodeProbe) -> Option<u32> {
    if let UserNode::Probed(major) = *read(state) {
        return major;
    }
    record(state, probe());
    match *read(state) {
        UserNode::Probed(major) => major,
        UserNode::NotProbed => None,
    }
}

/// Probes the user's Node once, the first time it is needed, so the first
/// profiles and launches are right before the background refresh has run.
/// Blocks for at most [`NODE_VERSION_TIMEOUT`] after the login shell is read.
pub fn user_node_major() -> Option<u32> {
    major_or_probe(&USER_NODE, || {
        let env = cached_user_env().unwrap_or_else(|_| std::env::vars().collect());
        probe_user_node(&env, NODE_VERSION_TIMEOUT)
    })
}

// Every write replaces the whole value, so a poisoned lock is still usable.
fn read(state: &RwLock<UserNode>) -> RwLockReadGuard<'_, UserNode> {
    state
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write(state: &RwLock<UserNode>) -> RwLockWriteGuard<'_, UserNode> {
    state
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The manifest compiled into the app, parsed once; `None` when it is not
/// valid, which is logged.
pub fn bundled_manifest() -> Option<&'static RuntimeManifest> {
    MANIFEST
        .get_or_init(|| {
            parse_manifest(BUNDLED_RUNTIMES)
                .inspect_err(|e| eprintln!("The bundled runtime manifest is not valid: {e}"))
                .ok()
        })
        .as_ref()
}

/// What Zorvo has installed now, read from disk on every call so an install
/// or a clean-up is seen at once. No tool counts before [`set_tools_dir`].
pub fn installed_tools() -> InstalledTools {
    let major = user_node_major();
    match (TOOLS_DIR.get(), bundled_manifest()) {
        (Some(tools), Some(manifest)) => {
            InstalledTools::scan(tools, manifest, current_platform(), major)
        }
        _ => InstalledTools {
            user_node_major: major,
            ..InstalledTools::none()
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn the_first_read_probes_and_later_reads_do_not() {
        let state = RwLock::new(UserNode::NotProbed);
        let probes = Cell::new(0);
        let probe = || {
            probes.set(probes.get() + 1);
            NodeProbe::Found(24)
        };

        assert_eq!(major_or_probe(&state, probe), Some(24));
        assert_eq!(major_or_probe(&state, probe), Some(24));
        assert_eq!(probes.get(), 1);
    }

    #[test]
    fn a_first_probe_that_cannot_answer_is_not_repeated_on_every_read() {
        let state = RwLock::new(UserNode::NotProbed);

        assert_eq!(major_or_probe(&state, || NodeProbe::Inconclusive), None);
        assert_eq!(major_or_probe(&state, || panic!("probed only once")), None);
    }

    #[test]
    fn a_failed_reprobe_keeps_the_known_major() {
        let state = RwLock::new(UserNode::NotProbed);
        assert!(record(&state, NodeProbe::Found(22)));

        assert!(!record(&state, NodeProbe::Inconclusive));
        assert_eq!(major_or_probe(&state, || unreachable!()), Some(22));

        assert!(
            record(&state, NodeProbe::Absent),
            "a confirmed absence counts"
        );
        assert_eq!(major_or_probe(&state, || unreachable!()), None);
    }
}
