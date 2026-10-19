//! Zorvo's own installer for ACP agents, Node.js and uv.
//!
//! The app sets its tools dir once during setup and the user's Node major on
//! every environment read; [`installed_tools`] snapshots both for the resolver.
//! Before setup (or in a plain `cargo test`) nothing counts as installed.

pub mod archive;
pub mod download;
pub mod layout;
pub mod plan;
pub mod prerequisites;
pub mod runtimes;

use std::sync::{OnceLock, RwLock};

use crate::registry::schema::current_platform;
use layout::ToolsDir;
use plan::InstalledTools;
use runtimes::{parse_manifest, RuntimeManifest, BUNDLED_RUNTIMES};

static TOOLS_DIR: OnceLock<ToolsDir> = OnceLock::new();
static USER_NODE_MAJOR: RwLock<Option<u32>> = RwLock::new(None);
static MANIFEST: OnceLock<Option<RuntimeManifest>> = OnceLock::new();

/// Makes `tools` the dir [`installed_tools`] scans. Called once, during setup.
pub fn set_tools_dir(tools: ToolsDir) {
    if TOOLS_DIR.set(tools).is_err() {
        eprintln!("The tools dir was already set; keeping the first one");
    }
}

/// Records the user's Node major (`None` when there is no usable Node);
/// true when it changed, since that can change which agents are ready.
pub fn set_user_node_major(major: Option<u32>) -> bool {
    // Every write replaces the whole value, so a poisoned lock is still usable.
    let mut current = USER_NODE_MAJOR
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let changed = *current != major;
    *current = major;
    changed
}

fn user_node_major() -> Option<u32> {
    *USER_NODE_MAJOR
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The manifest compiled into the app, parsed once.
fn bundled_manifest() -> Option<&'static RuntimeManifest> {
    MANIFEST
        .get_or_init(|| {
            parse_manifest(BUNDLED_RUNTIMES)
                .inspect_err(|e| eprintln!("The bundled runtime manifest is not valid: {e}"))
                .ok()
        })
        .as_ref()
}

/// What Zorvo has installed now, read from disk on every call so an install
/// or a clean-up is seen at once. Nothing counts before [`set_tools_dir`].
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
