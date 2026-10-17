//! JSON-RPC 2.0 framing for the Agent Client Protocol.
//!
//! ACP speaks newline-delimited JSON-RPC over the agent's stdin/stdout: every
//! message is one JSON object on one line. This module only builds and
//! classifies lines; it does no IO, so it is fully unit-testable.

use serde_json::{json, Value};

const JSONRPC_VERSION: &str = "2.0";

/// One message read from the agent.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// The agent's answer to a request we sent. We only send numeric ids.
    Response {
        id: u64,
        /// `Ok(result)` or `Err(error object)`.
        result: Result<Value, Value>,
    },
    /// The agent asks us to do something and waits for our response.
    Request { id: Value, method: String, params: Value },
    /// Fire-and-forget message from the agent, e.g. `session/update`.
    Notification { method: String, params: Value },
}

fn to_line(message: Value) -> String {
    // serde_json never emits raw newlines inside strings, so one message is one line.
    message.to_string()
}

pub fn request(id: u64, method: &str, params: Value) -> String {
    to_line(json!({ "jsonrpc": JSONRPC_VERSION, "id": id, "method": method, "params": params }))
}

pub fn notification(method: &str, params: Value) -> String {
    to_line(json!({ "jsonrpc": JSONRPC_VERSION, "method": method, "params": params }))
}

/// A successful response to a request the agent sent us (its id may be any JSON value).
pub fn response(id: &Value, result: Value) -> String {
    to_line(json!({ "jsonrpc": JSONRPC_VERSION, "id": id, "result": result }))
}

pub fn error_response(id: &Value, code: i64, message: &str) -> String {
    to_line(json!({
        "jsonrpc": JSONRPC_VERSION,
        "id": id,
        "error": { "code": code, "message": message },
    }))
}

/// Classifies one line from the agent. Anything that is not a JSON-RPC message
/// we can route is an error, and callers skip it rather than trusting it.
pub fn parse_incoming(line: &str) -> Result<Incoming, String> {
    let value: Value =
        serde_json::from_str(line).map_err(|e| format!("Agent sent invalid JSON: {}", e))?;
    let object = value
        .as_object()
        .ok_or_else(|| "Agent message is not a JSON object".to_string())?;

    let params = object.get("params").cloned().unwrap_or(Value::Null);
    match (object.get("method").and_then(Value::as_str), object.get("id")) {
        (Some(method), Some(id)) => Ok(Incoming::Request {
            id: id.clone(),
            method: method.to_string(),
            params,
        }),
        (Some(method), None) => Ok(Incoming::Notification {
            method: method.to_string(),
            params,
        }),
        (None, Some(id)) => {
            let id = id
                .as_u64()
                .ok_or_else(|| format!("Response id {} does not match any request we sent", id))?;
            let result = match (object.get("result"), object.get("error")) {
                (_, Some(error)) => Err(error.clone()),
                (Some(result), None) => Ok(result.clone()),
                (None, None) => Ok(Value::Null),
            };
            Ok(Incoming::Response { id, result })
        }
        (None, None) => Err("Agent message has neither a method nor an id".to_string()),
    }
}
