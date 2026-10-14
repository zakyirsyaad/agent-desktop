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

    let res = manager.start_session(session_id, &cwd, "/bin/cat", &[]);
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

    let res = manager.start_session(session_id, &cwd, "/nonexistent/binary/for/sure", &[]);
    assert!(res.is_err(), "Expected error for nonexistent binary");
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
