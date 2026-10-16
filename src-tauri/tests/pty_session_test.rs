use agent_desktop_lib::pty_session::{PtyEvent, PtySessionManager};
use std::sync::mpsc;
use std::time::Duration;

#[test]
fn test_pty_session_echo_agent_ready() {
    let (tx, rx) = mpsc::channel();
    let manager = PtySessionManager::new(Box::new(move |event| {
        let _ = tx.send(event);
    }));

    let session_id = "test-echo-1";
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string();

    let res = manager.start_session(
        session_id,
        &cwd,
        "/bin/sh",
        &["-c".to_string(), "echo AGENT_READY".to_string()],
        &[],
    );
    assert!(res.is_ok(), "Failed to start session: {:?}", res.err());

    let mut accumulated = String::new();
    let mut exit_received = false;
    let timeout = Duration::from_secs(5);
    let start = std::time::Instant::now();

    while start.elapsed() < timeout {
        if let Ok(event) = rx.recv_timeout(Duration::from_millis(100)) {
            match event {
                PtyEvent::Output {
                    session_id: sid,
                    data,
                } => {
                    if sid == session_id {
                        accumulated.push_str(&data);
                    }
                }
                PtyEvent::Exit {
                    session_id: sid,
                    exit_code,
                } => {
                    if sid == session_id {
                        assert_eq!(exit_code, 0);
                        exit_received = true;
                        break;
                    }
                }
            }
        }
    }

    assert!(
        accumulated.contains("AGENT_READY"),
        "Expected output to contain 'AGENT_READY', got: {:?}",
        accumulated
    );
    assert!(exit_received, "Expected to receive exit event");
}

#[test]
fn test_pty_session_stdin_cat_echo() {
    let (tx, rx) = mpsc::channel();
    let manager = PtySessionManager::new(Box::new(move |event| {
        let _ = tx.send(event);
    }));

    let session_id = "test-cat-1";
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string();

    let res = manager.start_session(session_id, &cwd, "/bin/cat", &[], &[]);
    assert!(res.is_ok(), "Failed to start cat session: {:?}", res.err());

    // Give cat process a brief moment to initialize
    std::thread::sleep(Duration::from_millis(50));

    let write_res = manager.write_stdin(session_id, "hello from pty\n");
    assert!(
        write_res.is_ok(),
        "Failed to write stdin: {:?}",
        write_res.err()
    );

    let mut accumulated = String::new();
    let timeout = Duration::from_secs(5);
    let start = std::time::Instant::now();

    while start.elapsed() < timeout {
        if let Ok(PtyEvent::Output {
            session_id: sid,
            data,
        }) = rx.recv_timeout(Duration::from_millis(100))
        {
            if sid == session_id {
                accumulated.push_str(&data);
                if accumulated.contains("hello from pty") {
                    break;
                }
            }
        }
    }

    assert!(
        accumulated.contains("hello from pty"),
        "Expected cat to echo 'hello from pty', got: {:?}",
        accumulated
    );

    // Test resize
    let resize_res = manager.resize(session_id, 120, 40);
    assert!(resize_res.is_ok(), "Resize failed: {:?}", resize_res.err());

    // Test kill_session
    let kill_res = manager.kill_session(session_id);
    assert!(
        kill_res.is_ok(),
        "Kill session failed: {:?}",
        kill_res.err()
    );
}

#[test]
fn test_pty_session_nonexistent_command_error() {
    let (tx, _rx) = mpsc::channel();
    let manager = PtySessionManager::new(Box::new(move |event| {
        let _ = tx.send(event);
    }));

    let session_id = "test-nonexistent";
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string();

    let res = manager.start_session(
        session_id,
        &cwd,
        "/nonexistent/binary/for/sure",
        &[],
        &[],
    );
    assert!(res.is_err(), "Expected error for nonexistent binary");
}

#[test]
fn test_pty_session_rejects_relative_cwd() {
    let manager = PtySessionManager::new(Box::new(|_| {}));

    // A bare workspace name must not be resolved against the app's own cwd.
    let res = manager.start_session("test-relative-cwd", "src", "/bin/sh", &[], &[]);

    let err = res.expect_err("relative cwd must be rejected");
    assert!(err.contains("absolute"), "unexpected error: {err}");
}

#[test]
fn test_pty_session_rejects_missing_cwd_instead_of_falling_back() {
    let manager = PtySessionManager::new(Box::new(|_| {}));

    // portable-pty would otherwise silently start the agent in $HOME.
    let res = manager.start_session(
        "test-missing-cwd",
        "/nonexistent/workspace/for/sure",
        "/bin/sh",
        &[],
        &[],
    );

    let err = res.expect_err("missing cwd must be rejected");
    assert!(err.contains("not an existing directory"), "unexpected error: {err}");
}

#[test]
fn test_pty_session_operations_on_missing_session() {
    let (tx, _rx) = mpsc::channel();
    let manager = PtySessionManager::new(Box::new(move |event| {
        let _ = tx.send(event);
    }));

    let write_res = manager.write_stdin("missing-id", "test");
    assert!(write_res.is_err());
    assert!(write_res.unwrap_err().contains("not found"));

    let resize_res = manager.resize("missing-id", 80, 24);
    assert!(resize_res.is_err());
    assert!(resize_res.unwrap_err().contains("not found"));

    let kill_res = manager.kill_session("missing-id");
    assert!(kill_res.is_err());
    assert!(kill_res.unwrap_err().contains("not found"));
}

#[test]
fn test_write_stdin_does_not_block_when_a_raw_mode_child_is_not_reading_input() {
    let (tx, rx) = mpsc::channel();
    let manager = PtySessionManager::new(Box::new(move |event| {
        let _ = tx.send(event);
    }));

    let session_id = "test-nonblocking-write-raw";
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string();

    // Agent CLIs switch their tty to raw mode, then stop reading stdin while
    // they are busy. Raw mode is what makes the PTY input buffer fill up and
    // stall the writer; the canonical mode left by a plain `sleep` absorbs the
    // write instead. `stty` has to run before the write, so wait for READY.
    let res = manager.start_session(
        session_id,
        &cwd,
        "/bin/sh",
        &["-c".to_string(), "stty raw -echo; echo READY; sleep 2".to_string()],
        &[],
    );
    assert!(res.is_ok(), "Failed to start session: {:?}", res.err());

    let mut accumulated = String::new();
    let ready_start = std::time::Instant::now();
    while ready_start.elapsed() < Duration::from_secs(5) && !accumulated.contains("READY") {
        if let Ok(PtyEvent::Output {
            session_id: sid,
            data,
        }) = rx.recv_timeout(Duration::from_millis(100))
        {
            if sid == session_id {
                accumulated.push_str(&data);
            }
        }
    }
    assert!(
        accumulated.contains("READY"),
        "Child never entered raw mode, got: {:?}",
        accumulated
    );

    let payload = "a".repeat(1024 * 1024);
    let start = std::time::Instant::now();
    let write_res = manager.write_stdin(session_id, &payload);
    let elapsed = start.elapsed();

    assert!(
        write_res.is_ok(),
        "Failed to write stdin: {:?}",
        write_res.err()
    );
    assert!(
        elapsed < Duration::from_secs(1),
        "write_stdin blocked for {:?}, expected under 1s",
        elapsed
    );

    // A blocked write only returns once the child exits, and the reader thread
    // then reaps the session, so cleanup is best-effort rather than asserted.
    let _ = manager.kill_session(session_id);
}

#[test]
fn test_start_session_applies_extra_env_and_still_sets_term() {
    let (tx, rx) = mpsc::channel();
    let manager = PtySessionManager::new(Box::new(move |event| {
        let _ = tx.send(event);
    }));

    let session_id = "test-extra-env-1";
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string();

    let extra_env = vec![(
        "SPAWN_PLAN_PROBE".to_string(),
        "from-spawn-plan".to_string(),
    )];
    let res = manager.start_session(
        session_id,
        &cwd,
        "/bin/sh",
        &["-c".to_string(), "printf 'PROBE=%s TERM=%s\\n' \"$SPAWN_PLAN_PROBE\" \"$TERM\"".to_string()],
        &extra_env,
    );
    assert!(res.is_ok(), "Failed to start session: {:?}", res.err());

    let mut accumulated = String::new();
    let timeout = Duration::from_secs(5);
    let start = std::time::Instant::now();

    while start.elapsed() < timeout {
        if let Ok(PtyEvent::Output {
            session_id: sid,
            data,
        }) = rx.recv_timeout(Duration::from_millis(100))
        {
            if sid == session_id {
                accumulated.push_str(&data);
                if accumulated.contains("PROBE=") {
                    break;
                }
            }
        }
    }

    assert!(
        accumulated.contains("PROBE=from-spawn-plan"),
        "extra_env did not reach the child, got: {:?}",
        accumulated
    );
    assert!(
        accumulated.contains("TERM=xterm-256color"),
        "TERM must still be set after extra_env, got: {:?}",
        accumulated
    );

    let _ = manager.kill_session(session_id);
}

#[test]
fn test_start_session_extra_env_overrides_the_user_environment() {
    let (tx, rx) = mpsc::channel();
    let manager = PtySessionManager::new(Box::new(move |event| {
        let _ = tx.send(event);
    }));

    let session_id = "test-extra-env-override";
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string();

    // extra_env is applied after the login-shell env, so it must win.
    let extra_env = vec![("HOME".to_string(), "/tmp/spawn-plan-home".to_string())];
    let res = manager.start_session(
        session_id,
        &cwd,
        "/bin/sh",
        &["-c".to_string(), "printf 'HOME=%s\\n' \"$HOME\"".to_string()],
        &extra_env,
    );
    assert!(res.is_ok(), "Failed to start session: {:?}", res.err());

    let mut accumulated = String::new();
    let timeout = Duration::from_secs(5);
    let start = std::time::Instant::now();

    while start.elapsed() < timeout {
        if let Ok(PtyEvent::Output {
            session_id: sid,
            data,
        }) = rx.recv_timeout(Duration::from_millis(100))
        {
            if sid == session_id {
                accumulated.push_str(&data);
                if accumulated.contains("HOME=") {
                    break;
                }
            }
        }
    }

    assert!(
        accumulated.contains("HOME=/tmp/spawn-plan-home"),
        "extra_env must override the user environment, got: {:?}",
        accumulated
    );

    let _ = manager.kill_session(session_id);
}
