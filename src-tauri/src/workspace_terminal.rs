//! A login shell in one of the user's workspace folders, shown as a terminal tab.
//!
//! The webview sends only a folder; the shell, its arguments and its
//! environment are chosen here. Input and resize go through the PTY layer's
//! `send_input` and `resize_session`. Nothing here logs a shell's input or output.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use tauri::State;

use crate::acp::terminal_auth::{
    is_sign_in_terminal_id, sign_in_event_payload, SIGN_IN_TERMINAL_EVENT,
};
use crate::background_processes::end_tree;
use crate::env_resolver::cached_user_env;
use crate::files::{canonical_root, ensure_known_workspace};
use crate::pty_session::{PtyEvent, PtySessionManager};
use crate::store::AppStore;

/// The event a workspace shell's output and exit go out on.
pub const EVENT: &str = "workspace-terminal";

const ID_PREFIX: &str = "shell-";
/// `u64::MAX` has 20 digits.
const MAX_ID_DIGITS: usize = 20;
const FALLBACK_SHELL: &str = "/bin/zsh";

/// `^shell-[0-9]{1,20}$`
pub fn is_workspace_terminal_id(id: &str) -> bool {
    id.strip_prefix(ID_PREFIX).is_some_and(|digits| {
        (1..=MAX_ID_DIGITS).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit())
    })
}

/// A terminal id no other shell in this process has had.
pub fn next_terminal_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!("{ID_PREFIX}{}", NEXT.fetch_add(1, Ordering::Relaxed))
}

/// The user's `SHELL` from their login environment when it is an absolute path
/// to an executable file, else `/bin/zsh`.
pub fn shell_from(env: &HashMap<String, String>) -> String {
    env.get("SHELL")
        .filter(|shell| is_executable_file(Path::new(shell)))
        .cloned()
        .unwrap_or_else(|| FALLBACK_SHELL.to_string())
}

fn is_executable_file(path: &Path) -> bool {
    path.is_absolute()
        && path
            .metadata()
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// Starts `shell -l` in `folder` as PTY session `id`.
pub fn start_shell(
    manager: &PtySessionManager,
    id: &str,
    folder: &Path,
    shell: &str,
) -> Result<(), String> {
    let folder = folder
        .to_str()
        .ok_or_else(|| format!("Folder {} is not valid UTF-8", folder.display()))?;
    manager.start_session(id, folder, shell, &["-l".to_string()], &[])
}

/// Ends the shell `id` and everything it started, a `nohup`ed job included.
/// The tree is read while the shell still runs: once the shell is gone its
/// children are adopted by launchd and can no longer be found from it. A
/// shell that already exited is gone from the manager (its reader thread
/// removed it), which is not an error.
pub fn close(manager: &PtySessionManager, id: &str) -> Result<(), String> {
    if !is_workspace_terminal_id(id) {
        return Err("That is not a workspace terminal".to_string());
    }
    if !manager.has_session(id) {
        return Ok(());
    }
    let tree = manager.pid_of(id).map_or(Ok(()), |pid| end_tree(pid, true));
    // The shell is ended even when its tree could not be read; that error
    // still goes back to the caller.
    settle_close(manager.kill_session(id), manager.has_session(id), tree)
}

/// What `close` reports, given how the kill went, whether the shell still
/// runs and how ending its tree went.
fn settle_close(
    killed: Result<(), String>,
    still_running: bool,
    tree: Result<(), String>,
) -> Result<(), String> {
    match killed {
        // The shell exited between the check and the kill: it is closed.
        Err(error) if still_running => Err(error),
        _ => tree,
    }
}

/// Ends every workspace shell with everything it started, at once: used when
/// Zorvo quits, where a delayed escalation would not run. Other sessions are
/// left to the caller. Returns how many shells were ended.
pub fn end_all(manager: &PtySessionManager) -> usize {
    let mut ended = 0;
    for id in manager
        .session_ids()
        .iter()
        .filter(|id| is_workspace_terminal_id(id))
    {
        if let Some(pid) = manager.pid_of(id) {
            if let Err(error) = end_tree(pid, false) {
                eprintln!("Could not end the processes of terminal {id}: {error}");
            }
        }
        if manager.kill_session(id).is_ok() {
            ended += 1;
        }
    }
    ended
}

/// Ends every PTY session: workspace shells with their trees, then the rest.
/// Returns how many sessions were ended.
pub fn end_all_sessions(manager: &PtySessionManager) -> usize {
    end_all(manager) + manager.kill_all()
}

/// The payload of a `workspace-terminal` event: the same shape as a sign-in
/// terminal's.
pub fn event_payload(event: &PtyEvent) -> Value {
    sign_in_event_payload(event)
}

/// The event a PTY session's output goes out on, by its id. Any other id has
/// no listener.
pub fn pty_event_route(id: &str) -> Option<&'static str> {
    if is_sign_in_terminal_id(id) {
        Some(SIGN_IN_TERMINAL_EVENT)
    } else if is_workspace_terminal_id(id) {
        Some(EVENT)
    } else {
        None
    }
}

/// Opens a login shell in one of the user's workspace folders; returns its id.
#[tauri::command(async)]
pub fn workspace_terminal_open(
    store: State<'_, AppStore>,
    pty: State<'_, PtySessionManager>,
    path: String,
) -> Result<String, String> {
    ensure_known_workspace(&path, |p| store.is_known_workspace(p))?;
    let folder = canonical_root(&path)?;
    // A login environment that cannot be read still gives a shell.
    let shell = shell_from(&cached_user_env().unwrap_or_default());
    let id = next_terminal_id();
    start_shell(&pty, &id, &folder, &shell)?;
    Ok(id)
}

/// Ends a workspace shell and everything it started.
#[tauri::command(async)]
pub fn workspace_terminal_close(
    pty: State<'_, PtySessionManager>,
    id: String,
) -> Result<(), String> {
    close(&pty, &id)
}

#[cfg(test)]
mod tests {
    use super::settle_close;

    #[test]
    fn a_shell_that_exited_before_the_kill_is_closed() {
        assert_eq!(
            settle_close(
                Err("Session 'shell-1' not found".to_string()),
                false,
                Ok(())
            ),
            Ok(())
        );
    }

    #[test]
    fn a_kill_that_failed_on_a_running_shell_is_an_error() {
        assert_eq!(
            settle_close(Err("Lock poisoned".to_string()), true, Ok(())),
            Err("Lock poisoned".to_string())
        );
    }

    #[test]
    fn a_tree_that_could_not_be_read_is_still_reported() {
        assert_eq!(
            settle_close(Ok(()), false, Err("ps failed".to_string())),
            Err("ps failed".to_string())
        );
    }
}
