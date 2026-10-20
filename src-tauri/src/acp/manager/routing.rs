//! Routes what an agent process sends to the app sessions it hosts, and
//! answers the requests no app session can.

use std::sync::{Arc, Mutex, Weak};
use std::thread;

use serde_json::{json, Value};

use super::{AcpEvent, AcpEventSink, Routes, METHOD_NOT_FOUND};
use crate::acp::connection::{AcpConnection, ConnectionEvent};

pub(super) fn route_event(
    routes: &Arc<Mutex<Routes>>,
    sink: &Arc<AcpEventSink>,
    connection: &Weak<AcpConnection>,
    connection_key: u64,
    event: ConnectionEvent,
) {
    match event {
        ConnectionEvent::Notification { method, params } if method == "session/update" => {
            if let Some(session_id) = app_id_for(routes, connection_key, &params) {
                sink(AcpEvent::Update {
                    session_id,
                    update: params["update"].clone(),
                });
            }
        }
        ConnectionEvent::Notification { .. } => {}
        ConnectionEvent::Request { id, method, params } => {
            let session_id = app_id_for(routes, connection_key, &params);
            route_request(sink, connection, session_id, id, &method, params)
        }
        ConnectionEvent::Exited { code } => {
            let gone: Vec<String> = routes
                .lock()
                .map(|mut r| {
                    let ids: Vec<String> = r
                        .sessions
                        .iter()
                        .filter(|(_, e)| e.connection_key == connection_key)
                        .map(|(id, _)| id.clone())
                        .collect();
                    r.sessions.retain(|_, e| e.connection_key != connection_key);
                    // Also drops a session routed by its answer that never registered.
                    r.by_acp_id.retain(|(key, _), _| *key != connection_key);
                    ids
                })
                .unwrap_or_default();
            for session_id in gone {
                sink(AcpEvent::Exited { session_id, code });
            }
        }
    }
}

/// The app session a message's `sessionId` belongs to on this connection.
pub(super) fn app_id_for(
    routes: &Arc<Mutex<Routes>>,
    connection_key: u64,
    params: &Value,
) -> Option<String> {
    let acp_id = params["sessionId"].as_str()?;
    routes
        .lock()
        .ok()?
        .by_acp_id
        .get(&(connection_key, acp_id.to_string()))
        .cloned()
}

/// Answers a request from the agent or hands it to the app session it is for.
fn route_request(
    sink: &Arc<AcpEventSink>,
    connection: &Weak<AcpConnection>,
    session_id: Option<String>,
    id: Value,
    method: &str,
    params: Value,
) {
    match (method, session_id) {
        ("session/request_permission", Some(session_id)) => sink(AcpEvent::PermissionRequest {
            session_id,
            request_id: id,
            params,
        }),
        // No app session to ask: the agent asked before answering the
        // `session/new`, `session/load` or `session/fork` that opens it (its
        // answer routes it), or the session is unknown. It can't wait for
        // the session to open, since the agent may finish opening only after
        // this answer. `cancelled` rather than an error: it is a valid answer
        // every agent handles (ACP sends it when a turn is cancelled), it
        // grants nothing the user never saw, and it does not make the agent
        // fail the session it is opening.
        ("session/request_permission", None) => answer(connection, move |c| {
            c.respond(&id, json!({ "outcome": { "outcome": "cancelled" } }))
        }),
        // We advertise no fs/terminal capabilities, so anything else is refused.
        _ => refuse(connection, id),
    }
}

/// Answers a request from the agent, whether or not it hosts an app session
/// yet. The reply is written on its own thread, so the reader keeps reading
/// even while the agent's stdin is full. Nothing to do once the connection is
/// gone: the agent is being killed.
pub(super) fn answer(
    connection: &Weak<AcpConnection>,
    reply: impl FnOnce(&AcpConnection) -> Result<(), String> + Send + 'static,
) {
    if let Some(connection) = connection.upgrade() {
        thread::spawn(move || {
            let _ = reply(&connection);
        });
    }
}

fn refuse(connection: &Weak<AcpConnection>, id: Value) {
    answer(connection, move |c| {
        c.respond_error(&id, METHOD_NOT_FOUND, "Method not supported by Zorvo")
    });
}
