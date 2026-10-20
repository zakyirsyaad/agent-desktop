use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use zorvo_lib::acp::manager::{
    AcpEvent, AcpLaunch, AcpManager, ELICITATION_GONE, ELICITATION_INVALID_PREFIX,
};
use zorvo_lib::acp::terminal_auth::SignInAttempts;

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
fn refuses_to_fork_when_the_agent_cannot() {
    let (manager, _rx) = manager();
    let launch = with_env(fake_agent(), "FAKE_ACP_NO_FORK", "1");
    let log = method_log("no-fork");
    let launch = with_env(launch, "FAKE_ACP_METHOD_LOG", log.to_str().unwrap());
    manager.start("s-1", &cwd(), &launch).unwrap();

    let error = manager.fork("s-1", "s-2", &cwd()).unwrap_err();

    assert!(error.contains("cannot fork"), "unexpected error: {error}");
    assert!(!methods_in(&log).iter().any(|m| m == "session/fork"));
    assert!(manager.prompt("s-2", "hi", &[]).is_err());
    manager.stop("s-1");
}

/// The replies the fake agent got to the requests it sent while `session/new`
/// waited, by request id.
fn early_replies(path: &std::path::Path) -> HashMap<String, Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("a JSON reply"))
        .map(|reply| (reply["id"].as_str().unwrap_or_default().to_string(), reply))
        .collect()
}

#[test]
fn answers_agent_requests_sent_before_the_session_is_registered() {
    let (manager, rx) = manager();
    let log = method_log("early-requests");
    let launch = with_env(
        fake_agent(),
        "FAKE_ACP_EARLY_REQUESTS",
        log.to_str().unwrap(),
    );

    let started = manager.start("s-1", &cwd(), &launch).expect("start");

    assert_eq!(started.acp_session_id, "fake-1");
    let replies = early_replies(&log);
    assert_eq!(replies["early-fs"]["error"]["code"], -32601);
    assert_eq!(
        replies["early-permission"]["result"]["outcome"]["outcome"],
        "cancelled"
    );
    // Nobody was asked: the request belonged to no session the app knows.
    assert!(rx
        .try_iter()
        .all(|e| !matches!(e, AcpEvent::PermissionRequest { .. })));
    manager.stop("s-1");
}

#[test]
fn answers_agent_requests_sent_while_a_session_loads() {
    let (manager, _rx) = manager();
    let log = method_log("early-load-requests");
    let launch = with_env(
        fake_agent(),
        "FAKE_ACP_EARLY_REQUESTS",
        log.to_str().unwrap(),
    );

    manager
        .load("s-1", &cwd(), &launch, "fake-old")
        .expect("load");

    let replies = early_replies(&log);
    assert_eq!(replies["early-fs"]["error"]["code"], -32601);
    assert_eq!(
        replies["early-permission"]["result"]["outcome"]["outcome"],
        "cancelled"
    );
    manager.stop("s-1");
}

fn permission_for(rx: &Receiver<AcpEvent>, app_id: &str) -> AcpEvent {
    wait_for(
        rx,
        |e| matches!(e, AcpEvent::PermissionRequest { session_id, .. } if session_id == app_id),
    )
}

#[test]
fn asks_the_user_about_a_permission_sent_right_after_a_session_opens() {
    let (manager, rx) = manager();
    let launch = with_env(fake_agent(), "FAKE_ACP_ASK_AFTER_OPEN", "1");

    manager.start("s-1", &cwd(), &launch).unwrap();
    permission_for(&rx, "s-1");
    manager.fork("s-1", "s-2", &cwd()).unwrap();
    permission_for(&rx, "s-2");

    manager.stop("s-1");
    manager.stop("s-2");
}

#[test]
fn cancels_a_permission_request_for_a_session_the_app_does_not_know() {
    let (manager, rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();

    manager.prompt("s-1", "stray-permission", &[]).unwrap();

    let chunk = wait_for(&rx, |e| agent_text(e).is_some());
    assert_eq!(agent_text(&chunk).as_deref(), Some("stray:cancelled"));
    manager.stop("s-1");
}

#[test]
fn routes_each_agent_process_to_its_own_session_when_their_ids_match() {
    let (manager, rx) = manager();
    // Each start is its own agent process, and both call their session `fake-1`.
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();
    manager.start("s-2", &cwd(), &fake_agent()).unwrap();

    manager.prompt("s-1", "permission", &[]).unwrap();
    let AcpEvent::PermissionRequest { request_id, .. } = permission_for(&rx, "s-1") else {
        unreachable!()
    };
    manager
        .respond_permission("s-1", &request_id, Some("allow"))
        .unwrap();
    wait_for(&rx, |e| matches!(e, AcpEvent::TurnEnded { .. }));

    manager.stop("s-2");
    manager.prompt("s-1", "hi", &[]).unwrap();
    let chunk = wait_for(&rx, |e| agent_text(e).is_some());
    assert!(matches!(&chunk, AcpEvent::Update { session_id, .. } if session_id == "s-1"));
    assert_eq!(agent_text(&chunk).as_deref(), Some("echo: hi"));
    manager.stop("s-1");
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
fn offers_terminal_sign_in_because_zorvo_advertises_it() {
    let (manager, _rx) = manager();
    let launch = with_env(fake_agent(), "FAKE_ACP_AUTH_REQUIRED", "1");

    let err = manager.start("s-1", &cwd(), &launch).unwrap_err();

    let methods = auth_methods_in(&err);
    let terminal = methods
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == "terminal-login")
        .expect("terminal method listed");
    assert_eq!(terminal["type"], "terminal");
    assert_eq!(terminal["args"][0], "--login");
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

#[test]
fn an_opened_session_does_not_show_a_sign_in_for_an_agent_that_says_nothing_about_it() {
    let (manager, _rx) = manager();
    let launch = with_env(fake_agent(), "FAKE_ACP_AUTH_STATUS", "silent");

    let probed = manager.probe(&cwd(), &launch, true).expect("probe");

    assert_eq!(probed.config_options[0]["id"], "model");
    assert!(!probed.sign_in_checked);
}

#[test]
fn a_signed_out_probe_returns_without_waiting_for_the_agent_to_delete_its_session() {
    let (manager, _rx) = manager();
    let log = method_log("signed-out-slow-delete");
    let launch = with_env(
        with_env(
            with_env(fake_agent(), "FAKE_ACP_METHOD_LOG", log.to_str().unwrap()),
            "FAKE_ACP_SLOW_DELETE",
            "1",
        ),
        "FAKE_ACP_AUTH_STATUS",
        "none",
    );
    let started = std::time::Instant::now();

    let error = manager.probe(&cwd(), &launch, true).unwrap_err();

    assert!(
        started.elapsed() < Duration::from_millis(2500),
        "took {:?}",
        started.elapsed()
    );
    assert_eq!(auth_methods_in(&error)[0]["id"], "browser");
    assert!(
        eventually_called(&log, "session/delete"),
        "{:?}",
        methods_in(&log)
    );
}

/// A data dir unique to one test, removed when dropped.
struct AgentDir(std::path::PathBuf);

impl Drop for AgentDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The fake agent copied under a fresh dir, started by a script there, as a
/// binary agent Zorvo installed is.
fn agent_copied_under(tag: &str) -> (AgentDir, AcpLaunch) {
    use std::os::unix::fs::PermissionsExt;

    let dir = std::env::temp_dir().join(format!("zorvo-acp-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::copy(
        format!(
            "{}/tests/fixtures/fake_acp_agent.mjs",
            env!("CARGO_MANIFEST_DIR")
        ),
        dir.join("agent.mjs"),
    )
    .unwrap();
    let script = dir.join("agent");
    std::fs::write(
        &script,
        "#!/bin/sh\nexec node \"$(dirname \"$0\")/agent.mjs\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let launch = AcpLaunch {
        program: script.to_string_lossy().to_string(),
        args: vec![],
        env: vec![],
    };
    (AgentDir(dir), launch)
}

#[test]
fn is_running_under_sees_a_session_started_from_that_dir() {
    let (manager, _rx) = manager();
    let (dir, launch) = agent_copied_under("running-under");
    let sibling = std::path::PathBuf::from(format!("{}-2", dir.0.display()));
    assert!(!manager.is_running_under(&dir.0));

    manager.start("s-1", &cwd(), &launch).expect("start");

    assert!(manager.is_running_under(&dir.0));
    assert!(
        !manager.is_running_under(&sibling),
        "a dir whose name only starts the same is another dir"
    );
    manager.start("s-2", &cwd(), &fake_agent()).expect("start");
    manager.stop("s-1");
    assert!(
        !manager.is_running_under(&dir.0),
        "no session of that agent is left"
    );
    manager.stop("s-2");
}

#[test]
fn is_running_under_sees_a_session_whose_path_reaches_into_that_dir() {
    let (manager, _rx) = manager();
    // A dir the agent only reaches through PATH, as a prerequisite or Zorvo's uv is.
    let dir =
        AgentDir(std::env::temp_dir().join(format!("zorvo-acp-path-under-{}", std::process::id())));
    let bin = dir.0.join("pi").join("1.0.0").join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let sibling = std::path::PathBuf::from(format!("{}-2", dir.0.display()));
    let user_path = std::env::var("PATH").unwrap_or_default();
    let launch = AcpLaunch {
        env: vec![("PATH".to_string(), format!("{}:{user_path}", bin.display()))],
        ..fake_agent()
    };

    manager.start("s-1", &cwd(), &launch).expect("start");

    assert!(manager.is_running_under(&dir.0));
    assert!(
        !manager.is_running_under(&sibling),
        "a dir whose name only starts the same is another dir"
    );
    manager.stop("s-1");
    assert!(!manager.is_running_under(&dir.0));
}

#[test]
fn builds_the_login_from_the_agent_launch_and_its_terminal_method() {
    let (manager, _rx) = manager();

    let login = manager
        .terminal_login(&cwd(), &fake_agent(), "terminal-login")
        .expect("terminal login");

    assert_eq!(login.program, "node");
    assert_eq!(login.args.len(), 2);
    assert!(login.args[0].ends_with("fake_acp_agent.mjs"));
    assert_eq!(login.args[1], "--login");
    assert!(login
        .env
        .contains(&("FAKE_LOGIN_GREETING".to_string(), "hello".to_string())));
}

#[test]
fn asks_for_a_sign_in_again_when_the_method_is_gone() {
    let (manager, _rx) = manager();

    let error = manager
        .terminal_login(&cwd(), &fake_agent(), "browser")
        .unwrap_err();

    assert!(error.starts_with("ACP_AUTH_REQUIRED:"), "{error}");
    assert!(error.contains("terminal-login"), "{error}");
}

#[test]
fn refuses_a_terminal_method_that_sets_path() {
    let (manager, _rx) = manager();
    let launch = with_env(fake_agent(), "FAKE_ACP_BAD_TERMINAL_ENV", "1");

    let error = manager
        .terminal_login(&cwd(), &launch, "terminal-login")
        .unwrap_err();

    assert_eq!(error, "Zorvo does not run this sign-in: it sets PATH");
}

#[test]
fn never_sends_authenticate_for_a_terminal_method() {
    let (manager, _rx) = manager();
    let log = method_log("terminal-authenticate");
    let launch = with_env(fake_agent(), "FAKE_ACP_METHOD_LOG", log.to_str().unwrap());

    let error = manager
        .authenticate(&cwd(), &launch, "terminal-login")
        .unwrap_err();

    assert!(error.contains("runs in a terminal"), "{error}");
    let methods = methods_in(&log);
    assert!(methods.contains(&"initialize".to_string()), "{methods:?}");
    assert!(
        !methods.contains(&"authenticate".to_string()),
        "{methods:?}"
    );
}

/// Runs the fake agent's terminal login in a PTY; returns its output and exit code.
fn run_login_in_pty(terminal_id: &str, launch: AcpLaunch) -> (String, u32) {
    use zorvo_lib::pty_session::{PtyEvent, PtySessionManager};

    let (tx, rx) = mpsc::channel();
    let pty = PtySessionManager::new(Box::new(move |event| {
        let _ = tx.send(event);
    }));
    let (acp, _rx) = manager();
    let login = acp
        .terminal_login(&cwd(), &launch, "terminal-login")
        .expect("terminal login");
    pty.start_session(terminal_id, &cwd(), &login.program, &login.args, &login.env)
        .expect("start login");

    let mut output = String::new();
    loop {
        match rx.recv_timeout(WAIT).expect("timed out waiting for login") {
            PtyEvent::Output { data, .. } => output.push_str(&data),
            PtyEvent::Exit { exit_code, .. } => return (output, exit_code),
        }
    }
}

#[test]
fn runs_the_terminal_login_in_a_pty_and_reports_its_exit() {
    let (output, code) = run_login_in_pty("signin-test-1", fake_agent());
    assert!(output.contains("signed in: hello"), "{output:?}");
    assert_eq!(code, 0);

    let failing = with_env(fake_agent(), "FAKE_LOGIN_EXIT", "1");
    let (_, code) = run_login_in_pty("signin-test-2", failing);
    assert_eq!(code, 1);
}

#[test]
fn cancelling_a_sign_in_ends_the_agent_it_is_reading_the_method_from() {
    let (manager, _rx) = manager();
    let attempts = Arc::new(SignInAttempts::default());
    attempts.begin("signin-cancel-1").expect("begin");
    let launch = with_env(fake_agent(), "FAKE_ACP_SLOW_INIT", "1");
    let started = std::time::Instant::now();

    let login = {
        let attempts = Arc::clone(&attempts);
        let manager = Arc::clone(&manager);
        std::thread::spawn(move || {
            manager.terminal_login_with(&cwd(), &launch, "terminal-login", |connection| {
                attempts.track("signin-cancel-1", connection)
            })
        })
    };
    std::thread::sleep(Duration::from_millis(500));
    attempts.cancel("signin-cancel-1");

    assert!(login.join().expect("join").is_err());
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "the agent was not ended"
    );
    assert!(attempts.is_cancelled("signin-cancel-1"));
}

#[test]
fn lists_the_folder_of_every_open_session_until_it_stops() {
    let (manager, _rx) = manager();
    let other = std::env::temp_dir().canonicalize().unwrap();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();
    manager
        .fork("s-1", "s-2", &other.to_string_lossy())
        .expect("fork");

    let mut folders = manager.session_folders();
    folders.sort();
    let mut expected = vec![std::path::PathBuf::from(cwd()), other.clone()];
    expected.sort();
    assert_eq!(folders, expected);

    manager.stop("s-1");
    manager.stop("s-2");
    assert!(manager.session_folders().is_empty());
}

#[test]
fn advertises_form_and_url_elicitation() {
    let (manager, _rx) = manager();
    let log = method_log("init-capabilities");
    let launch = with_env(fake_agent(), "FAKE_ACP_INIT_LOG", log.to_str().unwrap());

    manager.start("s-1", &cwd(), &launch).expect("start");

    let capabilities: Value =
        serde_json::from_str(&std::fs::read_to_string(&log).expect("init log")).unwrap();
    assert_eq!(
        capabilities["elicitation"],
        serde_json::json!({ "form": {}, "url": {} })
    );
    manager.stop("s-1");
}

fn is_elicitation(event: &AcpEvent) -> bool {
    matches!(event, AcpEvent::Elicitation { .. })
}

/// The first `elicited:<reply>` the fake agent says.
fn elicited(rx: &Receiver<AcpEvent>) -> String {
    let said = wait_for(rx, |e| {
        agent_text(e).is_some_and(|text| text.starts_with("elicited:"))
    });
    agent_text(&said).unwrap()
}

#[test]
fn routes_a_form_request_to_its_session() {
    let (manager, rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();

    manager.prompt("s-1", "elicit-form", &[]).unwrap();

    let AcpEvent::Elicitation {
        session_id,
        key,
        view,
    } = wait_for(&rx, is_elicitation)
    else {
        unreachable!()
    };
    assert_eq!(session_id, "s-1");
    assert!(key.starts_with("el-"), "unexpected key {key}");
    assert_eq!(view["mode"], "form");
    assert_eq!(view["fields"][0]["name"], "name");
    manager.stop("s-1");
}

#[test]
fn refuses_an_unknown_mode_with_invalid_params() {
    let (manager, rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();

    manager.prompt("s-1", "elicit-voice", &[]).unwrap();

    let seen = events_through(&rx, |e| matches!(e, AcpEvent::TurnEnded { .. }));
    let said = said_elicited(&seen);
    assert_eq!(said.len(), 1, "{seen:?}");
    assert!(
        said[0].contains(r#""code":-32602"#),
        "unexpected reply {said:?}"
    );
    assert!(!seen.iter().any(is_elicitation), "{seen:?}");
    manager.stop("s-1");
}

#[test]
fn shows_a_request_sent_while_the_session_opens() {
    let (manager, rx) = manager();
    let log = method_log("elicit-on-new");
    let launch = with_env(
        fake_agent(),
        "FAKE_ACP_ELICIT_ON_NEW",
        log.to_str().unwrap(),
    );

    let starting = {
        let manager = Arc::clone(&manager);
        std::thread::spawn(move || manager.start("s-1", &cwd(), &launch))
    };

    let event = wait_for(&rx, is_elicitation);
    assert!(matches!(event, AcpEvent::Elicitation { ref session_id, .. } if session_id == "s-1"));
    manager.stop("s-1");
    // Nobody answers the form here, so the agent gives up on the session.
    let _ = starting.join();
}

#[test]
fn cancels_requests_from_unrouted_agents() {
    let (manager, _rx) = manager();
    let log = method_log("elicit-on-probe");
    let launch = with_env(
        fake_agent(),
        "FAKE_ACP_ELICIT_ON_NEW",
        log.to_str().unwrap(),
    );

    manager.probe(&cwd(), &launch, true).expect("probe");

    let reply: Value =
        serde_json::from_str(std::fs::read_to_string(&log).expect("reply").trim()).unwrap();
    assert_eq!(reply["result"], serde_json::json!({ "action": "cancel" }));
    // No event check: a probe's agent is never routed to the sink at all.
}

#[test]
fn keeps_two_requests_apart() {
    let (manager, rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();

    manager.prompt("s-1", "elicit-twice", &[]).unwrap();

    let key_of = |event: AcpEvent| match event {
        AcpEvent::Elicitation {
            session_id, key, ..
        } if session_id == "s-1" => key,
        other => panic!("unexpected event {other:?}"),
    };
    let first = key_of(wait_for(&rx, is_elicitation));
    let second = key_of(wait_for(&rx, is_elicitation));
    assert_ne!(first, second);
    manager.stop("s-1");
}

#[test]
fn ignores_unknown_completions() {
    let (manager, rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();

    manager.prompt("s-1", "elicit-complete", &[]).unwrap();

    let mut seen = Vec::new();
    loop {
        let event = rx
            .recv_timeout(WAIT)
            .expect("timed out waiting for the turn");
        let ended = matches!(event, AcpEvent::TurnEnded { .. });
        seen.push(event);
        if ended {
            break;
        }
    }
    assert!(seen
        .iter()
        .any(|e| agent_text(e).as_deref() == Some("completed-sent")));
    assert!(
        !seen
            .iter()
            .any(|e| matches!(e, AcpEvent::ElicitationComplete { .. })),
        "{seen:?}"
    );
    manager.stop("s-1");
}

/// Every event up to and including the first that matches `predicate`.
fn events_through(rx: &Receiver<AcpEvent>, predicate: impl Fn(&AcpEvent) -> bool) -> Vec<AcpEvent> {
    let mut seen = Vec::new();
    loop {
        let event = rx
            .recv_timeout(WAIT)
            .expect("timed out waiting for an ACP event");
        let done = predicate(&event);
        seen.push(event);
        if done {
            return seen;
        }
    }
}

/// Every event that arrives within `window`.
fn events_within(rx: &Receiver<AcpEvent>, window: Duration) -> Vec<AcpEvent> {
    let until = std::time::Instant::now() + window;
    let mut seen = Vec::new();
    while let Some(left) = until.checked_duration_since(std::time::Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(event) => seen.push(event),
            Err(_) => break,
        }
    }
    seen
}

/// The `elicited:<reply>` texts among `events`, without the prefix.
fn said_elicited(events: &[AcpEvent]) -> Vec<String> {
    events
        .iter()
        .filter_map(agent_text)
        .filter_map(|text| text.strip_prefix("elicited:").map(str::to_string))
        .collect()
}

type Opened = Arc<Mutex<Vec<String>>>;

/// A manager whose URL opener records each link instead of opening a browser.
fn recording_manager() -> (Arc<AcpManager>, Receiver<AcpEvent>, Opened) {
    let (tx, rx) = mpsc::channel();
    let opened: Opened = Arc::default();
    let record = Arc::clone(&opened);
    let manager = AcpManager::with_url_opener(
        Box::new(move |event| {
            let _ = tx.send(event);
        }),
        Box::new(move |url| {
            record.lock().unwrap().push(url.to_string());
            Ok(())
        }),
    );
    (Arc::new(manager), rx, opened)
}

/// The key of the next elicitation shown for `app_id`.
fn next_key(rx: &Receiver<AcpEvent>, app_id: &str) -> String {
    match wait_for(rx, is_elicitation) {
        AcpEvent::Elicitation {
            session_id, key, ..
        } if session_id == app_id => key,
        other => panic!("unexpected event {other:?}"),
    }
}

/// Starts `s-1`, sends `prompt` and returns the key of the request it shows.
fn started_with(prompt: &str) -> (Arc<AcpManager>, Receiver<AcpEvent>, Opened, String) {
    let (manager, rx, opened) = recording_manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();
    manager.prompt("s-1", prompt, &[]).unwrap();
    let key = next_key(&rx, "s-1");
    (manager, rx, opened, key)
}

/// Waits up to two seconds for the fake agent to log `count` elicitation replies.
fn replies_logged(path: &std::path::Path, count: usize) -> Vec<Value> {
    let until = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        let replies: Vec<Value> = std::fs::read_to_string(path)
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).expect("a JSON reply"))
            .collect();
        if replies.len() >= count || std::time::Instant::now() >= until {
            return replies;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn sends_a_valid_form_to_the_agent() {
    let (manager, rx, _opened, key) = started_with("elicit-form");

    manager
        .respond_elicitation("s-1", &key, "accept", Some(json!({"name": "Ada"})))
        .expect("accept");

    assert_eq!(
        elicited(&rx),
        r#"elicited:{"action":"accept","content":{"name":"Ada"}}"#
    );
    manager.stop("s-1");
}

#[test]
fn keeps_an_invalid_form_open() {
    let (manager, rx, _opened, key) = started_with("elicit-form");

    let error = manager
        .respond_elicitation("s-1", &key, "accept", Some(json!({"name": "Adalovelace"})))
        .unwrap_err();

    let errors = error
        .strip_prefix(ELICITATION_INVALID_PREFIX)
        .unwrap_or_else(|| panic!("unexpected error {error}"));
    assert_eq!(
        serde_json::from_str::<Value>(errors).unwrap(),
        json!({"name": "Use at most 5 characters."})
    );
    assert!(!error.contains("Adalovelace"));
    let seen = events_within(&rx, Duration::from_millis(500));
    assert!(said_elicited(&seen).is_empty(), "{seen:?}");
    manager
        .respond_elicitation("s-1", &key, "accept", Some(json!({"name": "Ada"})))
        .expect("accept");
    assert_eq!(
        elicited(&rx),
        r#"elicited:{"action":"accept","content":{"name":"Ada"}}"#
    );
    manager.stop("s-1");
}

#[test]
fn declines_and_dismisses() {
    let (manager, rx, _opened, key) = started_with("elicit-form");
    manager
        .respond_elicitation("s-1", &key, "decline", None)
        .expect("decline");
    assert_eq!(elicited(&rx), r#"elicited:{"action":"decline"}"#);
    manager.stop("s-1");

    let (manager, rx, _opened) = recording_manager();
    let log = method_log("elicit-twice-replies");
    let launch = with_env(fake_agent(), "FAKE_ACP_ELICIT_LOG", log.to_str().unwrap());
    manager.start("s-1", &cwd(), &launch).unwrap();
    manager.prompt("s-1", "elicit-twice", &[]).unwrap();
    let first = next_key(&rx, "s-1");
    next_key(&rx, "s-1");

    manager
        .respond_elicitation("s-1", &first, "cancel", None)
        .expect("cancel");

    assert_eq!(elicited(&rx), r#"elicited:{"action":"cancel"}"#);
    let seen = events_within(&rx, Duration::from_millis(500));
    assert!(said_elicited(&seen).is_empty(), "{seen:?}");
    let replies = replies_logged(&log, 1);
    assert_eq!(replies.len(), 1, "{replies:?}");
    assert_eq!(replies[0]["id"], "elic-1");
    assert_eq!(replies[0]["result"], json!({"action": "cancel"}));
    manager.stop("s-1");
}

#[test]
fn refuses_an_unknown_answer() {
    let (manager, rx, _opened, key) = started_with("elicit-form");

    let error = manager
        .respond_elicitation("s-1", &key, "maybe", None)
        .unwrap_err();

    assert_eq!(error, "Unknown answer");
    manager
        .respond_elicitation("s-1", &key, "decline", None)
        .expect("still open");
    assert_eq!(elicited(&rx), r#"elicited:{"action":"decline"}"#);
    manager.stop("s-1");
}

#[test]
fn opens_the_backends_url_on_accept() {
    let (manager, rx, opened, key) = started_with("elicit-url");

    manager
        .respond_elicitation(
            "s-1",
            &key,
            "accept",
            Some(json!({"url": "https://evil.example"})),
        )
        .expect("accept");

    assert_eq!(
        *opened.lock().unwrap(),
        vec!["https://agent.example.com/connect".to_string()]
    );
    assert_eq!(elicited(&rx), r#"elicited:{"action":"accept"}"#);
    manager.stop("s-1");
}

#[test]
fn refuses_to_open_a_blocked_url() {
    let (manager, rx, opened, key) = started_with("elicit-blocked-url");

    let error = manager
        .respond_elicitation("s-1", &key, "accept", None)
        .unwrap_err();

    assert_eq!(error, "Zorvo opens only https links, or http on this Mac.");
    assert!(opened.lock().unwrap().is_empty());
    manager
        .respond_elicitation("s-1", &key, "decline", None)
        .expect("still open");
    assert_eq!(elicited(&rx), r#"elicited:{"action":"decline"}"#);
    manager.stop("s-1");
}

#[test]
fn does_not_answer_when_the_url_cannot_open() {
    let (tx, rx) = mpsc::channel();
    let can_open = Arc::new(AtomicBool::new(false));
    let browser = Arc::clone(&can_open);
    let manager = AcpManager::with_url_opener(
        Box::new(move |event| {
            let _ = tx.send(event);
        }),
        Box::new(move |_| {
            if browser.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("no browser".to_string())
            }
        }),
    );
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();
    manager.prompt("s-1", "elicit-url", &[]).unwrap();
    let key = next_key(&rx, "s-1");

    let error = manager
        .respond_elicitation("s-1", &key, "accept", None)
        .unwrap_err();

    assert_eq!(error, "no browser");
    let seen = events_within(&rx, Duration::from_millis(500));
    assert!(said_elicited(&seen).is_empty(), "{seen:?}");
    can_open.store(true, Ordering::SeqCst);
    manager
        .respond_elicitation("s-1", &key, "accept", None)
        .expect("accept");
    assert_eq!(elicited(&rx), r#"elicited:{"action":"accept"}"#);
    manager.stop("s-1");
}

#[test]
fn reopens_and_completes_a_url_request() {
    let (manager, rx, opened, key) = started_with("elicit-url");
    manager
        .respond_elicitation("s-1", &key, "accept", None)
        .expect("accept");
    events_through(&rx, |e| matches!(e, AcpEvent::TurnEnded { .. }));

    manager.reopen_elicitation_url("s-1", &key).expect("reopen");
    assert_eq!(opened.lock().unwrap().len(), 2);

    manager.prompt("s-1", "elicit-complete", &[]).unwrap();
    let seen = events_through(&rx, |e| matches!(e, AcpEvent::TurnEnded { .. }));
    let completed: Vec<&AcpEvent> = seen
        .iter()
        .filter(|e| matches!(e, AcpEvent::ElicitationComplete { .. }))
        .collect();
    assert_eq!(completed.len(), 1, "{seen:?}");
    assert!(
        matches!(completed[0], AcpEvent::ElicitationComplete { session_id, key: done } if session_id == "s-1" && *done == key)
    );
    assert_eq!(
        manager.reopen_elicitation_url("s-1", &key),
        Err(ELICITATION_GONE.to_string())
    );
    assert_eq!(opened.lock().unwrap().len(), 2);
    manager.stop("s-1");
}

#[test]
fn reopens_only_an_accepted_url_request() {
    let (manager, _rx, opened, key) = started_with("elicit-url");

    assert_eq!(
        manager.reopen_elicitation_url("s-1", &key),
        Err(ELICITATION_GONE.to_string())
    );
    assert_eq!(
        manager.reopen_elicitation_url("s-2", &key),
        Err(ELICITATION_GONE.to_string())
    );
    assert!(opened.lock().unwrap().is_empty());
    manager.stop("s-1");
}

#[test]
fn refuses_a_second_answer() {
    let (manager, rx, _opened, key) = started_with("elicit-form");
    manager
        .respond_elicitation("s-1", &key, "accept", Some(json!({"name": "Ada"})))
        .expect("accept");
    elicited(&rx);

    for action in ["accept", "decline"] {
        assert_eq!(
            manager.respond_elicitation("s-1", &key, action, Some(json!({"name": "Ada"}))),
            Err(ELICITATION_GONE.to_string())
        );
    }
    manager.stop("s-1");
}

#[test]
fn refuses_an_answer_from_another_session() {
    let (manager, rx, _opened, key) = started_with("elicit-form");
    manager.fork("s-1", "s-2", &cwd()).unwrap();

    assert_eq!(
        manager.respond_elicitation("s-2", &key, "decline", None),
        Err(ELICITATION_GONE.to_string())
    );
    manager
        .respond_elicitation("s-1", &key, "decline", None)
        .expect("still open for s-1");
    assert_eq!(elicited(&rx), r#"elicited:{"action":"decline"}"#);
    manager.stop("s-2");
    manager.stop("s-1");
}

#[test]
fn stop_answers_open_requests_with_cancel() {
    let (manager, rx, _opened, key) = started_with("elicit-form");

    manager.cancel("s-1").expect("cancel");

    let seen = events_through(&rx, |e| matches!(e, AcpEvent::TurnEnded { .. }));
    assert_eq!(
        said_elicited(&seen),
        vec![r#"{"action":"cancel"}"#],
        "{seen:?}"
    );
    assert_eq!(
        manager.respond_elicitation("s-1", &key, "decline", None),
        Err(ELICITATION_GONE.to_string())
    );
    manager.stop("s-1");
}

#[test]
fn cancel_keeps_an_accepted_url_request() {
    let (manager, rx, opened, key) = started_with("elicit-url");
    manager
        .respond_elicitation("s-1", &key, "accept", None)
        .expect("accept");
    events_through(&rx, |e| matches!(e, AcpEvent::TurnEnded { .. }));

    manager.cancel("s-1").expect("cancel");

    manager
        .reopen_elicitation_url("s-1", &key)
        .expect("still awaiting completion");
    assert_eq!(opened.lock().unwrap().len(), 2);
    manager.stop("s-1");
}

#[test]
fn stop_answers_open_requests_with_cancel_too() {
    // The fork shares s-1's agent, so stopping it leaves the agent running.
    let (manager, rx, _opened) = recording_manager();
    let log = method_log("elicit-stop-fork");
    let launch = with_env(fake_agent(), "FAKE_ACP_ELICIT_LOG", log.to_str().unwrap());
    manager.start("s-1", &cwd(), &launch).unwrap();
    manager.fork("s-1", "s-2", &cwd()).unwrap();
    manager.prompt("s-2", "elicit-form", &[]).unwrap();
    next_key(&rx, "s-2");

    manager.stop("s-2");

    let replies = replies_logged(&log, 1);
    assert_eq!(replies.len(), 1, "{replies:?}");
    assert_eq!(replies[0]["result"], json!({"action": "cancel"}));
    manager.prompt("s-1", "hi", &[]).unwrap();
    let chunk = wait_for(&rx, |e| agent_text(e).is_some());
    assert_eq!(agent_text(&chunk).as_deref(), Some("echo: hi"));
    manager.stop("s-1");
}

#[test]
fn cancels_a_request_for_an_unknown_session_on_a_routed_connection() {
    let (manager, rx) = manager();
    manager.start("s-1", &cwd(), &fake_agent()).unwrap();

    manager.prompt("s-1", "stray-elicit", &[]).unwrap();

    let seen = events_through(&rx, |e| matches!(e, AcpEvent::TurnEnded { .. }));
    assert_eq!(
        said_elicited(&seen),
        vec![r#"{"action":"cancel"}"#],
        "{seen:?}"
    );
    assert!(!seen.iter().any(is_elicitation), "{seen:?}");
    manager.stop("s-1");
}

#[test]
fn answers_a_request_sent_while_the_session_opens() {
    let (manager, rx, _opened) = recording_manager();
    let log = method_log("elicit-on-new-answer");
    let launch = with_env(
        fake_agent(),
        "FAKE_ACP_ELICIT_ON_NEW",
        log.to_str().unwrap(),
    );
    let starting = {
        let manager = Arc::clone(&manager);
        std::thread::spawn(move || manager.start("s-1", &cwd(), &launch))
    };

    let key = next_key(&rx, "s-1");
    manager
        .respond_elicitation("s-1", &key, "accept", Some(json!({"name": "Ada"})))
        .expect("accept");

    let started = starting.join().unwrap().expect("start");
    assert_eq!(started.acp_session_id, "fake-1");
    let reply: Value =
        serde_json::from_str(std::fs::read_to_string(&log).expect("reply").trim()).unwrap();
    assert_eq!(
        reply["result"],
        json!({"action": "accept", "content": {"name": "Ada"}})
    );
    manager.stop("s-1");
}

#[test]
fn drops_requests_when_the_session_stops() {
    let (manager, _rx, _opened, key) = started_with("elicit-form");

    manager.stop("s-1");

    assert_eq!(
        manager.respond_elicitation("s-1", &key, "decline", None),
        Err(ELICITATION_GONE.to_string())
    );
}
