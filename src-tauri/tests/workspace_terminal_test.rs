use std::collections::{HashMap, HashSet};
use std::fs;
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::json;
use zorvo_lib::acp::terminal_auth::SIGN_IN_TERMINAL_EVENT;
#[cfg(target_os = "macos")]
use zorvo_lib::background_processes::{read_processes, subtree_of};
use zorvo_lib::pty_session::{PtyEvent, PtySessionManager};
use zorvo_lib::workspace_terminal::{
    close, end_all, end_all_sessions, event_payload, is_workspace_terminal_id, next_terminal_id,
    pty_event_route, shell_from, start_shell, PtyRoute, EVENT,
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
    assert_eq!(pty_event_route("shell-3"), Some(PtyRoute::Workspace));
    assert_eq!(pty_event_route("signin-abc"), Some(PtyRoute::SignIn));
    assert_eq!(pty_event_route("other"), None);
    // The channels themselves do not change.
    assert_eq!(EVENT, "workspace-terminal");
    assert_eq!(SIGN_IN_TERMINAL_EVENT, "sign-in-terminal");
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

/// Starts `/bin/sh` in `dir` and runs a `nohup`ed sleep in it, which ignores
/// the SIGHUP that ending the shell sends. Returns the shell's pid and the
/// sleep's pid, once a fresh `ps` read shows the sleep under the shell.
#[cfg(target_os = "macos")]
fn shell_with_nohup_job(
    manager: &PtySessionManager,
    id: &str,
    dir: &std::path::Path,
) -> (u32, u32) {
    start_shell(manager, id, dir, "/bin/sh").expect("start");
    let shell_pid = manager.pid_of(id).expect("a running shell has a pid");
    manager
        .write_stdin(id, "nohup sleep 300 >/dev/null 2>&1 &\n")
        .expect("write");

    let started = Instant::now();
    while started.elapsed() < WAIT {
        let rows = read_processes().expect("list processes");
        let job = subtree_of(&rows, shell_pid).into_iter().find(|pid| {
            rows.iter()
                .any(|row| row.pid == *pid && row.command.starts_with("sleep 300"))
        });
        if let Some(job) = job {
            return (shell_pid, job);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    panic!("the nohup job did not start under the shell");
}

/// Whether `pid` is gone from a fresh `ps` read within `WAIT`.
#[cfg(target_os = "macos")]
fn gone_within_wait(pid: u32) -> bool {
    let started = Instant::now();
    while started.elapsed() < WAIT {
        if !read_processes()
            .expect("list processes")
            .iter()
            .any(|row| row.pid == pid)
        {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

#[cfg(target_os = "macos")]
#[test]
fn closing_a_shell_ends_what_it_started() {
    let dir = unique_dir("nohup close");
    let manager = PtySessionManager::default_manager();
    let id = next_terminal_id();
    let (_shell_pid, job_pid) = shell_with_nohup_job(&manager, &id, &dir);

    assert_eq!(close(&manager, &id), Ok(()));

    assert!(!manager.has_session(&id));
    assert!(
        gone_within_wait(job_pid),
        "the nohup job outlived its shell"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn end_all_ends_every_shell_and_what_it_started_but_not_other_sessions() {
    let dir = unique_dir("nohup quit");
    let manager = PtySessionManager::default_manager();
    let id = next_terminal_id();
    let (_shell_pid, job_pid) = shell_with_nohup_job(&manager, &id, &dir);
    let cwd = dir.to_string_lossy().to_string();
    manager
        .start_session("signin-probe", &cwd, "/bin/cat", &[], &[])
        .expect("start a sign-in style session");

    end_all(&manager);

    assert!(!manager.has_session(&id));
    assert!(gone_within_wait(job_pid), "the nohup job outlived Zorvo");
    assert!(manager.has_session("signin-probe"));
    manager.kill_all();
}

#[cfg(target_os = "macos")]
#[test]
fn end_all_sessions_ends_a_shells_jobs_and_every_other_session() {
    let dir = unique_dir("nohup reload");
    let manager = PtySessionManager::default_manager();
    let id = next_terminal_id();
    let (_shell_pid, job_pid) = shell_with_nohup_job(&manager, &id, &dir);
    let cwd = dir.to_string_lossy().to_string();
    manager
        .start_session("signin-probe", &cwd, "/bin/cat", &[], &[])
        .expect("start a sign-in style session");

    assert_eq!(end_all_sessions(&manager), 2);

    assert!(!manager.has_session(&id));
    assert!(!manager.has_session("signin-probe"));
    assert!(
        gone_within_wait(job_pid),
        "the nohup job outlived the reload"
    );
}
