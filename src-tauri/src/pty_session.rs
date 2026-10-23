use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
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
    /// Sends stdin bytes to the session's dedicated writer thread. A single
    /// thread owns the PTY writer so concurrent `write_stdin` calls stay in
    /// submission order, and callers never block on a full PTY input buffer.
    input_tx: std::sync::mpsc::Sender<Vec<u8>>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    /// The process id, read once at spawn. The reader thread holds `child`'s
    /// lock while it waits for the process to end, so asking `child` for it
    /// later could block.
    pid: Option<u32>,
}

/// Rejects a working directory that is relative or does not exist.
///
/// `portable-pty` silently falls back to `$HOME` when the requested cwd is not a
/// directory, which would start the agent in the wrong project without any error.
pub(crate) fn validate_cwd(cwd: &str) -> Result<(), String> {
    let path = Path::new(cwd);
    if !path.is_absolute() {
        return Err(format!(
            "Working directory must be an absolute path, got '{}'",
            cwd
        ));
    }
    if !path.is_dir() {
        return Err(format!(
            "Working directory '{}' is not an existing directory",
            cwd
        ));
    }
    Ok(())
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
    /// via `crate::env_resolver::cached_user_env()`.
    ///
    /// `extra_env` is applied after the user environment and before `TERM`, so a
    /// spawn plan can override an inherited value while `TERM` stays fixed.
    ///
    /// A background thread is spawned to read output chunks and dispatch `PtyEvent::Output`.
    /// When the process terminates or output closes, `PtyEvent::Exit` is dispatched.
    pub fn start_session(
        &self,
        session_id: &str,
        cwd: &str,
        command: &str,
        args: &[String],
        extra_env: &[(String, String)],
    ) -> Result<(), String> {
        validate_cwd(cwd)?;

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
        if let Ok(env_vars) = crate::env_resolver::cached_user_env() {
            for (k, v) in env_vars {
                cmd.env(k, v);
            }
        }

        // Plan-derived variables win over the inherited environment.
        for (k, v) in extra_env {
            cmd.env(k, v);
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

        let pid = child.process_id();
        let shared_child = Arc::new(Mutex::new(child));

        // One writer thread per session owns the PTY writer. `write_stdin` only
        // enqueues bytes, so a full PTY input buffer stalls this thread instead
        // of the caller (which for a sync Tauri command is the main thread).
        let (input_tx, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();

        thread::Builder::new()
            .name(format!("pty-writer-{}", session_id))
            .spawn(move || {
                let mut writer = writer;
                // Ends when every sender is dropped, i.e. the session is gone.
                while let Ok(chunk) = input_rx.recv() {
                    if writer.write_all(&chunk).is_err() {
                        break;
                    }
                    if writer.flush().is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| format!("Failed to spawn writer thread: {}", e))?;

        let handle = SessionHandle {
            master: pair.master,
            input_tx,
            child: Arc::clone(&shared_child),
            pid,
        };

        {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|e| format!("Lock poisoned: {}", e))?;
            // Checked under the same lock as the insert: replacing a running
            // session would orphan its process.
            if sessions.contains_key(session_id) {
                drop(sessions);
                if let Ok(mut child) = shared_child.lock() {
                    let _ = child.kill();
                    // No reader thread waits on this one: reap it here.
                    let _ = child.wait();
                }
                return Err(format!("Session '{}' is already running", session_id));
            }
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
                            let (valid_bytes, remaining_bytes) =
                                match std::str::from_utf8(&buf[..total]) {
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

    /// Queues data for the session's stdin.
    ///
    /// The bytes are handed to the session's writer thread over a channel, so
    /// they reach the PTY in submission order and this call never blocks on the
    /// PTY, even when the child is busy and its input buffer is full.
    pub fn write_stdin(&self, session_id: &str, data: &str) -> Result<(), String> {
        let input_tx = {
            let sessions = self
                .sessions
                .lock()
                .map_err(|e| format!("Lock poisoned: {}", e))?;
            let handle = sessions
                .get(session_id)
                .ok_or_else(|| format!("Session '{}' not found", session_id))?;
            handle.input_tx.clone()
        };

        input_tx
            .send(data.as_bytes().to_vec())
            .map_err(|_| format!("Session '{}' input is closed", session_id))?;

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

    /// Kills every running session; returns how many there were.
    pub fn kill_all(&self) -> usize {
        let ids: Vec<String> = self
            .sessions
            .lock()
            .map(|sessions| sessions.keys().cloned().collect())
            .unwrap_or_default();
        ids.iter()
            .filter(|id| self.kill_session(id).is_ok())
            .count()
    }

    /// The pid of a running session's process, if it has one.
    pub fn pid_of(&self, session_id: &str) -> Option<u32> {
        let sessions = self.sessions.lock().ok()?;
        sessions.get(session_id)?.pid
    }

    /// The ids of the running sessions, in no particular order.
    pub fn session_ids(&self) -> Vec<String> {
        self.sessions
            .lock()
            .map(|sessions| sessions.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Whether a session with this id is running.
    pub fn has_session(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .map(|sessions| sessions.contains_key(session_id))
            .unwrap_or(false)
    }

    /// Kills the running child process and cleans up the session.
    pub fn kill_session(&self, session_id: &str) -> Result<(), String> {
        if self.kill_session_if_present(session_id)? {
            Ok(())
        } else {
            Err(format!("Session '{}' not found", session_id))
        }
    }

    /// Like `kill_session`, but a session that is already gone (its process
    /// exited and the reader thread removed it) is `Ok(false)`, not an error.
    /// `Err` means the kill could not run at all.
    pub fn kill_session_if_present(&self, session_id: &str) -> Result<bool, String> {
        let handle = {
            let mut sessions = self
                .sessions
                .lock()
                .map_err(|e| format!("Lock poisoned: {}", e))?;
            sessions.remove(session_id)
        };

        let Some(handle) = handle else {
            return Ok(false);
        };
        if let Ok(mut child) = handle.child.lock() {
            let _ = child.kill();
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::PtySessionManager;
    use std::sync::mpsc;
    use std::time::Duration;

    /// A session that is already gone is not an error to `kill_session_if_present`:
    /// `Ok(false)` tells it apart from a kill that could not run at all.
    #[test]
    fn kill_session_if_present_tells_a_gone_session_from_a_failure() {
        let manager = PtySessionManager::default_manager();
        let cwd = std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string();
        manager
            .start_session("present", &cwd, "/bin/cat", &[], &[])
            .expect("start");

        assert_eq!(manager.kill_session_if_present("present"), Ok(true));
        assert!(!manager.has_session("present"));
        assert_eq!(manager.kill_session_if_present("present"), Ok(false));
    }

    /// A poisoned sessions lock is a real failure: closing a workspace shell
    /// reports it instead of saying the shell was closed.
    #[test]
    fn closing_a_shell_reports_a_poisoned_sessions_lock() {
        let manager = PtySessionManager::default_manager();
        let poisoner = manager.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.sessions.lock().unwrap();
            panic!("poison the sessions lock");
        })
        .join();

        assert!(manager.kill_session_if_present("shell-1").is_err());
        assert!(crate::workspace_terminal::close(&manager, "shell-1").is_err());
    }

    /// The reader thread holds a child's lock while it waits for the process to
    /// end; `pid_of` must not queue behind it, because it holds the sessions
    /// lock that every other session call needs.
    #[test]
    fn pid_of_does_not_wait_for_the_child_lock() {
        let manager = PtySessionManager::default_manager();
        let cwd = std::env::current_dir()
            .unwrap()
            .to_string_lossy()
            .to_string();
        manager
            .start_session("pid-lock", &cwd, "/bin/cat", &[], &[])
            .expect("start");
        let child = manager.sessions.lock().unwrap()["pid-lock"].child.clone();
        let (held_tx, held_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            let _waiting = child.lock().unwrap();
            held_tx.send(()).unwrap();
            let _ = release_rx.recv_timeout(Duration::from_secs(5));
        });
        held_rx.recv().unwrap();

        let (tx, rx) = mpsc::channel();
        let asking = manager.clone();
        std::thread::spawn(move || {
            let _ = tx.send(asking.pid_of("pid-lock"));
        });
        let pid = rx.recv_timeout(Duration::from_secs(1));

        release_tx.send(()).unwrap();
        holder.join().unwrap();
        manager.kill_session("pid-lock").expect("kill");
        assert!(pid
            .expect("pid_of blocked on the child's lock")
            .is_some_and(|pid| pid > 0));
    }
}
