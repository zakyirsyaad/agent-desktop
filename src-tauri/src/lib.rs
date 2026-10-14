pub mod env_resolver;
pub mod profiles;
pub mod pty_session;

use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use profiles::{get_available_agent_profiles, AgentProfile};
use pty_session::{PtyEvent, PtySessionManager};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
//
// Commands without `async` run on the main thread in Tauri 2. Commands that may
// resolve the login-shell environment or wait on a child process are marked
// `async` so they run on the async runtime and cannot freeze the window.

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command(async)]
fn spawn_session(
    _app: AppHandle,
    state: State<'_, PtySessionManager>,
    session_id: String,
    cwd: String,
    command: String,
    args: Vec<String>,
) -> Result<(), String> {
    state.start_session(&session_id, &cwd, &command, &args)
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

#[tauri::command(async)]
fn get_agent_profiles() -> Result<Vec<AgentProfile>, String> {
    Ok(get_available_agent_profiles())
}

#[tauri::command(async)]
fn terminate_session(
    state: State<'_, PtySessionManager>,
    session_id: String,
) -> Result<(), String> {
    state.kill_session(&session_id)
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

    tauri::Builder::default()
        .manage(manager)
        .setup(move |app| {
            if let Ok(mut guard) = app_handle_holder.lock() {
                *guard = Some(app.handle().clone());
            }
            // Warm the login-shell environment off the main thread so the first
            // session spawn and profile scan do not pay for it.
            std::thread::spawn(|| {
                let _ = env_resolver::cached_user_env();
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_agent_profiles,
            spawn_session,
            send_input,
            resize_session,
            terminate_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
