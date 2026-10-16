use std::collections::HashMap;
use std::env;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// Longest we wait for the user's login shell to print its environment.
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(10);
/// How often a running login shell is polled for exit.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(20);

static USER_ENV: OnceLock<HashMap<String, String>> = OnceLock::new();

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

/// Returns the user environment, resolving the login shell only on first success.
///
/// Spawning a login shell can take seconds with heavy dotfiles, so every session spawn
/// and profile scan shares one result. A failed resolve is not cached and is retried.
pub fn cached_user_env() -> Result<HashMap<String, String>, String> {
    if let Some(env_map) = USER_ENV.get() {
        return Ok(env_map.clone());
    }
    let resolved = resolve_user_env()?;
    Ok(USER_ENV.get_or_init(|| resolved).clone())
}

/// Runs `program` with stdin closed and returns its stdout, killing it after `timeout`.
fn run_with_timeout(program: &str, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Failed to execute login shell {}: {}", program, e))?;

    // Drain stdout concurrently so a large environment cannot fill the pipe and stall the shell.
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Failed to capture stdout of {}", program))?;
    let reader = thread::spawn(move || {
        let mut buf = Vec::new();
        stdout.read_to_end(&mut buf).map(|_| buf)
    });

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
                return Err(format!("Login shell {} timed out after {:?}", program, timeout));
            }
            None => thread::sleep(EXIT_POLL_INTERVAL),
        }
    };

    if !status.success() {
        return Err(format!("Login shell {} exited with status {}", program, status));
    }

    let bytes = reader
        .join()
        .map_err(|_| format!("Reader thread for {} panicked", program))?
        .map_err(|e| format!("Failed to read output of {}: {}", program, e))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
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
        let cell = OnceLock::new();
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
        let cell = OnceLock::new();
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
    fn cached_user_env_resolves_once_and_returns_the_same_map() {
        let first = cached_user_env().expect("first resolve");
        let second = cached_user_env().expect("cached resolve");

        assert!(first.contains_key("PATH"));
        assert_eq!(first, second);
    }
}
