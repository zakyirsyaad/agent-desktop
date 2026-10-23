//! A login shell in one of the user's workspace folders, shown as a terminal tab.
//!
//! The webview sends only a folder; the shell, its arguments and its
//! environment are chosen here. Input and resize go through the PTY layer's
//! `send_input` and `resize_session`. Nothing here logs a shell's input or output.

use std::collections::HashMap;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::acp::terminal_auth::{is_sign_in_terminal_id, sign_in_event_payload};
use crate::background_processes::{end_tree, end_trees};
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

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    path.is_absolute()
        && path
            .metadata()
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

/// Without Unix permission bits there is no executable flag to check.
#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_absolute() && path.is_file()
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
/// removed it), which is not an error; a kill that could not run at all is.
pub fn close(manager: &PtySessionManager, id: &str) -> Result<(), String> {
    if !is_workspace_terminal_id(id) {
        return Err("That is not a workspace terminal".to_string());
    }
    let tree = manager.pid_of(id).map_or(Ok(()), |pid| end_tree(pid, true));
    // The shell is ended even when its tree could not be read; that error
    // still goes back to the caller.
    manager.kill_session_if_present(id)?;
    tree
}

/// Ends every workspace shell with everything it started, at once: used when
/// Zorvo quits, where a delayed escalation would not run. Other sessions are
/// left to the caller. Returns how many shells were ended.
pub fn end_all(manager: &PtySessionManager) -> usize {
    let ids: Vec<String> = manager
        .session_ids()
        .into_iter()
        .filter(|id| is_workspace_terminal_id(id))
        .collect();
    // One read of the processes for every shell, however many there are.
    let pids: Vec<u32> = ids.iter().filter_map(|id| manager.pid_of(id)).collect();
    if let Err(error) = end_trees(&pids) {
        eprintln!("Could not end the processes of the terminals: {error}");
    }
    // A shell the KILL already ended may have been removed by its reader
    // thread by now; it was still ended here, so it counts.
    ids.iter()
        .filter(|id| manager.kill_session_if_present(id).is_ok())
        .count()
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

/// Which listener a PTY session's output and exit go to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyRoute {
    /// An agent's terminal sign-in, on `SIGN_IN_TERMINAL_EVENT`.
    SignIn,
    /// A workspace shell, on `EVENT`.
    Workspace,
}

/// Where a PTY session's events go, by its id. Any other id has no listener.
pub fn pty_event_route(id: &str) -> Option<PtyRoute> {
    if is_sign_in_terminal_id(id) {
        Some(PtyRoute::SignIn)
    } else if is_workspace_terminal_id(id) {
        Some(PtyRoute::Workspace)
    } else {
        None
    }
}

/// A shell that was started: its id, and the folder it runs in as the backend
/// resolved it (symlinks followed), which is how the UI keys the shell's tab.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedTerminal {
    pub id: String,
    pub folder: String,
}

/// Starts a login shell in `folder`, resolved to its canonical path, with the
/// shell from the login environment `env`.
pub fn open_shell(
    manager: &PtySessionManager,
    folder: &Path,
    env: &HashMap<String, String>,
) -> Result<OpenedTerminal, String> {
    let folder = folder
        .to_str()
        .ok_or_else(|| format!("Folder {} is not valid UTF-8", folder.display()))?;
    let folder = canonical_root(folder)?;
    let id = next_terminal_id();
    start_shell(manager, &id, &folder, &shell_from(env))?;
    Ok(OpenedTerminal {
        id,
        folder: folder.to_string_lossy().into_owned(),
    })
}

/// Opens a login shell in one of the user's workspace folders; returns its id
/// and the canonical folder it runs in.
#[tauri::command(async)]
pub fn workspace_terminal_open(
    store: State<'_, AppStore>,
    pty: State<'_, PtySessionManager>,
    path: String,
) -> Result<OpenedTerminal, String> {
    // The shell starts in the very folder that was checked, not in a second
    // resolution of `path` that a repointed symlink could send elsewhere.
    let mut checked = None;
    ensure_known_workspace(&path, |canonical| {
        checked = Some(canonical.to_path_buf());
        store.is_known_workspace(canonical)
    })?;
    let folder = checked.ok_or_else(|| format!("{path} is not one of your workspaces"))?;
    // A login environment that cannot be read still gives a shell.
    open_shell(&pty, &folder, &cached_user_env().unwrap_or_default())
}

/// Ends a workspace shell and everything it started.
#[tauri::command(async)]
pub fn workspace_terminal_close(
    pty: State<'_, PtySessionManager>,
    id: String,
) -> Result<(), String> {
    close(&pty, &id)
}
