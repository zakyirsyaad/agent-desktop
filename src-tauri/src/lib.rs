pub mod acp;
pub mod changes;
pub mod data_migration;
pub mod env_resolver;
pub mod files;
pub mod fork_handoff;
pub mod git_info;
pub mod profiles;
pub mod pty_session;
pub mod pull_requests;
pub mod spawn_plan;
pub mod store;
pub mod user_profile;
pub mod windows;
pub mod workspace_files;
pub mod workspaces;
pub mod worktrees;

use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

use acp::commands::{event_payload, ACP_EVENT};
use acp::manager::AcpManager;
use profiles::{get_available_agent_profiles, AgentProfile};
use pty_session::{PtyEvent, PtySessionManager};
use spawn_plan::{build_spawn_plan, SpawnOptions};
use store::{AppStore, PersistedState};
use workspaces::{default_workspace_root, list_workspaces_in, Workspace};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
//
// Commands without `async` run on the main thread in Tauri 2. Commands that may
// resolve the login-shell environment or wait on a child process are marked
// `async` so they run on the async runtime and cannot freeze the window.
//
// `send_input` stays sync deliberately. It only enqueues bytes to the session's
// writer thread, which owns the PTY and drains the queue in order, so it never
// blocks on a full PTY input buffer. Marking it `async` would run keystrokes on
// a thread pool, where concurrent calls could reach the PTY out of order.

/// Starts an agent session for a known profile.
///
/// The webview picks a `profile_id` plus [`SpawnOptions`]; it never supplies a
/// command or raw args. The backend resolves the profile, builds a validated
/// plan, and spawns that — so an unknown profile, an undetected CLI, or an
/// option the CLI does not support all fail here instead of reaching a shell.
#[tauri::command(async)]
fn spawn_session(
    _app: AppHandle,
    state: State<'_, PtySessionManager>,
    session_id: String,
    cwd: String,
    profile_id: String,
    options: SpawnOptions,
) -> Result<(), String> {
    let profile = get_available_agent_profiles()
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| format!("Unknown agent profile '{}'", profile_id))?;

    if !profile.detected {
        return Err(format!(
            "{} is not installed ('{}' was not found on PATH)",
            profile.name, profile.command
        ));
    }

    let plan = build_spawn_plan(&profile, &options)?;

    state.start_session(&session_id, &cwd, &plan.command, &plan.args, &plan.env)
}

#[tauri::command]
fn send_input(
    state: State<'_, PtySessionManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state.write_stdin(&session_id, &data)
}

#[tauri::command]
fn resize_session(
    state: State<'_, PtySessionManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&session_id, cols, rows)
}

/// Detects the installed agents. With `refresh`, the login shell's PATH is read
/// afresh first, so an agent installed while the app runs is found.
#[tauri::command(async)]
fn get_agent_profiles(refresh: Option<bool>) -> Result<Vec<AgentProfile>, String> {
    if refresh.unwrap_or(false) {
        // A failed re-read leaves detection on the process PATH; it is not fatal.
        let _ = env_resolver::refresh_user_env();
    }
    Ok(get_available_agent_profiles())
}

/// Lists the project folders under `$HOME/developer` the UI can spawn into.
///
/// Reading the directory touches the filesystem, so this stays off the main thread.
#[tauri::command(async)]
fn list_workspaces() -> Result<Vec<Workspace>, String> {
    match default_workspace_root() {
        Some(root) => Ok(list_workspaces_in(&root)),
        None => Err("HOME is not set, cannot locate workspaces".to_string()),
    }
}

#[tauri::command(async)]
fn terminate_session(
    state: State<'_, PtySessionManager>,
    session_id: String,
) -> Result<(), String> {
    state.kill_session(&session_id)
}

/// Loads the persisted app state, or the default state on a first launch.
///
/// Ends every agent the backend still runs. The UI calls this when it loads:
/// a webview reload leaves the backend (and its agents) running, but the new
/// UI knows none of them and shows their sessions as ended, so they would
/// only linger, holding sessions the UI may resume in a new process.
#[tauri::command]
fn end_orphaned_sessions(
    pty: State<'_, PtySessionManager>,
    acp: State<'_, acp::manager::AcpManager>,
) -> usize {
    pty.kill_all() + acp.stop_all()
}

/// Reads the state file from disk, so it stays off the main thread.
#[tauri::command(async)]
fn load_app_state(store: State<'_, AppStore>) -> Result<PersistedState, String> {
    store.load_state()
}

/// Persists the app state atomically, replacing the previous file.
#[tauri::command(async)]
fn save_app_state(store: State<'_, AppStore>, state: PersistedState) -> Result<(), String> {
    store.save_state(&state)
}

/// Loads a session's chat transcript, empty when the session has no messages yet.
#[tauri::command(async)]
fn load_transcript(
    store: State<'_, AppStore>,
    session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    store.load_transcript(&session_id)
}

/// Saves a session's chat transcript, replacing the previous copy atomically.
#[tauri::command(async)]
fn save_transcript(
    store: State<'_, AppStore>,
    session_id: String,
    messages: Vec<serde_json::Value>,
) -> Result<(), String> {
    store.save_transcript(&session_id, &messages)
}

/// Deletes a session's chat transcript; an already-missing transcript succeeds.
#[tauri::command(async)]
fn delete_transcript(store: State<'_, AppStore>, session_id: String) -> Result<(), String> {
    store.delete_transcript(&session_id)
}

/// Writes a fork handoff document under the app data dir and returns its absolute path.
///
/// The frontend then starts a new session whose first prompt points the agent at it.
#[tauri::command(async)]
fn write_fork_handoff(
    app: AppHandle,
    handoff_id: String,
    content: String,
) -> Result<String, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot locate the app data dir: {e}"))?;
    let path = fork_handoff::write_handoff(&root, &handoff_id, &content)?;
    path.into_os_string()
        .into_string()
        .map_err(|p| format!("Handoff path is not valid UTF-8: {}", p.to_string_lossy()))
}

/// Copies sessions and transcripts from the pre-rename data dir on first launch.
///
/// A failed copy must not stop the app from starting: it opens with empty
/// state and the legacy directory is still there to retry from next launch.
fn migrate_from_legacy_data_dir(data_dir: &std::path::Path) {
    let Some(legacy_dir) = data_migration::legacy_root_for(data_dir) else {
        return;
    };
    if let Err(e) = data_migration::migrate_legacy_data(&legacy_dir, data_dir) {
        eprintln!("Could not copy data from {}: {e}", legacy_dir.display());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_handle_holder: Arc<std::sync::Mutex<Option<AppHandle>>> =
        Arc::new(std::sync::Mutex::new(None));
    let holder_clone = Arc::clone(&app_handle_holder);

    let manager = PtySessionManager::new(Box::new(move |event| {
        if let Ok(guard) = holder_clone.lock() {
            if let Some(app) = guard.as_ref() {
                match event {
                    PtyEvent::Output { session_id, data } => {
                        // Emit to session-specific event channel and global channel
                        let _ = app.emit(&format!("pty-output-{}", session_id), &data);
                        let _ = app.emit(
                            "pty-output",
                            serde_json::json!({
                                "session_id": session_id,
                                "data": data,
                            }),
                        );
                    }
                    PtyEvent::Exit {
                        session_id,
                        exit_code,
                    } => {
                        let _ = app.emit(&format!("pty-exit-{}", session_id), exit_code);
                        let _ = app.emit(
                            "pty-exit",
                            serde_json::json!({
                                "session_id": session_id,
                                "exit_code": exit_code,
                            }),
                        );
                    }
                }
            }
        }
    }));

    let acp_holder = Arc::clone(&app_handle_holder);
    let acp_manager = AcpManager::new(Box::new(move |event| {
        if let Some(app) = acp_holder.lock().ok().and_then(|guard| guard.clone()) {
            let _ = app.emit(ACP_EVENT, event_payload(&event));
        }
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(manager)
        .manage(acp_manager)
        .setup(move |app| {
            if let Ok(mut guard) = app_handle_holder.lock() {
                *guard = Some(app.handle().clone());
            }

            // Persistence lives in the platform app-data directory, which only
            // exists once the app handle does, so the store is built here.
            let data_dir = app.path().app_data_dir().map_err(|e| {
                format!(
                    "Failed to resolve the app data directory for persisted state: {}",
                    e
                )
            })?;
            migrate_from_legacy_data_dir(&data_dir);
            app.manage(AppStore::new(data_dir));

            // Warm the login-shell environment off the main thread so the first
            // session spawn and profile scan do not pay for it.
            std::thread::spawn(|| {
                let _ = env_resolver::cached_user_env();
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_agent_profiles,
            list_workspaces,
            spawn_session,
            send_input,
            resize_session,
            terminate_session,
            end_orphaned_sessions,
            load_app_state,
            save_app_state,
            load_transcript,
            save_transcript,
            delete_transcript,
            windows::open_session_window,
            windows::reveal_in_finder,
            windows::open_external_url,
            files::list_directory,
            files::open_path,
            files::remember_workspace,
            workspace_files::workspace_files,
            git_info::workspace_details,
            pull_requests::session_pull_request,
            pull_requests::repo_pull_requests,
            changes::session_changes,
            changes::session_file_diff,
            changes::commit_session_changes,
            worktrees::create_session_worktree,
            worktrees::remove_session_worktree,
            user_profile::get_user_profile,
            write_fork_handoff,
            acp::commands::acp_start_session,
            acp::commands::acp_load_session,
            acp::commands::acp_authenticate,
            acp::commands::acp_fork_session,
            acp::commands::acp_prompt,
            acp::commands::acp_cancel,
            acp::commands::acp_respond_permission,
            acp::commands::acp_set_mode,
            acp::commands::acp_set_config_option,
            acp::commands::acp_stop_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
