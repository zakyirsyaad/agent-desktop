use std::collections::HashMap;
use std::env;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// Longest we wait for the user's login shell to print its environment.
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(10);
/// How often a running login shell is polled for exit.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(20);
/// Longest stderr excerpt kept in an error message.
const MAX_STDERR_IN_ERROR: usize = 500;

/// Outcome of a single login shell environment resolve, cached as-is.
type EnvResult = Result<HashMap<String, String>, String>;

static USER_ENV: Mutex<Option<EnvResult>> = Mutex::new(None);

/// Resolves the user's authentic login shell environment variables.
///
/// On macOS and Unix systems, GUI applications launched from Finder / Dock do not
/// inherit the user's login shell `$PATH` and environment (such as Homebrew, Cargo, NVM, etc.).
/// This function launches the user's login shell with `$SHELL -l -c "env"` to read the authentic
/// environment map. The shell gets no stdin and is killed after `LOGIN_SHELL_TIMEOUT`, so a
/// dotfile that prompts or hangs cannot block the caller forever.
pub fn resolve_user_env() -> Result<HashMap<String, String>, String> {
    #[cfg(unix)]
    {
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let stdout = run_with_timeout(&shell, &["-l", "-c", "env"], LOGIN_SHELL_TIMEOUT)?;

        let map = stdout
            .lines()
            .filter_map(|line| line.split_once('='))
            .filter(|(k, _)| !k.is_empty())
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();

        Ok(map)
    }

    #[cfg(not(unix))]
    {
        Ok(env::vars().collect())
    }
}

/// Returns the user environment, resolved once and then reused.
///
/// Spawning a login shell can take seconds with heavy dotfiles, so every session spawn
/// and profile scan shares one result. The outcome — success or failure — is cached
/// until [`refresh_user_env`] runs, e.g. when the user installed an agent and asks the
/// app to check again. Callers already fall back to the process environment when this
/// returns `Err`.
pub fn cached_user_env() -> EnvResult {
    resolve_once(&USER_ENV, resolve_user_env)
}

/// Resolves the user environment afresh and caches it for later callers.
pub fn refresh_user_env() -> EnvResult {
    re_resolve(&USER_ENV, resolve_user_env)
}

fn lock(cell: &Mutex<Option<EnvResult>>) -> std::sync::MutexGuard<'_, Option<EnvResult>> {
    // A panic while resolving leaves no half-written value, so a poisoned lock is usable.
    cell.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Runs `resolve` for `cell` unless it already holds an outcome, and returns it.
///
/// Concurrent callers block on the single in-flight resolve instead of spawning extra
/// login shells, and a failed resolve is kept rather than retried on the next call.
fn resolve_once(cell: &Mutex<Option<EnvResult>>, resolve: impl FnOnce() -> EnvResult) -> EnvResult {
    let mut slot = lock(cell);
    if let Some(result) = slot.as_ref() {
        return result.clone();
    }
    let result = resolve();
    *slot = Some(result.clone());
    result
}

/// Runs `resolve` and caches its outcome. A failed re-read keeps an earlier
/// good environment: agents launched later still need the user's PATH.
///
/// The login shell runs before the lock is taken, so callers reading the
/// cached environment meanwhile (e.g. a session spawning on the main thread)
/// get the current value instead of waiting for the shell.
fn re_resolve(cell: &Mutex<Option<EnvResult>>, resolve: impl FnOnce() -> EnvResult) -> EnvResult {
    let result = resolve();
    let mut slot = lock(cell);
    if result.is_ok() || !matches!(slot.as_ref(), Some(Ok(_))) {
        *slot = Some(result.clone());
    }
    slot.clone().unwrap_or(result)
}

/// Runs `program` with stdin closed and returns its stdout, killing it after `timeout`.
///
/// Both streams are drained on helper threads and the reads share the exit deadline, so
/// a backgrounded daemon that keeps stdout open cannot outlive `timeout`.
fn run_with_timeout(program: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to execute login shell {}: {}", program, e))?;

    // Drain both streams concurrently so a large environment cannot fill a pipe and stall the shell.
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Failed to capture stdout of {}", program))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("Failed to capture stderr of {}", program))?;
    let stdout_rx = drain_in_background(stdout);
    let stderr_rx = drain_in_background(stderr);

    let deadline = Instant::now() + timeout;
    let status = loop {
        let polled = child
            .try_wait()
            .map_err(|e| format!("Failed to wait for login shell {}: {}", program, e))?;
        match polled {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "Login shell {} timed out after {:?}",
                    program, timeout
                ));
            }
            None => thread::sleep(EXIT_POLL_INTERVAL),
        }
    };

    if !status.success() {
        return Err(format!(
            "Login shell {} exited with status {}: {}",
            program,
            status,
            read_stderr_tail(&stderr_rx, deadline)
        ));
    }

    match recv_by_deadline(&stdout_rx, deadline) {
        Some(Ok(bytes)) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Some(Err(e)) => Err(format!("Failed to read output of {}: {}", program, e)),
        None => Err(format!(
            "Login shell {} timed out after {:?} while its output stayed open",
            program, timeout
        )),
    }
}

/// Reads `stream` to the end on a helper thread and hands the bytes back over a channel.
///
/// Decoupling the read from the caller is what lets `run_with_timeout` abandon a stream
/// that a backgrounded grandchild keeps open.
fn drain_in_background<R: Read + Send + 'static>(
    stream: R,
) -> mpsc::Receiver<std::io::Result<Vec<u8>>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut stream = stream;
        let mut buf = Vec::new();
        let _ = tx.send(stream.read_to_end(&mut buf).map(|_| buf));
    });
    rx
}

/// Receives a drained stream's bytes, returning `None` when `deadline` passes first.
fn recv_by_deadline(
    rx: &mpsc::Receiver<std::io::Result<Vec<u8>>>,
    deadline: Instant,
) -> Option<std::io::Result<Vec<u8>>> {
    rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
        .ok()
}

/// Returns the trimmed tail of the shell's stderr for an error message.
///
/// A stderr stream that is still open or failed to read is reported as empty, because the
/// exit status alone is already enough to fail the resolve.
fn read_stderr_tail(rx: &mpsc::Receiver<std::io::Result<Vec<u8>>>, deadline: Instant) -> String {
    let bytes = match recv_by_deadline(rx, deadline) {
        Some(Ok(bytes)) => bytes,
        _ => Vec::new(),
    };
    last_chars(String::from_utf8_lossy(&bytes).trim(), MAX_STDERR_IN_ERROR)
}

/// Returns the last `max` characters of `text`, never splitting a char boundary.
fn last_chars(text: &str, max: usize) -> String {
    let total = text.chars().count();
    if total <= max {
        return text.to_string();
    }
    text.chars().skip(total - max).collect()
}

/// Checks whether a given path is an executable file.
fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        if let Ok(metadata) = path.metadata() {
            let permissions = metadata.permissions();
            // Check if executable by owner, group, or others
            return permissions.mode() & 0o111 != 0;
        }
        false
    }

    #[cfg(not(unix))]
    {
        true
    }
}

/// Finds a binary inside a given PATH string.
pub fn find_binary_in_path_str(binary_name: &str, path_var: &str) -> Option<PathBuf> {
    for dir in path_var.split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = PathBuf::from(dir).join(binary_name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Finds a binary in the resolved user PATH.
///
/// Falls back to the current process PATH if resolving the user shell environment fails.
pub fn find_binary_in_user_path(binary_name: &str) -> Option<PathBuf> {
    let path_var = match cached_user_env() {
        Ok(env_map) => env_map.get("PATH").cloned(),
        Err(_) => None,
    }
    .or_else(|| env::var("PATH").ok())?;

    find_binary_in_path_str(binary_name, &path_var)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn test_is_executable() {
        let sh = PathBuf::from("/bin/sh");
        assert!(is_executable(&sh));

        let nonexistent = PathBuf::from("/nonexistent/file/path");
        assert!(!is_executable(&nonexistent));
    }

    #[cfg(unix)]
    #[test]
    fn run_with_timeout_kills_a_shell_that_never_finishes() {
        let started = std::time::Instant::now();

        let res = run_with_timeout("/bin/sh", &["-c", "sleep 5"], Duration::from_millis(300));

        let err = res.expect_err("a hung shell must time out");
        assert!(err.contains("timed out"), "unexpected error: {err}");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[cfg(unix)]
    #[test]
    fn run_with_timeout_closes_stdin_so_prompting_dotfiles_cannot_hang() {
        let res = run_with_timeout(
            "/bin/sh",
            &["-c", "read answer; echo done"],
            Duration::from_secs(5),
        );

        assert_eq!(res.expect("read must hit EOF immediately"), "done\n");
    }

    #[cfg(unix)]
    #[test]
    fn run_with_timeout_bounds_reading_when_a_background_process_keeps_stdout_open() {
        // A dotfile that backgrounds a daemon (ssh-agent, gpg-agent) leaves the
        // shell's stdout open after the shell itself exits.
        let started = std::time::Instant::now();

        let res = run_with_timeout(
            "/bin/sh",
            &["-c", "sleep 5 & echo started"],
            Duration::from_millis(300),
        );

        let err = res.expect_err("an open stdout must not block past the timeout");
        assert!(err.contains("timed out"), "unexpected error: {err}");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[cfg(unix)]
    #[test]
    fn run_with_timeout_reports_stderr_when_the_shell_fails() {
        let res = run_with_timeout(
            "/bin/sh",
            &["-c", "echo 'zprofile: nvm not found' >&2; exit 3"],
            Duration::from_secs(5),
        );

        let err = res.expect_err("non-zero exit must be an error");
        assert!(err.contains("nvm not found"), "stderr missing from: {err}");
    }

    #[test]
    fn resolve_once_runs_a_single_resolve_for_concurrent_callers() {
        let cell = Mutex::new(None);
        let calls = AtomicUsize::new(0);

        thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    resolve_once(&cell, || {
                        calls.fetch_add(1, Ordering::SeqCst);
                        thread::sleep(Duration::from_millis(50));
                        Ok(HashMap::new())
                    })
                });
            }
        });

        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn resolve_once_keeps_a_failed_resolve_instead_of_retrying() {
        let cell = Mutex::new(None);
        let calls = AtomicUsize::new(0);
        let failing = || {
            calls.fetch_add(1, Ordering::SeqCst);
            Err("login shell timed out".to_string())
        };

        let first = resolve_once(&cell, failing);
        let second = resolve_once(&cell, failing);

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(first, second);
        assert!(first.is_err());
    }

    #[test]
    fn re_resolve_replaces_the_cached_result_for_later_callers() {
        let cell = Mutex::new(None);
        let stale = resolve_once(&cell, || {
            Ok(HashMap::from([("PATH".to_string(), "/old".to_string())]))
        });

        let fresh = re_resolve(&cell, || {
            Ok(HashMap::from([(
                "PATH".to_string(),
                "/old:/new".to_string(),
            )]))
        });
        let later = resolve_once(&cell, || Err("must not resolve again".to_string()));

        assert_eq!(stale.unwrap()["PATH"], "/old");
        assert_eq!(fresh.unwrap()["PATH"], "/old:/new");
        assert_eq!(later.unwrap()["PATH"], "/old:/new");
    }

    #[test]
    fn re_resolve_does_not_block_readers_while_the_shell_runs() {
        let cell = Mutex::new(Some(Ok(HashMap::from([(
            "PATH".to_string(),
            "/old".to_string(),
        )]))));

        thread::scope(|scope| {
            let refresh = scope.spawn(|| {
                re_resolve(&cell, || {
                    thread::sleep(Duration::from_millis(300));
                    Ok(HashMap::from([("PATH".to_string(), "/new".to_string())]))
                })
            });
            thread::sleep(Duration::from_millis(50));
            let started = Instant::now();
            let during = resolve_once(&cell, || Err("must not resolve".to_string()));
            assert!(
                started.elapsed() < Duration::from_millis(150),
                "a reader waited for the shell"
            );
            assert_eq!(during.unwrap()["PATH"], "/old");
            refresh.join().unwrap().unwrap();
        });
    }

    #[test]
    fn re_resolve_keeps_a_good_environment_when_the_re_read_fails() {
        let cell = Mutex::new(None);
        resolve_once(&cell, || {
            Ok(HashMap::from([("PATH".to_string(), "/good".to_string())]))
        })
        .unwrap();

        let after = re_resolve(&cell, || Err("login shell timed out".to_string()));

        assert_eq!(after.unwrap()["PATH"], "/good");
    }

    #[test]
    fn cached_user_env_resolves_once_and_returns_the_same_map() {
        let first = cached_user_env().expect("first resolve");
        let second = cached_user_env().expect("cached resolve");

        assert!(first.contains_key("PATH"));
        assert_eq!(first, second);
    }
}
