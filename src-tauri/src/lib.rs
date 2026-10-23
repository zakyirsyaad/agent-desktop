pub mod acp;
pub mod appearance;
pub mod attachments;
pub mod background_processes;
pub mod branches;
pub mod changes;
pub mod data_migration;
pub mod diff_stats;
pub mod env_resolver;
pub mod files;
pub mod fork_handoff;
pub mod git_info;
pub mod installer;
pub mod profiles;
pub mod pty_session;
pub mod pull_requests;
pub mod registry;
pub mod store;
pub mod user_profile;
pub mod windows;
pub mod workspace_files;
pub mod workspace_terminal;
pub mod workspaces;
pub mod worktrees;

use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

use acp::commands::{event_payload, ACP_EVENT};
use acp::manager::AcpManager;
use acp::terminal_auth::{sign_in_event_payload, SIGN_IN_TERMINAL_EVENT};
use installer::commands::{clean_up_at_start, versions_in_use, AppInstaller};
use installer::layout::ToolsDir;
use profiles::{agent_profiles, AgentProfile};
use pty_session::{PtyEvent, PtySessionManager};
use registry::{Catalog, AGENT_PROFILES_CHANGED};
use store::{AppStore, PersistedState};
use workspace_terminal::{event_payload as workspace_terminal_payload, pty_event_route};
use workspaces::{default_workspace_root, list_workspaces_in, Workspace};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
//
// Commands without `async` run on the main thread in Tauri 2. Commands that may
// resolve the login-shell environment or wait on a child process are marked
// `async` so they run on the async runtime and cannot freeze the window.
//
// `send_input` stays sync deliberately. It only enqueues a sign-in terminal's
// keystrokes to the PTY's writer thread, which drains the queue in order, so it
// never blocks on a full PTY input buffer. Marking it `async` would run
// keystrokes on a thread pool, where concurrent calls could reach the PTY out
// of order.

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

/// The agents the app can run, at the versions the user has in use. With
/// `refresh`, the login shell's PATH and the global npm packages are read
/// afresh and the registry is refetched, so an agent installed or published
/// while the app runs is found. A failed fetch keeps the cached catalog.
#[tauri::command(async)]
fn get_agent_profiles(
    store: State<'_, AppStore>,
    refresh: Option<bool>,
) -> Result<Vec<AgentProfile>, String> {
    if refresh.unwrap_or(false) {
        // A failed re-read leaves detection on the process PATH; it is not fatal.
        let env = env_resolver::refresh_user_env().unwrap_or_else(|error| {
            eprintln!("Could not re-read the login shell environment: {error}");
            Default::default()
        });
        registry::refresh_catalog(registry::catalog(), &env, true);
    }
    Ok(agent_profiles(&versions_in_use(&store)))
}

/// Every agent in the registry with where it stands on this Mac, for the
/// catalog screen. Unlike the profiles it includes agents that are waiting out
/// the seven-day wait or have no build for this Mac.
#[tauri::command(async)]
fn get_agent_catalog(
    store: State<'_, AppStore>,
) -> Result<registry::catalog_view::AgentCatalog, String> {
    let versions = versions_in_use(&store);
    Ok(profiles::with_system_tools(|catalog, tools| {
        catalog.catalog_view(tools, &versions, registry::unix_now())
    }))
}

/// The agents' logos as `{id: data URL}` (SVG). The webview makes no network
/// requests, so the backend caches them from the registry CDN and ships a copy.
#[tauri::command(async)]
fn get_agent_icons() -> std::collections::BTreeMap<String, String> {
    registry::catalog().icon_data_urls()
}

/// Reads the global npm packages and, when the last fetch is a day old,
/// the registry, on its own thread so startup never waits on `npm` or the
/// network. The UI is told to reload its profiles only when they changed.
/// Then deletes the installs no enabled agent uses any more.
fn refresh_catalog_in_background(app: AppHandle) {
    std::thread::spawn(move || {
        // Also warms the login-shell environment for the first session spawn.
        let env = env_resolver::cached_user_env().unwrap_or_else(|error| {
            eprintln!("Could not read the login shell environment: {error}");
            Default::default()
        });
        if registry::refresh_catalog(registry::catalog(), &env, false) {
            let _ = app.emit(AGENT_PROFILES_CHANGED, ());
        }
        clean_up_at_start(&app);
    });
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
    let root = app_data_dir(&app).map_err(|e| format!("Cannot locate the app data dir: {e}"))?;
    let path = fork_handoff::write_handoff(&root, &handoff_id, &content)?;
    path.into_os_string()
        .into_string()
        .map_err(|p| format!("Handoff path is not valid UTF-8: {}", p.to_string_lossy()))
}

/// The app's data dir; a debug build (`pnpm tauri dev`) gets its own, so
/// testing never writes the installed app's sessions.
fn app_data_dir(app: &AppHandle) -> tauri::Result<std::path::PathBuf> {
    let base = app.path().app_data_dir()?;
    Ok(store::data_dir_for(&base, cfg!(debug_assertions)))
}

/// Tells the user that their Agent Desktop sessions were not brought over.
///
/// A failed copy must not stop the app from starting, but a Finder-launched
/// app has no visible stderr, so the error is shown in a native dialog.
fn report_migration_failure(app: &AppHandle, error: &str) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    eprintln!("Could not copy data from Agent Desktop: {error}");
    app.dialog()
        .message(format!(
            "Zorvo could not bring over your sessions from Agent Desktop. \
             It will try again the next time it opens.\n\n{error}"
        ))
        .title("Sessions not copied")
        .kind(MessageDialogKind::Warning)
        .show(|_| {});
}

/// WKWebView turns `--flag` into an en dash and straight quotes into curly
/// ones unless the app's defaults say otherwise.
#[cfg(target_os = "macos")]
const WEB_TEXT_SUBSTITUTION_KEYS: [&str; 4] = [
    "WebAutomaticDashSubstitutionEnabled",
    "WebAutomaticQuoteSubstitutionEnabled",
    "WebAutomaticTextReplacementEnabled",
    "WebAutomaticSpellingCorrectionEnabled",
];

/// Registers the WebView text-substitution defaults as off for the whole app.
#[cfg(target_os = "macos")]
fn disable_web_text_substitutions() {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSDictionary, NSNumber, NSString, NSUserDefaults};

    let keys: Vec<Retained<NSString>> = WEB_TEXT_SUBSTITUTION_KEYS
        .iter()
        .map(|key| NSString::from_str(key))
        .collect();
    let values: Vec<Retained<AnyObject>> = keys
        .iter()
        .map(|_| Retained::from(NSNumber::new_bool(false)))
        .collect();
    let key_refs: Vec<&NSString> = keys.iter().map(|key| &**key).collect();
    let value_refs: Vec<&AnyObject> = values.iter().map(|value| &**value).collect();
    let registration = NSDictionary::<NSString, AnyObject>::from_slices(&key_refs, &value_refs);

    // SAFETY: the dictionary is keyed by NSString and holds objects, as the
    // method requires; registered values are never written to the user's defaults.
    unsafe { NSUserDefaults::standardUserDefaults().registerDefaults(&registration) };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    disable_web_text_substitutions();

    let app_handle_holder: Arc<std::sync::Mutex<Option<AppHandle>>> =
        Arc::new(std::sync::Mutex::new(None));
    let holder_clone = Arc::clone(&app_handle_holder);

    let manager = PtySessionManager::new(Box::new(move |event| {
        if let Ok(guard) = holder_clone.lock() {
            if let Some(app) = guard.as_ref() {
                let session_id = match &event {
                    PtyEvent::Output { session_id, .. } | PtyEvent::Exit { session_id, .. } => {
                        session_id
                    }
                };
                // Only sign-in terminals and workspace shells start a PTY; any
                // other id has no listener.
                match pty_event_route(session_id) {
                    Some(SIGN_IN_TERMINAL_EVENT) => {
                        let _ = app.emit(SIGN_IN_TERMINAL_EVENT, sign_in_event_payload(&event));
                    }
                    Some(channel) => {
                        let _ = app.emit(channel, workspace_terminal_payload(&event));
                    }
                    None => {}
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
            let data_dir = app_data_dir(app.handle()).map_err(|e| {
                format!(
                    "Failed to resolve the app data directory for persisted state: {}",
                    e
                )
            })?;
            // Before anything resolves a profile, so Zorvo's installs are seen.
            installer::set_tools_dir(ToolsDir::new(&data_dir));
            app.manage(AppInstaller::new(ToolsDir::new(&data_dir)));
            // Reads two small files; fetching and `npm` wait for the thread below.
            registry::install(Catalog::open(data_dir.clone(), registry::BUNDLED_HISTORY));
            let (store, migration) = data_migration::open_store(data_dir);
            app.manage(store);
            if let Err(error) = migration {
                report_migration_failure(app.handle(), &error);
            }

            // Apply the saved appearance before any window content is shown. A
            // load error leaves the system theme; the UI reports load failures.
            if let Ok(state) = app.state::<store::AppStore>().load_state() {
                app.handle()
                    .set_theme(appearance::theme_for(&state.settings.appearance));
            }

            refresh_catalog_in_background(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_agent_profiles,
            get_agent_catalog,
            get_agent_icons,
            list_workspaces,
            send_input,
            workspace_terminal::workspace_terminal_open,
            workspace_terminal::workspace_terminal_close,
            resize_session,
            terminate_session,
            end_orphaned_sessions,
            background_processes::background_processes,
            background_processes::stop_background_process,
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
            attachments::attachment_preview,
            workspace_files::workspace_files,
            git_info::workspace_details,
            branches::list_branches,
            branches::switch_branch,
            pull_requests::session_pull_request,
            pull_requests::repo_pull_requests,
            changes::session_changes,
            changes::session_file_diff,
            diff_stats::session_diff_targets,
            diff_stats::session_diff_stats,
            changes::commit_session_changes,
            worktrees::create_session_worktree,
            worktrees::remove_session_worktree,
            user_profile::get_user_profile,
            write_fork_handoff,
            acp::commands::acp_start_session,
            acp::commands::acp_reopen_session,
            acp::commands::acp_import_session,
            acp::commands::acp_list_sessions,
            acp::commands::acp_authenticate,
            acp::commands::acp_probe_agent,
            acp::commands::acp_fork_session,
            acp::commands::acp_start_terminal_sign_in,
            acp::commands::acp_cancel_terminal_sign_in,
            acp::commands::acp_prompt,
            acp::commands::acp_cancel,
            acp::commands::acp_respond_permission,
            acp::commands::acp_respond_elicitation,
            acp::commands::acp_reopen_elicitation_url,
            acp::commands::acp_set_mode,
            acp::commands::acp_set_config_option,
            acp::commands::acp_stop_session,
            installer::commands::install_agent,
            installer::commands::update_agent,
            installer::commands::install_runtime,
            installer::commands::cancel_agent_install,
            installer::commands::remove_agent_install
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Workspace shells go with their whole process tree, so a `nohup`ed
            // job they started does not outlive Zorvo; other sessions are only killed.
            if let tauri::RunEvent::Exit = event {
                let pty = app.state::<PtySessionManager>();
                workspace_terminal::end_all(&pty);
                pty.kill_all();
            }
        });
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{disable_web_text_substitutions, WEB_TEXT_SUBSTITUTION_KEYS};
    use objc2_foundation::{NSNumber, NSString, NSUserDefaults};

    #[test]
    fn web_view_text_substitutions_are_registered_off() {
        disable_web_text_substitutions();

        let defaults = NSUserDefaults::standardUserDefaults();
        for key in WEB_TEXT_SUBSTITUTION_KEYS {
            let value = defaults.objectForKey(&NSString::from_str(key));
            let is_false = value
                .and_then(|value| value.downcast::<NSNumber>().ok())
                .map(|number| number.boolValue());
            assert_eq!(is_false, Some(false), "{key} should be registered as false");
        }
    }
}
