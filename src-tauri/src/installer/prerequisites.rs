//! CLIs that a registry agent runs but the registry cannot express, and the
//! npm install that provides them in a Zorvo-owned prefix.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fmt;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::env_resolver::{drain_in_background, recv_by_deadline};

/// How long an npm install may run in production.
pub const NPM_INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// How many trailing stderr lines go into an error message.
const STDERR_TAIL_LINES: usize = 20;

/// How often the cancel flag and the child are checked.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// How long to wait for stderr after the child has exited.
const STDERR_GRACE: Duration = Duration::from_secs(2);

/// Why an npm install did not finish.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NpmError {
    /// The cancel flag was set and npm was stopped.
    Cancelled,
    /// npm could not start, failed or timed out; the message says which.
    Failed(String),
}

impl fmt::Display for NpmError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => f.write_str("The npm install was cancelled"),
            Self::Failed(message) => f.write_str(message),
        }
    }
}

/// A command an agent needs on PATH, and the npm package that provides it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Prerequisite {
    pub command: &'static str,
    pub package: &'static str,
    /// An exact version, never a range, so installs are reproducible. Pinned
    /// to a release at least a week old, like the other pinned packages.
    pub version: &'static str,
}

const PI_ACP: &[Prerequisite] = &[Prerequisite {
    command: "pi",
    package: "@earendil-works/pi-coding-agent",
    // Published 2026-10-07T22:16Z, over 7 x 24 h before it was pinned.
    version: "1.1.0",
}];

/// The prerequisites of a registry agent; empty for most agents.
pub fn prerequisites_for(agent_id: &str) -> &'static [Prerequisite] {
    match agent_id {
        "pi-acp" => PI_ACP,
        _ => &[],
    }
}

/// Every prerequisite of every agent, for scanning what is installed.
pub fn all_prerequisites() -> impl Iterator<Item = &'static Prerequisite> {
    PI_ACP.iter()
}

/// The `npm` arguments that install `p` globally under `prefix`. Each value is
/// its own argument, so a prefix with spaces needs no quoting.
pub fn npm_install_args(prefix: &Path, p: &Prerequisite) -> Vec<OsString> {
    vec![
        "install".into(),
        "-g".into(),
        "--prefix".into(),
        prefix.as_os_str().to_owned(),
        "--no-audit".into(),
        "--no-fund".into(),
        format!("{}@{}", p.package, p.version).into(),
    ]
}

/// Runs `npm` with `args` in `env` until it exits, `timeout` passes or `cancel`
/// is set. The child is killed in the last two cases.
pub fn run_npm_install(
    npm: &Path,
    args: &[OsString],
    env: &HashMap<String, String>,
    timeout: Duration,
    cancel: &AtomicBool,
) -> Result<(), NpmError> {
    let package = args
        .last()
        .map(|a| a.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut child = Command::new(npm)
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        // Its own process group, so a stop can take npm's node and script
        // children down with it.
        .process_group(0)
        .spawn()
        .map_err(|e| NpmError::Failed(format!("npm could not start to install {package}: {e}")))?;
    let stderr = child.stderr.take().map(drain_in_background);

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => {
                stop(&mut child);
                return Err(NpmError::Failed(format!(
                    "npm could not install {package}: {e}"
                )));
            }
        }
        if cancel.load(Ordering::Relaxed) {
            stop(&mut child);
            return Err(NpmError::Cancelled);
        }
        if Instant::now() >= deadline {
            stop(&mut child);
            return Err(NpmError::Failed(format!(
                "npm timed out installing {package}\n{}",
                stderr_tail(stderr)
            )));
        }
        std::thread::sleep(POLL_INTERVAL);
    };
    if status.success() {
        return Ok(());
    }

    Err(NpmError::Failed(format!(
        "npm could not install {package}\n{}",
        stderr_tail(stderr)
    )))
}

/// The last lines npm wrote to stderr, waiting briefly for the drain thread.
fn stderr_tail(stderr: Option<mpsc::Receiver<std::io::Result<Vec<u8>>>>) -> String {
    stderr
        .and_then(|rx| recv_by_deadline(&rx, Instant::now() + STDERR_GRACE))
        .and_then(Result::ok)
        .map(|bytes| last_lines(&String::from_utf8_lossy(&bytes), STDERR_TAIL_LINES))
        .unwrap_or_default()
}

/// Kills npm's whole process group, then npm itself, and reaps it.
fn stop(child: &mut Child) {
    let group = format!("-{}", child.id());
    let _ = Command::new("/bin/kill")
        .args(["-s", "KILL", "--", &group])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

fn last_lines(text: &str, max: usize) -> String {
    let lines: Vec<&str> = text.trim_end().lines().collect();
    lines[lines.len().saturating_sub(max)..].join("\n")
}
