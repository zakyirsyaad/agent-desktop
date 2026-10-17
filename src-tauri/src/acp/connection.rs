//! One running ACP agent process and the JSON-RPC traffic with it.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{json, Value};

use super::jsonrpc::{self, Incoming};

/// Lines of the agent's stderr kept for error messages.
const STDERR_TAIL_LINES: usize = 40;
/// How often the reader checks whether the agent has exited after stdout closed.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// What the reader thread reports besides responses to our own requests.
#[derive(Debug, Clone)]
pub enum ConnectionEvent {
    Notification {
        method: String,
        params: Value,
    },
    /// The agent asks us something and waits for `respond`.
    Request {
        id: Value,
        method: String,
        params: Value,
    },
    Exited {
        code: Option<i32>,
    },
}

pub type EventSink = Arc<dyn Fn(ConnectionEvent) + Send + Sync>;
type ResponseHandler = Box<dyn FnOnce(Result<Value, Value>) + Send>;

/// A spawned agent speaking newline-delimited JSON-RPC on stdin/stdout.
pub struct AcpConnection {
    stdin: Mutex<ChildStdin>,
    /// Shared with the reader thread, which reaps the process once it exits.
    child: Arc<Mutex<Child>>,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, ResponseHandler>>>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

impl AcpConnection {
    /// Starts the agent. Its stdout is read on a background thread; every
    /// message that is not a response to us goes to `sink`.
    pub fn spawn(
        program: &str,
        args: &[String],
        cwd: &str,
        env: &[(String, String)],
        sink: EventSink,
    ) -> Result<Arc<Self>, String> {
        let mut child = Command::new(program)
            .args(args)
            .current_dir(cwd)
            .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start agent '{}': {}", program, e))?;

        let stdin = child
            .stdin
            .take()
            .ok_or("Failed to open the agent's stdin")?;
        let stdout = child
            .stdout
            .take()
            .ok_or("Failed to open the agent's stdout")?;
        let stderr = child
            .stderr
            .take()
            .ok_or("Failed to open the agent's stderr")?;

        let connection = Arc::new(Self {
            stdin: Mutex::new(stdin),
            child: Arc::new(Mutex::new(child)),
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            stderr_tail: Arc::new(Mutex::new(VecDeque::new())),
        });

        connection.spawn_stderr_reader(stderr);
        connection.spawn_stdout_reader(stdout, sink);
        Ok(connection)
    }

    fn spawn_stderr_reader(&self, stderr: impl std::io::Read + Send + 'static) {
        let tail = Arc::clone(&self.stderr_tail);
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Ok(mut tail) = tail.lock() {
                    if tail.len() == STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            }
        });
    }

    fn spawn_stdout_reader(&self, stdout: impl std::io::Read + Send + 'static, sink: EventSink) {
        let pending = Arc::clone(&self.pending);
        let child = Arc::clone(&self.child);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                match jsonrpc::parse_incoming(&line) {
                    Ok(Incoming::Response { id, result }) => {
                        let handler = pending.lock().ok().and_then(|mut p| p.remove(&id));
                        if let Some(handler) = handler {
                            handler(result);
                        }
                    }
                    Ok(Incoming::Request { id, method, params }) => {
                        sink(ConnectionEvent::Request { id, method, params })
                    }
                    Ok(Incoming::Notification { method, params }) => {
                        sink(ConnectionEvent::Notification { method, params })
                    }
                    // Not a routable JSON-RPC message (e.g. a stray log line): skip it.
                    Err(_) => {}
                }
            }

            // stdout closed: the agent is gone. Fail every request still waiting.
            let waiting: Vec<ResponseHandler> = pending
                .lock()
                .map(|mut p| p.drain().map(|(_, h)| h).collect())
                .unwrap_or_default();
            for handler in waiting {
                handler(Err(
                    json!({ "message": "The agent exited before answering" }),
                ));
            }
            // Poll instead of a blocking `wait()`: the child lock must stay free
            // for `kill()`, which may run while the process still lingers. The
            // thread owns its own handle, so the process is reaped even after
            // the connection was dropped (no zombie is left behind).
            let code = loop {
                match child.lock().map(|mut c| c.try_wait()) {
                    Ok(Ok(Some(status))) => break status.code(),
                    Ok(Ok(None)) => thread::sleep(EXIT_POLL_INTERVAL),
                    _ => break None,
                }
            };
            sink(ConnectionEvent::Exited { code });
        });
    }

    fn write_line(&self, line: &str) -> Result<(), String> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "Agent stdin lock poisoned".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("Failed to write to the agent: {}", e))
    }

    /// Sends a request; `on_done` runs on the reader thread with the result.
    pub fn send_request(
        &self,
        method: &str,
        params: Value,
        on_done: ResponseHandler,
    ) -> Result<(), String> {
        self.send_request_with_id(method, params, on_done)
            .map(|_| ())
    }

    /// Like [`send_request`](Self::send_request), returning the request id.
    fn send_request_with_id(
        &self,
        method: &str,
        params: Value,
        on_done: ResponseHandler,
    ) -> Result<u64, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.pending
            .lock()
            .map_err(|_| "Pending-request lock poisoned".to_string())?
            .insert(id, on_done);
        let written = self.write_line(&jsonrpc::request(id, method, params));
        if written.is_err() {
            self.forget_request(id);
        }
        written.map(|_| id)
    }

    fn forget_request(&self, id: u64) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&id);
        }
    }

    /// Sends a request and blocks until the agent answers or `timeout` passes.
    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        self.request_raw(method, params, timeout)?
            .map_err(|error| format!("{} failed: {}", method, error_message(&error)))
    }

    /// Like [`request`](Self::request), but keeps the agent's JSON-RPC error
    /// object (inner `Err`) apart from transport failures and timeouts.
    pub fn request_raw(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Result<Value, Value>, String> {
        let (tx, rx) = mpsc::channel();
        let id = self.send_request_with_id(
            method,
            params,
            Box::new(move |result| {
                let _ = tx.send(result);
            }),
        )?;
        rx.recv_timeout(timeout).map_err(|_| {
            // Nobody waits for this answer any more; don't keep its handler around.
            self.forget_request(id);
            format!("{} timed out after {:?}", method, timeout)
        })
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write_line(&jsonrpc::notification(method, params))
    }

    pub fn respond(&self, id: &Value, result: Value) -> Result<(), String> {
        self.write_line(&jsonrpc::response(id, result))
    }

    pub fn respond_error(&self, id: &Value, code: i64, message: &str) -> Result<(), String> {
        self.write_line(&jsonrpc::error_response(id, code, message))
    }

    /// The last lines the agent wrote to stderr, for error messages.
    pub fn stderr_tail(&self) -> String {
        self.stderr_tail
            .lock()
            .map(|tail| tail.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default()
    }

    pub fn kill(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

impl Drop for AcpConnection {
    /// An agent must not outlive the app session that started it.
    fn drop(&mut self) {
        self.kill();
    }
}

/// The human-readable part of a JSON-RPC error object.
pub fn error_message(error: &Value) -> String {
    let message = error["message"].as_str().unwrap_or("unknown error");
    match error["data"]["details"]
        .as_str()
        .or_else(|| error["data"].as_str())
    {
        Some(details) => format!("{} ({})", message, details),
        None => message.to_string(),
    }
}
