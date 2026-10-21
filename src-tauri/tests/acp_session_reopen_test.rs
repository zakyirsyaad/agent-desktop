//! Reopening an agent's earlier session: the backend picks `session/resume`
//! when the agent offers it and `session/load` when it does not, and refuses
//! when it offers neither.

mod common;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use common::{agent_text, called_methods, cwd, fake_agent, fake_agent_with, manager, wait_for};
use zorvo_lib::acp::manager::{AcpEvent, ReopenMethod, ReopenPurpose};

/// A fresh file the fake agent records the methods it was called with in.
/// Named per test, since the tests of this file run in parallel.
fn call_log(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("zorvo-reopen-{name}-{}.log", std::process::id()));
    let _ = std::fs::remove_file(&path);
    path
}

/// The text of any message chunk, user or agent, for any other event `None`.
fn chunk_text(event: &AcpEvent) -> Option<String> {
    match event {
        AcpEvent::Update { update, .. }
            if matches!(
                update["sessionUpdate"].as_str(),
                Some("user_message_chunk") | Some("agent_message_chunk")
            ) =>
        {
            update["content"]["text"].as_str().map(str::to_string)
        }
        _ => None,
    }
}

/// The events that arrive until `window` passes or the channel goes quiet.
fn events_within(rx: &Receiver<AcpEvent>, window: Duration) -> Vec<AcpEvent> {
    let deadline = Instant::now() + window;
    let mut events = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return events;
        }
        match rx.recv_timeout(left) {
            Ok(event) => events.push(event),
            Err(_) => return events,
        }
    }
}

/// The replies the fake agent got to the requests it sent while a session
/// opened, from the file `FAKE_ACP_EARLY_REQUESTS` named, by request id.
fn early_replies(path: &Path) -> HashMap<String, Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("a JSON reply"))
        .map(|reply| (reply["id"].as_str().unwrap_or_default().to_string(), reply))
        .collect()
}

#[test]
fn continues_with_resume_when_offered() {
    let (manager, rx) = manager();
    let log = call_log("resume");
    let launch = fake_agent_with(&[
        ("FAKE_ACP_RESUME", "1"),
        ("FAKE_ACP_CALL_LOG", log.to_str().unwrap()),
    ]);

    let reopened = manager
        .reopen(
            "s-resume",
            &cwd(),
            &launch,
            "fake-earlier",
            ReopenPurpose::Continue,
        )
        .expect("reopen");

    assert_eq!(reopened.reopened_with, Some(ReopenMethod::Resume));
    assert_eq!(reopened.acp_session_id, "fake-earlier");
    assert_eq!(reopened.modes["currentModeId"], "default");
    let methods = called_methods(&log);
    assert!(
        methods.contains(&"session/resume".to_string()),
        "no resume in {methods:?}"
    );
    assert!(
        !methods.contains(&"session/load".to_string()),
        "load was called too: {methods:?}"
    );

    // The reopened session works, and nothing was replayed into it first.
    manager.prompt("s-resume", "hi again", &[]).unwrap();
    let first_text = wait_for(&rx, |e| agent_text(e).is_some());
    assert_eq!(agent_text(&first_text).as_deref(), Some("echo: hi again"));
    manager.stop("s-resume");
}

#[test]
fn continues_with_load_and_drops_the_replay() {
    let (manager, rx) = manager();
    let log = call_log("load");
    let launch = fake_agent_with(&[("FAKE_ACP_CALL_LOG", log.to_str().unwrap())]);

    let reopened = manager
        .reopen(
            "s-load",
            &cwd(),
            &launch,
            "fake-earlier",
            ReopenPurpose::Continue,
        )
        .expect("reopen");

    assert_eq!(reopened.reopened_with, Some(ReopenMethod::Load));
    assert!(
        called_methods(&log).contains(&"session/load".to_string()),
        "{:?}",
        called_methods(&log)
    );
    // The agent replayed the old conversation before answering; the app
    // already has it, so none of it was routed.
    let replayed: Vec<AcpEvent> = rx.try_iter().collect();
    assert!(
        replayed.is_empty(),
        "the replay reached the app: {replayed:?}"
    );

    manager.prompt("s-load", "hi again", &[]).unwrap();
    let first_text = wait_for(&rx, |e| agent_text(e).is_some());
    assert_eq!(agent_text(&first_text).as_deref(), Some("echo: hi again"));
    manager.stop("s-load");
}

#[test]
fn refuses_to_continue_without_resume_or_load() {
    let (manager, _rx) = manager();
    let launch = fake_agent_with(&[("FAKE_ACP_NO_LOAD", "1")]);

    let error = manager
        .reopen(
            "s-neither",
            &cwd(),
            &launch,
            "fake-earlier",
            ReopenPurpose::Continue,
        )
        .unwrap_err();

    assert!(error.contains("cannot resume"), "unexpected error: {error}");
}

#[test]
fn import_routes_the_replay_to_the_app_session() {
    let (manager, rx) = manager();

    let reopened = manager
        .reopen(
            "s-imp",
            &cwd(),
            &fake_agent(),
            "fake-earlier",
            ReopenPurpose::Import,
        )
        .expect("import");

    assert_eq!(reopened.reopened_with, Some(ReopenMethod::Load));
    // The agent replayed the conversation before answering. It belongs to the
    // app session, with the user's turn before the agent's.
    let replay: Vec<(String, String)> = rx
        .try_iter()
        .filter_map(|event| match event {
            AcpEvent::Update { session_id, update } if session_id == "s-imp" => Some((
                update["sessionUpdate"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
                update["content"]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            )),
            _ => None,
        })
        .collect();
    assert_eq!(
        replay,
        vec![
            (
                "user_message_chunk".to_string(),
                "earlier question".to_string()
            ),
            (
                "agent_message_chunk".to_string(),
                "replayed history".to_string()
            ),
        ]
    );
    manager.stop("s-imp");
}

#[test]
fn import_answers_requests_sent_during_the_replay() {
    let (manager, rx) = manager();
    let log = call_log("import-early-requests");
    let launch = fake_agent_with(&[("FAKE_ACP_EARLY_REQUESTS", log.to_str().unwrap())]);

    let started = Instant::now();
    let reopened = manager
        .reopen(
            "s-imp-early",
            &cwd(),
            &launch,
            "fake-earlier",
            ReopenPurpose::Import,
        )
        .expect("the import must not wait on requests sent during the replay");
    let elapsed = started.elapsed();

    assert_eq!(reopened.reopened_with, Some(ReopenMethod::Load));
    // The fake agent gives up on its requests after twenty seconds.
    assert!(
        elapsed < Duration::from_secs(10),
        "the import took {elapsed:?}"
    );
    let replies = early_replies(&log);
    assert_eq!(replies["early-fs"]["error"]["code"], -32601);
    assert_eq!(
        replies["early-permission"]["result"]["outcome"]["outcome"],
        "cancelled"
    );
    // The permission request was answered as during any open, not shown as a
    // card the app session could not answer before it is registered.
    assert!(
        rx.try_iter()
            .all(|event| !matches!(event, AcpEvent::PermissionRequest { .. })),
        "a request during the replay reached the app"
    );
    manager.stop("s-imp-early");
}

#[test]
fn stopping_an_import_mid_replay_drops_the_rest() {
    let (manager, rx) = manager();
    let launch = fake_agent_with(&[("FAKE_ACP_SLOW_REPLAY", "1")]);
    let importing = {
        let manager = std::sync::Arc::clone(&manager);
        let cwd = cwd();
        thread::spawn(move || {
            manager.reopen(
                "s-imp",
                &cwd,
                &launch,
                "fake-earlier",
                ReopenPurpose::Import,
            )
        })
    };

    let first = wait_for(&rx, |event| {
        matches!(event, AcpEvent::Update { session_id, update }
            if session_id == "s-imp" && update["sessionUpdate"] == "user_message_chunk")
    });
    assert_eq!(chunk_text(&first).as_deref(), Some("earlier question"));
    assert!(!importing.is_finished(), "the replay already finished");
    manager.stop("s-imp");

    // The fake agent sends "late history" three seconds in and answers only
    // after it, so a completed import proves that chunk was sent.
    let reopened = importing
        .join()
        .expect("the import thread")
        .expect("the import answers");
    assert_eq!(reopened.reopened_with, Some(ReopenMethod::Load));
    // `route_on_answer` skipped the stopped session's early route, but
    // `register` still registers it once the load answers: stop it once more.
    manager.stop("s-imp");

    let late: Vec<AcpEvent> = events_within(&rx, Duration::from_secs(4))
        .into_iter()
        .filter(|event| chunk_text(event).as_deref() == Some("late history"))
        .collect();
    assert!(late.is_empty(), "the stopped import still routed {late:?}");

    manager
        .reopen(
            "s-imp2",
            &cwd(),
            &fake_agent(),
            "fake-earlier",
            ReopenPurpose::Import,
        )
        .expect("a new import still works");
    manager.stop("s-imp2");
}

#[test]
fn does_not_route_a_replay_after_the_import_was_stopped() {
    let (manager, rx) = manager();
    let log = call_log("import-stopped-opening");
    let launch = fake_agent_with(&[
        ("FAKE_ACP_SLOW_INIT", "1500"),
        ("FAKE_ACP_CALL_LOG", log.to_str().unwrap()),
    ]);
    let importing = {
        let manager = std::sync::Arc::clone(&manager);
        let cwd = cwd();
        thread::spawn(move || {
            manager.reopen(
                "s-imp-stop",
                &cwd,
                &launch,
                "fake-earlier",
                ReopenPurpose::Import,
            )
        })
    };

    // The stop lands between `initialize` and the replay route: the import is
    // still waiting for the fake agent's slow initialize to answer.
    let deadline = Instant::now() + Duration::from_secs(5);
    while !called_methods(&log).contains(&"initialize".to_string()) {
        assert!(Instant::now() < deadline, "initialize was never sent");
        thread::sleep(Duration::from_millis(10));
    }
    manager.stop("s-imp-stop");

    let reopened = importing
        .join()
        .expect("the import thread")
        .expect("the import answers");
    assert_eq!(reopened.reopened_with, Some(ReopenMethod::Load));
    // `route_on_answer` skipped the stopped session's early route, but
    // `register` still registers it once the load answers: stop it once more.
    manager.stop("s-imp-stop");

    // The history the agent replayed during the load had nowhere to go: the
    // route was never installed for the session stopped while it opened.
    let routed: Vec<AcpEvent> = events_within(&rx, Duration::from_secs(3))
        .into_iter()
        .filter(
            |event| matches!(event, AcpEvent::Update { session_id, .. } if session_id == "s-imp-stop"),
        )
        .collect();
    assert!(
        routed.is_empty(),
        "the stopped import still routed {routed:?}"
    );
}

#[test]
fn import_with_only_resume_has_no_replay() {
    let (manager, rx) = manager();
    let log = call_log("import-resume");
    let launch = fake_agent_with(&[
        ("FAKE_ACP_RESUME", "1"),
        ("FAKE_ACP_NO_LOAD", "1"),
        ("FAKE_ACP_CALL_LOG", log.to_str().unwrap()),
    ]);

    let reopened = manager
        .reopen(
            "s-imp-resume",
            &cwd(),
            &launch,
            "fake-earlier",
            ReopenPurpose::Import,
        )
        .expect("import");

    assert_eq!(reopened.reopened_with, Some(ReopenMethod::Resume));
    let methods = called_methods(&log);
    assert!(
        methods.contains(&"session/resume".to_string()),
        "no resume in {methods:?}"
    );
    assert!(
        !methods.contains(&"session/load".to_string()),
        "load was called too: {methods:?}"
    );
    let updates: Vec<AcpEvent> = events_within(&rx, Duration::from_secs(1))
        .into_iter()
        .filter(|event| matches!(event, AcpEvent::Update { session_id, .. } if session_id == "s-imp-resume"))
        .collect();
    assert!(updates.is_empty(), "a resume replayed {updates:?}");
    manager.stop("s-imp-resume");
}
