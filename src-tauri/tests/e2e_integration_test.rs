use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use agent_desktop_lib::env_resolver::resolve_user_env;
use agent_desktop_lib::profiles::get_available_agent_profiles;
use agent_desktop_lib::pty_session::{PtyEvent, PtySessionManager};
use sha2::{Digest, Sha256};

/// Helper to compute SHA-256 hash of a file if it exists.
fn compute_file_sha256(path: &Path) -> Option<String> {
    if !path.exists() {
        return None;
    }
    let data = fs::read(path).ok()?;
    let mut hasher = Sha256::new();
    hasher.update(&data);
    let result = hasher.finalize();
    Some(
        result
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<Vec<String>>()
            .join(""),
    )
}

/// Harness config files the app must never touch, relative to HOME.
const HARNESS_CONFIGS: [&str; 3] = [
    ".claude/settings.json",
    ".claude.json",
    ".omp/agent/config.yml",
];

/// A throwaway HOME holding copies of the harness configs.
///
/// The real `~/.claude.json` is rewritten constantly by any Claude Code session
/// running on the machine, so hashing it made this test fail at random. The
/// agent under test runs with HOME pointed here instead, which still proves the
/// app never writes the configs of the agent it drives.
fn isolated_home() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let home = std::env::temp_dir().join(format!(
        "agent-desktop-e2e-home-{}-{}",
        std::process::id(),
        nanos
    ));
    for relative in HARNESS_CONFIGS {
        let path = home.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("fixture for {}\n", relative)).unwrap();
    }
    home
}

/// Helper to snapshot known harness configuration files under `home`.
fn snapshot_harness_configs(home_path: &Path) -> Vec<(PathBuf, Option<String>)> {
    let mut snapshots = Vec::new();

    {
        // Claude Code settings
        let claude_settings = home_path.join(".claude").join("settings.json");
        let hash = compute_file_sha256(&claude_settings);
        snapshots.push((claude_settings, hash));

        // Claude Code .claude.json
        let claude_json = home_path.join(".claude.json");
        let hash = compute_file_sha256(&claude_json);
        snapshots.push((claude_json, hash));

        // OpenCode / OMP agent config
        let omp_config = home_path.join(".omp").join("agent").join("config.yml");
        let hash = compute_file_sha256(&omp_config);
        snapshots.push((omp_config, hash));
    }

    snapshots
}

#[test]
fn test_e2e_pty_interactive_approval_and_zero_harness_mutation() {
    // STEP 1: Take initial snapshot of harness configurations
    let home = isolated_home();
    let initial_snapshots = snapshot_harness_configs(&home);
    assert!(
        !initial_snapshots.is_empty(),
        "Expected at least one harness config file path to check"
    );

    // STEP 2: Verify Profiles and Environment Resolution
    let profiles = get_available_agent_profiles();
    assert!(
        !profiles.is_empty(),
        "Agent profiles must not be empty (should contain default profiles)"
    );

    let env_vars = resolve_user_env().expect("Should resolve user environment");
    assert!(
        env_vars.contains_key("PATH"),
        "Resolved environment must contain PATH"
    );

    // STEP 3: Setup PTY Manager and Channel
    let (tx, rx) = mpsc::channel();
    let manager = PtySessionManager::new(Box::new(move |event| {
        let _ = tx.send(event);
    }));

    let session_id = "e2e-session-approval-1";
    let cwd = std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string();

    // Simulating an interactive agent CLI that:
    // 1. Prints an action request and approval prompt: "Allow this action? [y/n]: "
    // 2. Reads 1 line from standard input
    // 3. If line starts with 'y' or 'Y', prints "ACTION_APPROVED_SUCCESSFULLY" and exits 0
    // 4. Otherwise prints "ACTION_REJECTED" and exits 1
    let dummy_agent_cli = r#"
printf "Simulating Claude Code Agent...\n"
printf "Tool Call Request: Bash('rm -rf /tmp/test-target')\n"
printf "Allow this action? [y/n]: "
read answer
case "$answer" in
    y*|Y*)
        printf "\nACTION_APPROVED_SUCCESSFULLY\n"
        exit 0
        ;;
    *)
        printf "\nACTION_REJECTED\n"
        exit 1
        ;;
esac
"#;

    let spawn_res = manager.start_session(
        session_id,
        &cwd,
        "/bin/sh",
        &["-c".to_string(), dummy_agent_cli.to_string()],
        &[("HOME".to_string(), home.to_string_lossy().to_string())],
    );
    assert!(
        spawn_res.is_ok(),
        "Failed to spawn PTY session: {:?}",
        spawn_res.err()
    );

    let mut accumulated_output = String::new();
    let mut exit_code_received: Option<u32> = None;
    let mut input_sent = false;

    let timeout = Duration::from_secs(10);
    let start_time = Instant::now();

    while start_time.elapsed() < timeout {
        if let Ok(event) = rx.recv_timeout(Duration::from_millis(50)) {
            match event {
                PtyEvent::Output {
                    session_id: sid,
                    data,
                } => {
                    if sid == session_id {
                        accumulated_output.push_str(&data);

                        // Once prompt is detected and input has not been sent, simulate user approving action
                        if !input_sent && accumulated_output.contains("Allow this action? [y/n]") {
                            let write_res = manager.write_stdin(session_id, "y\n");
                            assert!(
                                write_res.is_ok(),
                                "Failed to send input: {:?}",
                                write_res.err()
                            );
                            input_sent = true;
                        }
                    }
                }
                PtyEvent::Exit {
                    session_id: sid,
                    exit_code,
                } => {
                    if sid == session_id {
                        exit_code_received = Some(exit_code);
                        break;
                    }
                }
            }
        }
    }

    assert!(
        input_sent,
        "Approval prompt was not reached or input was not sent. Output: {:?}",
        accumulated_output
    );
    assert_eq!(
        exit_code_received,
        Some(0),
        "Expected process to exit with code 0. Output was: {:?}",
        accumulated_output
    );
    assert!(
        accumulated_output.contains("ACTION_APPROVED_SUCCESSFULLY"),
        "Output did not contain expected success message. Output was: {:?}",
        accumulated_output
    );

    // STEP 4: Zero Harness Mutation Guarantee Verification
    // Re-verify that no configuration files were created, deleted, or modified.
    let final_snapshots = snapshot_harness_configs(&home);
    assert_eq!(
        initial_snapshots.len(),
        final_snapshots.len(),
        "Snapshot file counts differ"
    );

    for (i, (initial_path, initial_hash)) in initial_snapshots.iter().enumerate() {
        let (final_path, final_hash) = &final_snapshots[i];
        assert_eq!(initial_path, final_path, "Config file paths must match");
        assert_eq!(
            initial_hash,
            final_hash,
            "ZERO HARNESS MUTATION VIOLATED! File '{}' changed from {:?} to {:?}",
            initial_path.display(),
            initial_hash,
            final_hash
        );
    }

    let _ = fs::remove_dir_all(&home);
}
