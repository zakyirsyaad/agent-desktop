//! Listing an agent's sessions for a folder: every page is followed, the caps
//! stop it, and entries the app must not see are dropped.

mod common;

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{json, Value};

use common::{called_methods, cwd, fake_agent, fake_agent_with, manager};
use zorvo_lib::acp::manager::{AcpLaunch, AUTH_REQUIRED_PREFIX};
use zorvo_lib::acp::session_list::MAX_LISTED_SESSIONS;

/// A temp file with one test's pages, removed on drop. Named per test, since
/// the tests of this file run in parallel.
struct PagesFile {
    path: PathBuf,
}

impl PagesFile {
    fn new(name: &str, pages: Value) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let unique = NEXT.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!(
            "zorvo-list-pages-{name}-{}-{unique}.json",
            std::process::id()
        ));
        std::fs::write(&path, pages.to_string()).expect("write the pages");
        Self { path }
    }

    fn path(&self) -> &str {
        self.path.to_str().expect("a UTF-8 path")
    }
}

impl Drop for PagesFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// The fake agent, advertising `session/list` and serving `pages`.
fn listing_agent(pages: &PagesFile) -> AcpLaunch {
    fake_agent_with(&[
        ("FAKE_ACP_LIST", "1"),
        ("FAKE_ACP_LIST_PAGES", pages.path()),
    ])
}

/// A `SessionInfo` for `id` in `cwd`.
fn session(id: &str, cwd: &str) -> Value {
    json!({
        "sessionId": id,
        "cwd": cwd,
        "title": format!("title {id}"),
        "updatedAt": "2026-10-20T08:00:00Z",
    })
}

/// The ids of `listed`, in order.
fn ids(listed: &zorvo_lib::acp::session_list::ListedSessions) -> Vec<&str> {
    listed
        .sessions
        .iter()
        .map(|session| session.acp_session_id.as_str())
        .collect()
}

#[test]
fn follows_every_page() {
    let cwd = cwd();
    let pages = PagesFile::new(
        "follows",
        json!([
            [session("p0-a", &cwd), session("p0-b", &cwd)],
            [session("p1-a", &cwd), session("p1-b", &cwd)],
            [session("p2-a", &cwd), session("p2-b", &cwd)],
        ]),
    );
    let (manager, _rx) = manager();

    let listed = manager
        .list_sessions(&cwd, &listing_agent(&pages))
        .expect("list the sessions");

    assert_eq!(
        ids(&listed),
        ["p0-a", "p0-b", "p1-a", "p1-b", "p2-a", "p2-b"]
    );
    assert!(!listed.truncated);
    assert!(!listed.incomplete);
    assert_eq!(listed.sessions[0].title.as_deref(), Some("title p0-a"));
    assert_eq!(
        listed.sessions[0].updated_at.as_deref(),
        Some("2026-10-20T08:00:00Z")
    );
}

#[test]
fn stops_at_the_page_cap() {
    let cwd = cwd();
    let pages: Vec<Value> = (0..11)
        .map(|page| json!([session(&format!("s-{page}"), &cwd)]))
        .collect();
    let pages = PagesFile::new("page-cap", Value::Array(pages));
    let (manager, _rx) = manager();

    let listed = manager
        .list_sessions(&cwd, &listing_agent(&pages))
        .expect("list the sessions");

    assert_eq!(
        ids(&listed),
        ["s-0", "s-1", "s-2", "s-3", "s-4", "s-5", "s-6", "s-7", "s-8", "s-9"]
    );
    assert!(listed.truncated);
    assert!(!listed.incomplete);
}

#[test]
fn stops_at_the_session_cap() {
    let cwd = cwd();
    let pages: Vec<Value> = (0..3)
        .map(|page| {
            Value::Array(
                (0..100)
                    .map(|index| session(&format!("s-{page}-{index}"), &cwd))
                    .collect(),
            )
        })
        .collect();
    let pages = PagesFile::new("session-cap", Value::Array(pages));
    let log =
        std::env::temp_dir().join(format!("zorvo-list-session-cap-{}.log", std::process::id()));
    let _ = std::fs::remove_file(&log);
    let launch = fake_agent_with(&[
        ("FAKE_ACP_LIST", "1"),
        ("FAKE_ACP_LIST_PAGES", pages.path()),
        ("FAKE_ACP_CALL_LOG", log.to_str().unwrap()),
    ]);
    let (manager, _rx) = manager();

    let listed = manager
        .list_sessions(&cwd, &launch)
        .expect("list the sessions");

    assert_eq!(listed.sessions.len(), MAX_LISTED_SESSIONS);
    assert!(listed.truncated);
    assert!(!listed.incomplete);
    assert_eq!(listed.sessions[0].acp_session_id, "s-0-0");
    assert_eq!(listed.sessions[199].acp_session_id, "s-1-99");
    let calls = called_methods(&log)
        .iter()
        .filter(|method| method.as_str() == "session/list")
        .count();
    assert_eq!(calls, 2, "pages asked: {:?}", called_methods(&log));
    let _ = std::fs::remove_file(&log);
}

#[test]
fn keeps_earlier_pages_when_a_later_one_fails() {
    let cwd = cwd();
    let pages = PagesFile::new(
        "later-fails",
        json!([
            [session("kept-a", &cwd), session("kept-b", &cwd)],
            [session("gone", &cwd)],
        ]),
    );
    let launch = fake_agent_with(&[
        ("FAKE_ACP_LIST", "1"),
        ("FAKE_ACP_LIST_PAGES", pages.path()),
        ("FAKE_ACP_LIST_FAIL_AT", "1"),
    ]);
    let (manager, _rx) = manager();

    let listed = manager
        .list_sessions(&cwd, &launch)
        .expect("the earlier pages are kept");

    assert_eq!(ids(&listed), ["kept-a", "kept-b"]);
    assert!(!listed.truncated);
    assert!(listed.incomplete);
}

#[test]
fn fails_when_the_first_page_fails() {
    let cwd = cwd();
    let pages = PagesFile::new("first-fails", json!([[session("gone", &cwd)]]));
    let launch = fake_agent_with(&[
        ("FAKE_ACP_LIST", "1"),
        ("FAKE_ACP_LIST_PAGES", pages.path()),
        ("FAKE_ACP_LIST_FAIL_AT", "0"),
    ]);
    let (manager, _rx) = manager();

    let error = manager
        .list_sessions(&cwd, &launch)
        .expect_err("the first page failed");

    assert!(error.contains("session/list failed"), "unexpected: {error}");
}

#[test]
fn refuses_an_agent_without_list() {
    let cwd = cwd();
    let (manager, _rx) = manager();

    let error = manager.list_sessions(&cwd, &fake_agent()).unwrap_err();

    assert_eq!(error, "This agent cannot list its sessions");
}

#[test]
fn reports_a_needed_sign_in() {
    let cwd = cwd();
    let pages = PagesFile::new("auth", json!([[session("s", &cwd)]]));
    let launch = fake_agent_with(&[
        ("FAKE_ACP_LIST", "1"),
        ("FAKE_ACP_LIST_PAGES", pages.path()),
        ("FAKE_ACP_AUTH_REQUIRED", "1"),
    ]);
    let (manager, _rx) = manager();

    let error = manager.list_sessions(&cwd, &launch).unwrap_err();

    assert!(
        error.starts_with(AUTH_REQUIRED_PREFIX),
        "unexpected: {error}"
    );
    let methods = error
        .strip_prefix(AUTH_REQUIRED_PREFIX)
        .expect("the prefix");
    let methods: Value = serde_json::from_str(methods).expect("the auth methods as JSON");
    assert_eq!(methods[0]["id"], "browser");
}

#[test]
fn drops_duplicates_and_other_folders() {
    let cwd = cwd();
    let pages = PagesFile::new(
        "duplicates",
        json!([
            [session("same", &cwd)],
            [
                session("same", &cwd),
                json!({ "sessionId": "other", "cwd": "/elsewhere" }),
            ],
        ]),
    );
    let (manager, _rx) = manager();

    let listed = manager
        .list_sessions(&cwd, &listing_agent(&pages))
        .expect("list the sessions");

    assert_eq!(ids(&listed), ["same"]);
    assert_eq!(listed.sessions[0].title.as_deref(), Some("title same"));
}
