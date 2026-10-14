use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};

/// Events produced by PTY sessions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum PtyEvent {
    #[serde(rename = "output")]
    Output { session_id: String, data: String },
    #[serde(rename = "exit")]
    Exit { session_id: String, exit_code: u32 },
}

/// Type alias for event broadcaster callback.
pub type EventCallback = Box<dyn Fn(PtyEvent) + Send + Sync + 'static>;

/// Internal handle for an active PTY session.
struct SessionHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

/// Thread-safe manager for PTY sessions.
#[derive(Clone)]
pub struct PtySessionManager {
    sessions: Arc<Mutex<HashMap<String, SessionHandle>>>,
    on_event: Option<Arc<EventCallback>>,
}

impl PtySessionManager {
    /// Creates a new `PtySessionManager` with an optional event callback.
    pub fn new(on_event: EventCallback) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            on_event: Some(Arc::new(on_event)),
        }
    }

    /// Creates an empty `PtySessionManager` without event callback (callback can be set or Tauri events used).
    pub fn default_manager() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            on_event: None,
        }
    }

    /// Starts a new PTY session.
    ///
    /// Spawns `command` with `args` in `cwd`, inheriting the user's authentic shell environment
    /// via `crate::env_resolver::resolve_user_env()`.
    ///
    /// A background thread is spawned to read output chunks and dispatch `PtyEvent::Output`.
    /// When the process terminates or output closes, `PtyEvent::Exit` is dispatched.
    pub fn start_session(
        &self,
        session_id: &str,
        cwd: &str,
        command: &str,
        args: &[String],
    ) -> Result<(), String> {
        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY pair: {}", e))?;

        let mut cmd = CommandBuilder::new(command);
        cmd.args(args);
        cmd.cwd(cwd);

        // Inherit authentic user environment variables (PATH, HOME, etc.)
        if let Ok(env_vars) = crate::env_resolver::resolve_user_env() {
            for (k, v) in env_vars {
                cmd.env(k, v);
            }
        }

        // Set TERM if not already specified
        cmd.env("TERM", "xterm-256color");

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn command '{}': {}", command, e))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take PTY writer: {}", e))?;

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone PTY reader: {}", e))?;

        let shared_child = Arc::new(Mutex::new(child));
        let shared_writer = Arc::new(Mutex::new(writer));

        let handle = SessionHandle {
            master: pair.master,
            writer: Arc::clone(&shared_writer),
            child: Arc::clone(&shared_child),
        };

        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|e| format!("Lock poisoned: {}", e))?;
            sessions.insert(session_id.to_string(), handle);
        }

        // Spawn background reader thread
        let reader_sid = session_id.to_string();
        let child_for_wait = Arc::clone(&shared_child);
        let sessions_for_cleanup = Arc::clone(&self.sessions);
        let callback_opt = self.on_event.clone();

        thread::Builder::new()
            .name(format!("pty-reader-{}", session_id))
            .spawn(move || {
                let mut reader = reader;
                let mut buf = [0u8; 4096];
                let mut leftover_len = 0usize;

                loop {
                    // Read into buffer starting after any leftover bytes
                    match reader.read(&mut buf[leftover_len..]) {
                        Ok(0) => {
                            // Stream closed, flush any remaining bytes lossily
                            if leftover_len > 0 {
                                let text =
                                    String::from_utf8_lossy(&buf[..leftover_len]).to_string();
                                if let Some(cb) = &callback_opt {
                                    cb(PtyEvent::Output {
                                        session_id: reader_sid.clone(),
                                        data: text,
                                    });
                                }
                            }
                            break;
                        }
                        Ok(n) => {
                            let total = leftover_len + n;
                            let (valid_bytes, remaining_bytes) = match std::str::from_utf8(&buf[..total]) {
                                Ok(_) => (total, 0),
                                Err(e) => {
                                    let valid_up_to = e.valid_up_to();
                                    if e.error_len().is_none() {
                                        // Incomplete UTF-8 sequence at the end of the buffer
                                        let rem = total - valid_up_to;
                                        (valid_up_to, rem)
                                    } else {
                                        // Invalid byte sequence encountered; flush whole buffer lossily
                                        (total, 0)
                                    }
                                }
                            };

                            if valid_bytes > 0 {
                                let text = String::from_utf8_lossy(&buf[..valid_bytes]).to_string();
                                if let Some(cb) = &callback_opt {
                                    cb(PtyEvent::Output {
                                        session_id: reader_sid.clone(),
                                        data: text,
                                    });
                                }
                            }

                            if remaining_bytes > 0 {
                                buf.copy_within(valid_bytes..total, 0);
                                leftover_len = remaining_bytes;
                            } else {
                                leftover_len = 0;
                            }
                        }
                        Err(_) => {
                            // On read error, flush any remaining bytes lossily
                            if leftover_len > 0 {
                                let text =
                                    String::from_utf8_lossy(&buf[..leftover_len]).to_string();
                                if let Some(cb) = &callback_opt {
                                    cb(PtyEvent::Output {
                                        session_id: reader_sid.clone(),
                                        data: text,
                                    });
                                }
                            }
                            break;
                        }
                    }
                }

                // Process exited or reader stream closed
                let exit_code = match child_for_wait.lock() {
                    Ok(mut ch) => match ch.wait() {
                        Ok(status) => status.exit_code(),
                        Err(_) => 1,
                    },
                    Err(_) => 1,
                };

                // Dispatch exit event
                if let Some(cb) = &callback_opt {
                    cb(PtyEvent::Exit {
                        session_id: reader_sid.clone(),
                        exit_code,
                    });
                }

                // Clean up session handle from map
                if let Ok(mut sessions) = sessions_for_cleanup.lock() {
                    sessions.remove(&reader_sid);
                }
            })
            .map_err(|e| format!("Failed to spawn reader thread: {}", e))?;

        Ok(())
    }

    /// Writes data to the session's stdin.
    pub fn write_stdin(&self, session_id: &str, data: &str) -> Result<(), String> {
        let writer = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|e| format!("Lock poisoned: {}", e))?;
            let handle = sessions
                .get(session_id)
                .ok_or_else(|| format!("Session '{}' not found", session_id))?;
            Arc::clone(&handle.writer)
        };

        let mut writer_guard = writer
            .lock()
            .map_err(|e| format!("Writer lock poisoned: {}", e))?;
        writer_guard
            .write_all(data.as_bytes())
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;
        writer_guard
            .flush()
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;

        Ok(())
    }

    /// Resizes the PTY terminal window.
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| format!("Session '{}' not found", session_id))?;

        handle
            .master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to resize PTY: {}", e))?;

        Ok(())
    }

    /// Kills the running child process and cleans up the session.
    pub fn kill_session(&self, session_id: &str) -> Result<(), String> {
        let handle = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|e| format!("Lock poisoned: {}", e))?;
            sessions.remove(session_id)
        };

        if let Some(handle) = handle {
            if let Ok(mut child) = handle.child.lock() {
                let _ = child.kill();
            }
            Ok(())
        } else {
            Err(format!("Session '{}' not found", session_id))
        }
    }
}
