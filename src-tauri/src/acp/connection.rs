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

/// What the reader thread reports besides responses to our own requests.
#[derive(Debug, Clone)]
pub enum ConnectionEvent {
    Notification { method: String, params: Value },
    /// The agent asks us something and waits for `respond`.
    Request { id: Value, method: String, params: Value },
    Exited { code: Option<i32> },
}

pub type EventSink = Arc<dyn Fn(ConnectionEvent) + Send + Sync>;
type ResponseHandler = Box<dyn FnOnce(Result<Value, Value>) + Send>;

/// A spawned agent speaking newline-delimited JSON-RPC on stdin/stdout.
pub struct AcpConnection {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
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

        let stdin = child.stdin.take().ok_or("Failed to open the agent's stdin")?;
        let stdout = child.stdout.take().ok_or("Failed to open the agent's stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to open the agent's stderr")?;

        let connection = Arc::new(Self {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
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

    fn spawn_stdout_reader(self: &Arc<Self>, stdout: impl std::io::Read + Send + 'static, sink: EventSink) {
        let pending = Arc::clone(&self.pending);
        let weak = Arc::downgrade(self);
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
            let waiting: Vec<ResponseHandler> =
                pending.lock().map(|mut p| p.drain().map(|(_, h)| h).collect()).unwrap_or_default();
            for handler in waiting {
                handler(Err(json!({ "message": "The agent exited before answering" })));
            }
            let code = weak
                .upgrade()
                .and_then(|conn| conn.child.lock().ok().and_then(|mut c| c.wait().ok()))
                .and_then(|status| status.code());
            sink(ConnectionEvent::Exited { code });
        });
    }

    fn write_line(&self, line: &str) -> Result<(), String> {
        let mut stdin = self.stdin.lock().map_err(|_| "Agent stdin lock poisoned".to_string())?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("Failed to write to the agent: {}", e))
    }

    /// Sends a request; `on_done` runs on the reader thread with the result.
    pub fn send_request(&self, method: &str, params: Value, on_done: ResponseHandler) -> Result<(), String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        self.pending
            .lock()
            .map_err(|_| "Pending-request lock poisoned".to_string())?
            .insert(id, on_done);
        let written = self.write_line(&jsonrpc::request(id, method, params));
        if written.is_err() {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
        }
        written
    }

    /// Sends a request and blocks until the agent answers or `timeout` passes.
    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        self.send_request(method, params, Box::new(move |result| {
            let _ = tx.send(result);
        }))?;
        match rx.recv_timeout(timeout) {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(error)) => Err(format!("{} failed: {}", method, error_message(&error))),
            Err(_) => Err(format!("{} timed out after {:?}", method, timeout)),
        }
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

/// The human-readable part of a JSON-RPC error object.
pub fn error_message(error: &Value) -> String {
    let message = error["message"].as_str().unwrap_or("unknown error");
    match error["data"]["details"].as_str().or_else(|| error["data"].as_str()) {
        Some(details) => format!("{} ({})", message, details),
        None => message.to_string(),
    }
}
