use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::Duration;

use agent_desktop_lib::acp::manager::{AcpEvent, AcpLaunch, AcpManager};
use serde_json::Value;

const WAIT: Duration = Duration::from_secs(10);

fn fake_agent() -> AcpLaunch {
    AcpLaunch {
        program: "node".to_string(),
        args: vec![format!("{}/tests/fixtures/fake_acp_agent.mjs", env!("CARGO_MANIFEST_DIR"))],
        env: vec![],
    }
}

fn cwd() -> String {
    std::env::current_dir().unwrap().to_string_lossy().to_string()
}

fn manager() -> (Arc<AcpManager>, Receiver<AcpEvent>) {
    let (tx, rx) = mpsc::channel();
    let manager = AcpManager::new(Box::new(move |event| {
        let _ = tx.send(event);
    }));
    (Arc::new(manager), rx)
}

/// Waits for the first event matching `predicate`, skipping others.
fn wait_for(rx: &Receiver<AcpEvent>, predicate: impl Fn(&AcpEvent) -> bool) -> AcpEvent {
    loop {
        let event = rx.recv_timeout(WAIT).expect("timed out waiting for an ACP event");
        if predicate(&event) {
            return event;
        }
    }
}

fn agent_text(event: &AcpEvent) -> Option<String> {
    match event {
        AcpEvent::Update { update, .. } if update["sessionUpdate"] == "agent_message_chunk" => {
            update["content"]["text"].as_str().map(str::to_string)
        }
        _ => None,
    }
}

#[test]
fn starts_a_session_and_reports_its_modes() {
    let (manager, _rx) = manager();

    let started = manager.start("s-1", &cwd(), &fake_agent()).expect("start");

    assert_eq!(started.acp_session_id, "fake-1");
    assert_eq!(started.modes["currentModeId"], "default");
    assert!(started.agent_capabilities["sessionCapabilities"]["fork"].is_object());
    manager.stop("s-1");
}

#[test]
fn streams_agent_messages_and_ends_the_turn() {
    let (manager, rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();

    manager.prompt("s-1", "hi").unwrap();

    let chunk = wait_for(&rx, |e| agent_text(e).is_some());
    assert!(matches!(&chunk, AcpEvent::Update { session_id, .. } if session_id == "s-1"));
    assert_eq!(agent_text(&chunk).as_deref(), Some("echo: hi"));
    let ended = wait_for(&rx, |e| matches!(e, AcpEvent::TurnEnded { .. }));
    assert!(matches!(ended, AcpEvent::TurnEnded { stop_reason: Ok(ref r), .. } if r == "end_turn"));
    manager.stop("s-1");
}

#[test]
fn round_trips_a_permission_request() {
    let (manager, rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();
    manager.prompt("s-1", "permission").unwrap();

    let request = wait_for(&rx, |e| matches!(e, AcpEvent::PermissionRequest { .. }));
    let AcpEvent::PermissionRequest { session_id, request_id, params } = request else { unreachable!() };
    assert_eq!(session_id, "s-1");
    assert_eq!(params["toolCall"]["title"], "Run rm -rf build");
    assert_eq!(params["options"].as_array().unwrap().len(), 2);

    manager.respond_permission("s-1", &request_id, Some("allow")).unwrap();

    let chunk = wait_for(&rx, |e| agent_text(e).is_some());
    assert_eq!(agent_text(&chunk).as_deref(), Some("allowed:allow"));
    manager.stop("s-1");
}

#[test]
fn cancelling_a_turn_ends_it_as_cancelled() {
    let (manager, rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();
    manager.prompt("s-1", "slow").unwrap();

    manager.cancel("s-1").unwrap();

    let ended = wait_for(&rx, |e| matches!(e, AcpEvent::TurnEnded { .. }));
    assert!(matches!(ended, AcpEvent::TurnEnded { stop_reason: Ok(ref r), .. } if r == "cancelled"));
    manager.stop("s-1");
}

#[test]
fn forks_into_a_new_app_session_on_the_same_agent() {
    let (manager, rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();

    let forked = manager.fork("s-1", "s-2", &cwd()).expect("fork");
    assert_eq!(forked.acp_session_id, "fake-2");

    manager.prompt("s-2", "from the fork").unwrap();
    let chunk = wait_for(&rx, |e| agent_text(e).is_some());
    assert!(matches!(&chunk, AcpEvent::Update { session_id, .. } if session_id == "s-2"));
    manager.stop("s-1");
    manager.stop("s-2");
}

#[test]
fn reports_an_agent_that_exits_mid_turn() {
    let (manager, rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();

    manager.prompt("s-1", "crash").unwrap();

    let ended = wait_for(&rx, |e| matches!(e, AcpEvent::TurnEnded { .. }));
    assert!(matches!(ended, AcpEvent::TurnEnded { stop_reason: Err(_), .. }));
    let exited = wait_for(&rx, |e| matches!(e, AcpEvent::Exited { .. }));
    assert!(matches!(exited, AcpEvent::Exited { ref session_id, .. } if session_id == "s-1"));
}

#[test]
fn sets_the_session_mode() {
    let (manager, rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();

    manager.set_mode("s-1", "yolo").unwrap();

    let update = wait_for(&rx, |e| {
        matches!(e, AcpEvent::Update { update, .. } if update["sessionUpdate"] == "current_mode_update")
    });
    let AcpEvent::Update { update, .. } = update else { unreachable!() };
    assert_eq!(update["currentModeId"], Value::from("yolo"));
    manager.stop("s-1");
}

#[test]
fn rejects_bad_starts_and_unknown_sessions() {
    let (manager, _rx) = manager();

    assert!(manager.start("s-1", "relative/dir", &fake_agent()).is_err());
    let missing = AcpLaunch { program: "/nonexistent/agent".into(), args: vec![], env: vec![] };
    assert!(manager.start("s-2", &cwd(), &missing).is_err());
    assert!(manager.prompt("nope", "hi").is_err());
}

#[test]
fn stopping_a_session_forgets_it() {
    let (manager, _rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();

    manager.stop("s-1");

    let err = manager.prompt("s-1", "hi").unwrap_err();
    assert!(err.contains("not found"), "unexpected error: {err}");
}

#[test]
fn loads_an_earlier_session_without_replaying_its_history_to_the_app() {
    let (manager, rx) = manager();

    let loaded = manager
        .load("s-resumed", &cwd(), &fake_agent(), "fake-earlier")
        .expect("load");

    assert_eq!(loaded.acp_session_id, "fake-earlier");
    assert_eq!(loaded.modes["currentModeId"], "default");
    // The agent replays the old conversation while loading; the app already has it.
    manager.prompt("s-resumed", "hi again").unwrap();
    let first_text = wait_for(&rx, |e| agent_text(e).is_some());
    assert_eq!(agent_text(&first_text).as_deref(), Some("echo: hi again"));
    assert!(matches!(first_text, AcpEvent::Update { ref session_id, .. } if session_id == "s-resumed"));
    manager.stop("s-resumed");
}

#[test]
fn refuses_to_load_when_the_agent_cannot_resume_sessions() {
    let (manager, _rx) = manager();
    let mut launch = fake_agent();
    launch.env.push(("FAKE_ACP_NO_LOAD".to_string(), "1".to_string()));

    let error = manager.load("s-x", &cwd(), &launch, "fake-earlier").unwrap_err();

    assert!(error.contains("cannot resume"), "unexpected error: {error}");
}

#[test]
fn reports_that_the_agent_needs_a_sign_in_with_its_methods() {
    let (manager, _rx) = manager();
    let mut launch = fake_agent();
    launch.env.push(("FAKE_ACP_AUTH_REQUIRED".to_string(), "1".to_string()));

    let error = manager.start("s-1", &cwd(), &launch).unwrap_err();

    let methods = error
        .strip_prefix(agent_desktop_lib::acp::manager::AUTH_REQUIRED_PREFIX)
        .expect("an auth-required error");
    let methods: Value = serde_json::from_str(methods).expect("auth methods as JSON");
    assert_eq!(methods[0]["id"], "browser");
}

#[test]
fn signs_in_with_one_of_the_agent_methods() {
    let (manager, _rx) = manager();

    manager.authenticate(&cwd(), &fake_agent(), "browser").expect("authenticate");
    let error = manager.authenticate(&cwd(), &fake_agent(), "nope").unwrap_err();

    assert!(error.contains("nope"), "unexpected error: {error}");
}
