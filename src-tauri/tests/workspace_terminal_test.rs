use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;
use zorvo_lib::pty_session::{PtyEvent, PtySessionManager};
use zorvo_lib::workspace_terminal::{
    close, event_payload, is_workspace_terminal_id, next_terminal_id, pty_event_route, shell_from,
    start_shell, EVENT,
};

const WAIT: Duration = Duration::from_secs(5);

fn env_with_shell(value: &str) -> HashMap<String, String> {
    HashMap::from([("SHELL".to_string(), value.to_string())])
}

#[test]
fn ids_carry_the_shell_prefix_and_never_repeat() {
    let ids: Vec<String> = (0..100).map(|_| next_terminal_id()).collect();

    assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 100);
    assert!(ids.iter().all(|id| is_workspace_terminal_id(id)), "{ids:?}");
}

#[test]
fn only_shell_ids_are_workspace_terminals() {
    let too_long = format!("shell-{}", "1".repeat(21));
    for bad in ["signin-1", "shell-", "shell-1; rm", "1", too_long.as_str()] {
        assert!(!is_workspace_terminal_id(bad), "{bad}");
    }
    assert!(is_workspace_terminal_id("shell-0"));
    assert!(is_workspace_terminal_id(&format!(
        "shell-{}",
        "9".repeat(20)
    )));
}

#[test]
fn shell_comes_from_the_login_environment() {
    assert_eq!(shell_from(&env_with_shell("/bin/sh")), "/bin/sh");
    assert_eq!(shell_from(&HashMap::new()), "/bin/zsh");
    assert_eq!(shell_from(&env_with_shell("sh")), "/bin/zsh");
    assert_eq!(shell_from(&env_with_shell("/etc/hosts")), "/bin/zsh");
}

fn unique_dir(name: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let parent = std::env::temp_dir().join(format!("zorvo-shell-{}-{nanos}", std::process::id()));
    let dir = parent.join(name);
    fs::create_dir_all(&dir).expect("create dir");
    dir
}

#[test]
fn a_shell_starts_in_its_folder() {
    let dir = unique_dir("work space");
    let canonical = dir.canonicalize().expect("canonical");
    let (tx, rx) = mpsc::channel();
    let manager = PtySessionManager::new(Box::new(move |event| {
        let _ = tx.send(event);
    }));
    let id = next_terminal_id();

    start_shell(&manager, &id, &canonical, "/bin/sh").expect("start");
    manager.write_stdin(&id, "pwd\n").expect("write");

    let wanted = canonical.to_string_lossy().to_string();
    let mut output = String::new();
    let started = Instant::now();
    while started.elapsed() < WAIT && !output.contains(&wanted) {
        if let Ok(PtyEvent::Output { data, .. }) = rx.recv_timeout(Duration::from_millis(100)) {
            output.push_str(&data);
        }
    }
    let _ = manager.kill_session(&id);

    assert!(output.contains(&wanted), "output was {output:?}");
}

#[test]
fn closing_a_shell_that_already_exited_succeeds() {
    let dir = unique_dir("exits");
    let (tx, rx) = mpsc::channel();
    let manager = PtySessionManager::new(Box::new(move |event| {
        let _ = tx.send(event);
    }));
    let id = next_terminal_id();

    start_shell(&manager, &id, &dir, "/bin/sh").expect("start");
    manager.write_stdin(&id, "exit\n").expect("write");

    let started = Instant::now();
    let mut exited = false;
    while started.elapsed() < WAIT && !exited {
        exited = matches!(
            rx.recv_timeout(Duration::from_millis(100)),
            Ok(PtyEvent::Exit { .. })
        );
    }
    assert!(exited, "the shell did not exit");
    // The reader thread removes the session right after it sends the exit.
    let started = Instant::now();
    while started.elapsed() < WAIT && manager.has_session(&id) {
        std::thread::sleep(Duration::from_millis(10));
    }

    assert_eq!(close(&manager, &id), Ok(()));
}

#[test]
fn closing_a_running_shell_ends_it() {
    let dir = unique_dir("running");
    let manager = PtySessionManager::default_manager();
    let id = next_terminal_id();

    start_shell(&manager, &id, &dir, "/bin/sh").expect("start");
    assert!(manager.has_session(&id));

    assert_eq!(close(&manager, &id), Ok(()));
    assert!(!manager.has_session(&id));
}

#[test]
fn close_refuses_ids_it_did_not_make() {
    let manager = PtySessionManager::default_manager();

    assert!(close(&manager, "signin-1").is_err());
}

#[test]
fn pty_events_go_to_their_own_channel() {
    assert_eq!(pty_event_route("shell-3"), Some("workspace-terminal"));
    assert_eq!(pty_event_route("shell-3"), Some(EVENT));
    assert_eq!(pty_event_route("signin-abc"), Some("sign-in-terminal"));
    assert_eq!(pty_event_route("other"), None);
}

#[test]
fn events_carry_the_terminal_id() {
    let output = PtyEvent::Output {
        session_id: "shell-7".to_string(),
        data: "hi".to_string(),
    };
    let exit = PtyEvent::Exit {
        session_id: "shell-7".to_string(),
        exit_code: 3,
    };

    assert_eq!(
        event_payload(&output),
        json!({ "terminalId": "shell-7", "kind": "output", "data": "hi" })
    );
    assert_eq!(
        event_payload(&exit),
        json!({ "terminalId": "shell-7", "kind": "exit", "exitCode": 3 })
    );
}
