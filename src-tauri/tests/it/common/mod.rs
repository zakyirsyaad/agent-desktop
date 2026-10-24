//! Helpers shared by the ACP integration tests.

use std::path::Path;
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::Duration;

use zorvo_lib::acp::manager::{AcpEvent, AcpLaunch, AcpManager};

/// How long a test waits for an event from the agent.
const WAIT: Duration = Duration::from_secs(10);

/// The fake ACP agent, with the capabilities it advertises by default.
pub fn fake_agent() -> AcpLaunch {
    AcpLaunch {
        program: "node".to_string(),
        args: vec![format!(
            "{}/tests/fixtures/fake_acp_agent.mjs",
            env!("CARGO_MANIFEST_DIR")
        )],
        env: vec![],
    }
}

/// The fake ACP agent started with `env` set, to add capabilities or logs.
pub fn fake_agent_with(env: &[(&str, &str)]) -> AcpLaunch {
    AcpLaunch {
        env: env
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect(),
        ..fake_agent()
    }
}

pub fn cwd() -> String {
    std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string()
}

/// A manager whose events a test reads from the returned receiver.
pub fn manager() -> (Arc<AcpManager>, Receiver<AcpEvent>) {
    let (tx, rx) = mpsc::channel();
    let manager = AcpManager::new(Box::new(move |event| {
        let _ = tx.send(event);
    }));
    (Arc::new(manager), rx)
}

/// Waits for the first event matching `predicate`, skipping others.
pub fn wait_for(rx: &Receiver<AcpEvent>, predicate: impl Fn(&AcpEvent) -> bool) -> AcpEvent {
    loop {
        let event = rx
            .recv_timeout(WAIT)
            .expect("timed out waiting for an ACP event");
        if predicate(&event) {
            return event;
        }
    }
}

/// The text of an agent message chunk, for any other event `None`.
pub fn agent_text(event: &AcpEvent) -> Option<String> {
    match event {
        AcpEvent::Update { update, .. } if update["sessionUpdate"] == "agent_message_chunk" => {
            update["content"]["text"].as_str().map(str::to_string)
        }
        _ => None,
    }
}

/// The methods recorded in the file `FAKE_ACP_CALL_LOG` named.
pub fn called_methods(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}
