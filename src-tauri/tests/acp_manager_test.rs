use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use zorvo_lib::acp::manager::{AcpEvent, AcpLaunch, AcpManager};

const WAIT: Duration = Duration::from_secs(10);

fn fake_agent() -> AcpLaunch {
    AcpLaunch {
        program: "node".to_string(),
        args: vec![format!(
            "{}/tests/fixtures/fake_acp_agent.mjs",
            env!("CARGO_MANIFEST_DIR")
        )],
        env: vec![],
    }
}

fn cwd() -> String {
    std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string()
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
        let event = rx
            .recv_timeout(WAIT)
            .expect("timed out waiting for an ACP event");
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

    manager.prompt("s-1", "hi", &[]).unwrap();

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
    manager.prompt("s-1", "permission", &[]).unwrap();

    let request = wait_for(&rx, |e| matches!(e, AcpEvent::PermissionRequest { .. }));
    let AcpEvent::PermissionRequest {
        session_id,
        request_id,
        params,
    } = request
    else {
        unreachable!()
    };
    assert_eq!(session_id, "s-1");
    assert_eq!(params["toolCall"]["title"], "Run rm -rf build");
    assert_eq!(params["options"].as_array().unwrap().len(), 2);

    manager
        .respond_permission("s-1", &request_id, Some("allow"))
        .unwrap();

    let chunk = wait_for(&rx, |e| agent_text(e).is_some());
    assert_eq!(agent_text(&chunk).as_deref(), Some("allowed:allow"));
    manager.stop("s-1");
}

#[test]
fn cancelling_a_turn_ends_it_as_cancelled() {
    let (manager, rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();
    manager.prompt("s-1", "slow", &[]).unwrap();

    manager.cancel("s-1").unwrap();

    let ended = wait_for(&rx, |e| matches!(e, AcpEvent::TurnEnded { .. }));
    assert!(
        matches!(ended, AcpEvent::TurnEnded { stop_reason: Ok(ref r), .. } if r == "cancelled")
    );
    manager.stop("s-1");
}

#[test]
fn forks_into_a_new_app_session_on_the_same_agent() {
    let (manager, rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();

    let forked = manager.fork("s-1", "s-2", &cwd()).expect("fork");
    assert_eq!(forked.acp_session_id, "fake-2");

    manager.prompt("s-2", "from the fork", &[]).unwrap();
    let chunk = wait_for(&rx, |e| agent_text(e).is_some());
    assert!(matches!(&chunk, AcpEvent::Update { session_id, .. } if session_id == "s-2"));
    manager.stop("s-1");
    manager.stop("s-2");
}

#[test]
fn reports_an_agent_that_exits_mid_turn() {
    let (manager, rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();

    manager.prompt("s-1", "crash", &[]).unwrap();

    let ended = wait_for(&rx, |e| matches!(e, AcpEvent::TurnEnded { .. }));
    assert!(matches!(
        ended,
        AcpEvent::TurnEnded {
            stop_reason: Err(_),
            ..
        }
    ));
    let exited = wait_for(&rx, |e| matches!(e, AcpEvent::Exited { .. }));
    assert!(matches!(exited, AcpEvent::Exited { ref session_id, .. } if session_id == "s-1"));
}

#[test]
fn sets_the_session_mode() {
    let (manager, rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();

    manager.set_mode("s-1", "yolo").unwrap();

    let update = wait_for(
        &rx,
        |e| matches!(e, AcpEvent::Update { update, .. } if update["sessionUpdate"] == "current_mode_update"),
    );
    let AcpEvent::Update { update, .. } = update else {
        unreachable!()
    };
    assert_eq!(update["currentModeId"], Value::from("yolo"));
    manager.stop("s-1");
}

#[test]
fn rejects_bad_starts_and_unknown_sessions() {
    let (manager, _rx) = manager();

    assert!(manager.start("s-1", "relative/dir", &fake_agent()).is_err());
    let missing = AcpLaunch {
        program: "/nonexistent/agent".into(),
        args: vec![],
        env: vec![],
    };
    assert!(manager.start("s-2", &cwd(), &missing).is_err());
    assert!(manager.prompt("nope", "hi", &[]).is_err());
}

#[test]
fn stopping_a_session_forgets_it() {
    let (manager, _rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();

    manager.stop("s-1");

    let err = manager.prompt("s-1", "hi", &[]).unwrap_err();
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
    manager.prompt("s-resumed", "hi again", &[]).unwrap();
    let first_text = wait_for(&rx, |e| agent_text(e).is_some());
    assert_eq!(agent_text(&first_text).as_deref(), Some("echo: hi again"));
    assert!(
        matches!(first_text, AcpEvent::Update { ref session_id, .. } if session_id == "s-resumed")
    );
    manager.stop("s-resumed");
}

#[test]
fn refuses_to_load_when_the_agent_cannot_resume_sessions() {
    let (manager, _rx) = manager();
    let mut launch = fake_agent();
    launch
        .env
        .push(("FAKE_ACP_NO_LOAD".to_string(), "1".to_string()));

    let error = manager
        .load("s-x", &cwd(), &launch, "fake-earlier")
        .unwrap_err();

    assert!(error.contains("cannot resume"), "unexpected error: {error}");
}

#[test]
fn reports_that_the_agent_needs_a_sign_in_with_its_methods() {
    let (manager, _rx) = manager();
    let mut launch = fake_agent();
    launch
        .env
        .push(("FAKE_ACP_AUTH_REQUIRED".to_string(), "1".to_string()));

    let error = manager.start("s-1", &cwd(), &launch).unwrap_err();

    let methods = error
        .strip_prefix(zorvo_lib::acp::manager::AUTH_REQUIRED_PREFIX)
        .expect("an auth-required error");
    let methods: Value = serde_json::from_str(methods).expect("auth methods as JSON");
    assert_eq!(methods[0]["id"], "browser");
}

#[test]
fn signs_in_with_one_of_the_agent_methods() {
    let (manager, _rx) = manager();

    manager
        .authenticate(&cwd(), &fake_agent(), "browser")
        .expect("authenticate");
    let error = manager
        .authenticate(&cwd(), &fake_agent(), "nope")
        .unwrap_err();

    assert!(error.contains("nope"), "unexpected error: {error}");
}

#[test]
fn refuses_a_prompt_whose_attachment_is_missing_before_sending_it() {
    let (manager, _rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();

    let error = manager
        .prompt("s-1", "look", &["/definitely/not/here.png".to_string()])
        .unwrap_err();

    assert!(error.contains("Cannot attach"), "unexpected error: {error}");
    manager.stop("s-1");
}

#[test]
fn keeps_the_sign_in_methods_parseable_when_the_agent_logs_to_stderr() {
    let (manager, _rx) = manager();
    let mut launch = fake_agent();
    launch
        .env
        .push(("FAKE_ACP_AUTH_REQUIRED".to_string(), "1".to_string()));
    launch
        .env
        .push(("FAKE_ACP_STDERR".to_string(), "1".to_string()));

    let error = manager.start("s-1", &cwd(), &launch).unwrap_err();

    let methods = error
        .strip_prefix(zorvo_lib::acp::manager::AUTH_REQUIRED_PREFIX)
        .expect("an auth-required error");
    serde_json::from_str::<Value>(methods).expect("auth methods stay valid JSON");
}

#[test]
fn reports_a_generic_server_error_as_is_rather_than_as_a_sign_in() {
    let (manager, _rx) = manager();
    let mut launch = fake_agent();
    launch
        .env
        .push(("FAKE_ACP_SERVER_ERROR".to_string(), "1".to_string()));

    let error = manager.start("s-1", &cwd(), &launch).unwrap_err();

    assert!(!error.starts_with(zorvo_lib::acp::manager::AUTH_REQUIRED_PREFIX));
    assert!(error.contains("disk full"), "unexpected error: {error}");
}

#[test]
fn recognizes_a_sign_in_request_however_the_agent_phrases_it() {
    for message in [
        "Not logged in. Run `codex login`",
        "You must be signed in",
        "log-in required",
    ] {
        let (manager, _rx) = manager();
        let mut launch = fake_agent();
        launch
            .env
            .push(("FAKE_ACP_AUTH_REQUIRED".to_string(), "1".to_string()));
        launch
            .env
            .push(("FAKE_ACP_AUTH_MESSAGE".to_string(), message.to_string()));

        let error = manager.start("s-1", &cwd(), &launch).unwrap_err();

        assert!(
            error.starts_with(zorvo_lib::acp::manager::AUTH_REQUIRED_PREFIX),
            "{message:?} gave {error}"
        );
    }
}

#[test]
fn stop_all_ends_every_session_a_previous_ui_left_running() {
    let (manager, _rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();
    manager.start("s-2", &cwd(), &fake_agent()).unwrap();

    assert_eq!(manager.stop_all(), 2);

    assert!(manager.prompt("s-1", "hi", &[]).is_err());
    assert!(manager.prompt("s-2", "hi", &[]).is_err());
}

#[test]
fn reports_an_agent_error_without_its_stderr_noise() {
    let (manager, _rx) = manager();
    let mut launch = fake_agent();
    launch
        .env
        .push(("FAKE_ACP_SERVER_ERROR".to_string(), "1".to_string()));
    launch
        .env
        .push(("FAKE_ACP_STDERR".to_string(), "1".to_string()));

    let error = manager.start("s-1", &cwd(), &launch).unwrap_err();

    assert!(error.contains("disk full"), "unexpected error: {error}");
    assert!(!error.contains("warming up"), "stderr leaked into: {error}");
}

fn with_env(mut launch: AcpLaunch, key: &str, value: &str) -> AcpLaunch {
    launch.env.push((key.to_string(), value.to_string()));
    launch
}

fn auth_methods_in(error: &str) -> Value {
    let methods = error
        .strip_prefix(zorvo_lib::acp::manager::AUTH_REQUIRED_PREFIX)
        .unwrap_or_else(|| panic!("expected an auth-required error, got {error}"));
    serde_json::from_str(methods).expect("auth methods as JSON")
}

#[test]
fn reports_a_sign_in_when_the_agent_refuses_a_prompt_for_it() {
    let (manager, rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();

    manager.prompt("s-1", "needs-login", &[]).unwrap();

    let ended = wait_for(&rx, |e| matches!(e, AcpEvent::TurnEnded { .. }));
    let AcpEvent::TurnEnded {
        stop_reason: Err(error),
        ..
    } = ended
    else {
        panic!("expected a failed turn, got {ended:?}");
    };
    assert_eq!(auth_methods_in(&error)[0]["id"], "browser");
    manager.stop("s-1");
}

#[test]
fn probes_an_agent_for_its_options_and_commands_without_keeping_a_session() {
    let (manager, _rx) = manager();

    let probed = manager.probe(&cwd(), &fake_agent(), true).expect("probe");

    assert_eq!(probed.modes["currentModeId"], "default");
    assert_eq!(probed.config_options[0]["id"], "model");
    assert_eq!(probed.commands[0]["name"], "review");
    assert!(
        manager.root_pids().is_empty(),
        "the probe must not leave an agent running"
    );
}

#[test]
fn probing_reports_a_sign_in_when_the_agent_will_not_open_a_session() {
    let (manager, _rx) = manager();
    let launch = with_env(fake_agent(), "FAKE_ACP_AUTH_REQUIRED", "1");

    let error = manager.probe(&cwd(), &launch, true).unwrap_err();

    assert_eq!(auth_methods_in(&error)[0]["id"], "browser");
}

#[test]
fn probing_reports_a_sign_in_when_the_agent_says_nobody_is_signed_in() {
    let (manager, _rx) = manager();
    let launch = with_env(fake_agent(), "FAKE_ACP_AUTH_STATUS", "none");

    let error = manager.probe(&cwd(), &launch, true).unwrap_err();

    assert_eq!(auth_methods_in(&error)[0]["id"], "browser");
}

#[test]
fn probing_succeeds_when_the_agent_says_someone_is_signed_in() {
    let (manager, _rx) = manager();
    let launch = with_env(fake_agent(), "FAKE_ACP_AUTH_STATUS", "account");

    let probed = manager.probe(&cwd(), &launch, true).expect("probe");

    assert_eq!(probed.commands[0]["name"], "review");
}

/// A fresh file the fake agent records the methods it was called with in.
fn method_log(name: &str) -> std::path::PathBuf {
    let path =
        std::env::temp_dir().join(format!("zorvo-probe-{}-{}.log", name, std::process::id()));
    let _ = std::fs::remove_file(&path);
    path
}

/// Waits up to two seconds for the agent to be called with `method`: the
/// probe deletes its session in the background.
fn eventually_called(path: &std::path::Path, method: &str) -> bool {
    let until = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < until {
        if methods_in(path).iter().any(|m| m == method) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn methods_in(path: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

#[test]
fn probing_deletes_the_session_it_opened() {
    let (manager, _rx) = manager();
    let log = method_log("delete");
    let launch = with_env(fake_agent(), "FAKE_ACP_METHOD_LOG", log.to_str().unwrap());

    manager.probe(&cwd(), &launch, true).expect("probe");

    assert!(methods_in(&log).contains(&"session/new".to_string()));
    assert!(
        eventually_called(&log, "session/delete"),
        "{:?}",
        methods_in(&log)
    );
}

#[test]
fn probing_a_known_agent_that_reports_its_sign_in_opens_no_session() {
    let (manager, _rx) = manager();
    let log = method_log("light");
    let launch = with_env(
        with_env(fake_agent(), "FAKE_ACP_METHOD_LOG", log.to_str().unwrap()),
        "FAKE_ACP_AUTH_STATUS",
        "account",
    );

    let probed = manager.probe(&cwd(), &launch, false).expect("probe");

    assert_eq!(methods_in(&log), vec!["initialize".to_string()]);
    assert!(probed.modes.is_null());
    assert!(probed.sign_in_checked);
}

#[test]
fn probing_a_known_agent_that_cannot_report_its_sign_in_opens_a_session_to_check() {
    let (manager, _rx) = manager();
    let log = method_log("check");
    let launch = with_env(fake_agent(), "FAKE_ACP_METHOD_LOG", log.to_str().unwrap());

    let probed = manager.probe(&cwd(), &launch, false).expect("probe");

    assert!(methods_in(&log).contains(&"session/new".to_string()));
    assert!(probed.sign_in_checked);
}

#[test]
fn probing_a_known_agent_reports_a_sign_in_when_it_refuses_the_session() {
    let (manager, _rx) = manager();
    let launch = with_env(fake_agent(), "FAKE_ACP_AUTH_REQUIRED", "1");

    let error = manager.probe(&cwd(), &launch, false).unwrap_err();

    assert_eq!(auth_methods_in(&error)[0]["id"], "browser");
}

#[test]
fn probing_returns_without_waiting_for_the_agent_to_delete_its_session() {
    let (manager, _rx) = manager();
    let log = method_log("slow-delete");
    let launch = with_env(
        with_env(fake_agent(), "FAKE_ACP_METHOD_LOG", log.to_str().unwrap()),
        "FAKE_ACP_SLOW_DELETE",
        "1",
    );
    let started = std::time::Instant::now();

    manager.probe(&cwd(), &launch, true).expect("probe");

    assert!(
        started.elapsed() < Duration::from_millis(2500),
        "took {:?}",
        started.elapsed()
    );
    assert!(
        eventually_called(&log, "session/delete"),
        "{:?}",
        methods_in(&log)
    );
}

#[test]
fn probing_without_a_session_still_reports_that_nobody_is_signed_in() {
    let (manager, _rx) = manager();
    let launch = with_env(fake_agent(), "FAKE_ACP_AUTH_STATUS", "none");

    let error = manager.probe(&cwd(), &launch, false).unwrap_err();

    assert_eq!(auth_methods_in(&error)[0]["id"], "browser");
}

#[test]
fn probing_does_not_wait_long_for_commands_an_agent_never_sends() {
    let (manager, _rx) = manager();
    let launch = with_env(fake_agent(), "FAKE_ACP_NO_COMMANDS", "1");
    let started = std::time::Instant::now();

    let probed = manager.probe(&cwd(), &launch, true).expect("probe");

    assert!(
        started.elapsed() < Duration::from_secs(4),
        "took {:?}",
        started.elapsed()
    );
    assert_eq!(probed.commands, Value::Array(vec![]));
    assert_eq!(probed.config_options[0]["id"], "model");
}
