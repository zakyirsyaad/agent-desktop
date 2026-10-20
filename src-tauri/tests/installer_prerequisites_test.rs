use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::ops::Deref;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use zorvo_lib::installer::prerequisites::{
    npm_install_args, prerequisites_for, run_npm_install, NpmError, Prerequisite,
};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh, empty dir unique to one test, removed when dropped.
struct TempDir(PathBuf);

impl Deref for TempDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn temp_dir() -> TempDir {
    let dir = std::env::temp_dir().join(format!(
        "zorvo-prereq-test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
}

/// Writes an executable `npm` shell script into `dir` and returns its path.
fn fake_npm(dir: &Path, body: &str) -> PathBuf {
    let path = dir.join("npm");
    fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn args() -> Vec<OsString> {
    let p = &prerequisites_for("pi-acp")[0];
    npm_install_args(Path::new("/tmp/prefix"), p)
}

#[test]
fn pi_acp_needs_pi_at_an_exact_version() {
    let list = prerequisites_for("pi-acp");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].command, "pi");
    assert_eq!(list[0].package, "@earendil-works/pi-coding-agent");
    let parts: Vec<&str> = list[0].version.split('.').collect();
    assert_eq!(parts.len(), 3);
    assert!(parts
        .iter()
        .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())));
    assert!(prerequisites_for("gemini").is_empty());
}

#[test]
fn npm_install_args_keep_a_prefix_with_spaces_as_one_argument() {
    let p = Prerequisite {
        command: "pi",
        package: "@earendil-works/pi-coding-agent",
        version: "1.2.0",
    };
    let args = npm_install_args(Path::new("/tmp/Application Support/x"), &p);
    let expected: Vec<OsString> = [
        "install",
        "-g",
        "--prefix",
        "/tmp/Application Support/x",
        "--no-audit",
        "--no-fund",
        "@earendil-works/pi-coding-agent@1.2.0",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    assert_eq!(args, expected);
}

#[test]
fn run_npm_install_succeeds_on_exit_zero() {
    let d = temp_dir();
    let npm = fake_npm(&d, "exit 0");
    let result = run_npm_install(
        &npm,
        &args(),
        &HashMap::new(),
        Duration::from_secs(10),
        &AtomicBool::new(false),
    );
    assert_eq!(result, Ok(()));
}

#[test]
fn run_npm_install_reports_the_stderr_tail() {
    let d = temp_dir();
    let npm = fake_npm(
        &d,
        "i=1\nwhile [ $i -le 30 ]; do echo \"line $i\" >&2; i=$((i+1)); done\nexit 1",
    );
    let err = run_npm_install(
        &npm,
        &args(),
        &HashMap::new(),
        Duration::from_secs(10),
        &AtomicBool::new(false),
    )
    .unwrap_err()
    .to_string();
    assert!(
        err.starts_with("npm could not install @earendil-works/pi-coding-agent@"),
        "{err}"
    );
    assert!(err.contains("line 30"), "{err}");
    assert!(
        !err.contains("line 5\n") && !err.ends_with("line 5"),
        "{err}"
    );
    assert!(!err.contains("line 10\n"), "{err}");
}

#[test]
fn run_npm_install_stops_at_the_timeout() {
    let d = temp_dir();
    // The script marks that it echoed, so a failure says whether it ran at all.
    let echoed = d.join("echoed");
    let npm = fake_npm(
        &d,
        &format!(
            "[ \"$1\" = --version ] && exit 0\necho slow-registry >&2\n: > '{}'\n/bin/sleep 30",
            echoed.display()
        ),
    );
    // The first run of a new executable can take seconds on a loaded Mac
    // (the script had not echoed after 5 s); run it once untimed first.
    assert!(std::process::Command::new(&npm)
        .arg("--version")
        .status()
        .unwrap()
        .success());
    let started = Instant::now();
    let err = run_npm_install(
        &npm,
        &args(),
        &HashMap::new(),
        // Long enough for the script to start on a loaded machine.
        Duration::from_secs(5),
        &AtomicBool::new(false),
    )
    .unwrap_err()
    .to_string();
    assert!(started.elapsed() < Duration::from_secs(15));
    assert!(err.contains("timed out"), "{err}");
    assert!(
        echoed.exists(),
        "the script had not echoed before the timeout: {err}"
    );
    assert!(err.contains("slow-registry"), "{err}");
}

#[test]
fn run_npm_install_stops_when_cancelled() {
    let d = temp_dir();
    let npm = fake_npm(&d, "/bin/sleep 30");
    let cancel = AtomicBool::new(false);
    let started = Instant::now();
    let err = std::thread::scope(|s| {
        s.spawn(|| {
            std::thread::sleep(Duration::from_millis(300));
            cancel.store(true, Ordering::Relaxed);
        });
        run_npm_install(
            &npm,
            &args(),
            &HashMap::new(),
            Duration::from_secs(60),
            &cancel,
        )
    })
    .unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(err, NpmError::Cancelled);
}

#[test]
fn run_npm_install_cancel_kills_npms_children() {
    let d = temp_dir();
    let pid_file = d.join("child.pid");
    let npm = fake_npm(
        &d,
        &format!("/bin/sleep 30 &\necho $! > '{}'\nwait", pid_file.display()),
    );
    let cancel = AtomicBool::new(false);
    let _ = std::thread::scope(|s| {
        s.spawn(|| {
            // Cancel only once the script has started its child.
            let wait_until = Instant::now() + Duration::from_secs(10);
            while !pid_file.exists() && Instant::now() < wait_until {
                std::thread::sleep(Duration::from_millis(50));
            }
            std::thread::sleep(Duration::from_millis(100));
            cancel.store(true, Ordering::Relaxed);
        });
        run_npm_install(
            &npm,
            &args(),
            &HashMap::new(),
            Duration::from_secs(60),
            &cancel,
        )
    });
    let pid = fs::read_to_string(&pid_file).unwrap().trim().to_string();
    let deadline = Instant::now() + Duration::from_secs(1);
    let alive = loop {
        let alive = std::process::Command::new("/bin/kill")
            .args(["-0", &pid])
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
            .success();
        if !alive || Instant::now() >= deadline {
            break alive;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    assert!(!alive, "npm's child {pid} survived the cancel");
}
