//! The npm packages the user installed globally, so an `npx` registry agent
//! whose package is already installed can be enabled automatically.
//!
//! Detection is best effort: a missing, failing or slow `npm` gives an empty
//! set and nothing else changes.

use std::collections::{BTreeSet, HashMap};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::Value;

use crate::env_resolver::find_binary_in_path_str;

/// How long `npm ls -g` may take before detection is skipped.
pub const NPM_TIMEOUT: Duration = Duration::from_secs(5);

/// The most output read from `npm ls`; a global package list is far smaller.
const MAX_OUTPUT_BYTES: u64 = 4 * 1024 * 1024;

/// Runs `npm ls -g --depth=0 --json` with the user's environment `env` and
/// returns the names under `dependencies`. The process is killed after `timeout`.
pub fn npm_globals(env: &HashMap<String, String>, timeout: Duration) -> BTreeSet<String> {
    let Some(npm) = env
        .get("PATH")
        .and_then(|path_var| find_binary_in_path_str("npm", path_var))
    else {
        return BTreeSet::new();
    };

    let Ok(mut child) = Command::new(npm)
        .args(["ls", "-g", "--depth=0", "--json"])
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return BTreeSet::new();
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return BTreeSet::new();
    };

    // Read on another thread, so a full pipe never blocks npm and a hung npm
    // never blocks the caller past the timeout.
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut output = String::new();
        let read = stdout
            .take(MAX_OUTPUT_BYTES)
            .read_to_string(&mut output)
            .map(|_| output);
        let _ = sender.send(read);
    });

    let output = receiver.recv_timeout(timeout);
    // npm has closed its output or run out of time; either way it is done. A
    // kill after a normal exit is harmless and keeps `wait` from ever blocking.
    let _ = child.kill();
    let _ = child.wait();
    match output {
        // `npm ls` exits non-zero on dependency problems but still prints the list.
        Ok(Ok(output)) => dependency_names(&output),
        _ => BTreeSet::new(),
    }
}

fn dependency_names(output: &str) -> BTreeSet<String> {
    serde_json::from_str::<Value>(output)
        .ok()
        .and_then(|root| {
            root.get("dependencies")
                .and_then(Value::as_object)
                .map(|deps| deps.keys().cloned().collect())
        })
        .unwrap_or_default()
}
