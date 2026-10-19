//! The process-wide installer state. Its own test binary, since the tools dir
//! can be set only once per process.

use std::fs;
use std::path::{Path, PathBuf};

use zorvo_lib::installer::layout::ToolsDir;
use zorvo_lib::installer::{installed_tools, set_tools_dir, set_user_node_major};

/// A fresh data dir, removed when dropped.
struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn mark_installed(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    fs::write(
        dir.join("install.json"),
        r#"{"source":"test","sha256":null,"installed_at":0,"bin":null}"#,
    )
    .unwrap();
}

// One test, so the steps run in order against the one process-wide state.
#[test]
fn installed_tools_follow_the_set_tools_dir_and_user_node() {
    let before = installed_tools();
    assert_eq!(before.user_node_major, None);
    assert!(before.agents.is_empty());
    assert!(before.manifest.is_none(), "nothing is scanned before setup");

    assert!(set_user_node_major(Some(20)));
    assert!(!set_user_node_major(Some(20)), "same major, no change");
    assert_eq!(installed_tools().user_node_major, Some(20));

    let data = TempDir(
        std::env::temp_dir().join(format!("zorvo-installer-state-test-{}", std::process::id())),
    );
    let tools = ToolsDir::new(&data.0);
    mark_installed(&tools.agent_dir("opencode", "1.0.0"));
    set_tools_dir(tools.clone());

    let after = installed_tools();
    assert_eq!(after.user_node_major, Some(20));
    assert!(after.manifest.is_some(), "the bundled manifest is used");
    assert_eq!(
        after
            .agents
            .get(&("opencode".to_string(), "1.0.0".to_string())),
        Some(&tools.agent_dir("opencode", "1.0.0"))
    );
}
