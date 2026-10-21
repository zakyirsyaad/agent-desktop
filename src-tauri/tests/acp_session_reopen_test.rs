//! Reopening an agent's earlier session: the backend picks `session/resume`
//! when the agent offers it and `session/load` when it does not, and refuses
//! when it offers neither.

mod common;

use std::path::PathBuf;

use common::{agent_text, called_methods, cwd, fake_agent_with, manager, wait_for};
use zorvo_lib::acp::manager::{AcpEvent, ReopenMethod, ReopenPurpose};

/// A fresh file the fake agent records the methods it was called with in.
/// Named per test, since the tests of this file run in parallel.
fn call_log(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("zorvo-reopen-{name}-{}.log", std::process::id()));
    let _ = std::fs::remove_file(&path);
    path
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
