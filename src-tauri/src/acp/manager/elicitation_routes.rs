//! Routes `elicitation/create` requests and `elicitation/complete`
//! notifications to the app session they are for.

use std::sync::{Arc, Mutex, Weak};

use serde_json::{json, Value};

use super::routing::answer;
use super::{AcpEvent, AcpEventSink, Routes};
use crate::acp::connection::AcpConnection;
use crate::acp::elicitation::{parse_request, Pending, PendingState};

/// JSON-RPC "invalid params", for a request Zorvo cannot read.
const INVALID_PARAMS: i64 = -32602;

/// Answers an `elicitation/create` with `cancel`: a dismissal every agent
/// handles, for a request no user can see.
pub(super) fn cancel_request(connection: &Weak<AcpConnection>, id: Value) {
    answer(connection, move |c| {
        c.respond(&id, json!({ "action": "cancel" }))
    });
}

/// Keeps an `elicitation/create` for its app session and shows it, refuses
/// one it cannot read, and cancels one that belongs to no app session.
pub(super) fn route_create(
    routes: &Arc<Mutex<Routes>>,
    sink: &Arc<AcpEventSink>,
    connection: &Weak<AcpConnection>,
    connection_key: u64,
    id: Value,
    params: Value,
) {
    let elicitation = match parse_request(&params) {
        Ok(elicitation) => elicitation,
        Err(message) => {
            return answer(connection, move |c| {
                c.respond_error(&id, INVALID_PARAMS, &message)
            })
        }
    };
    let view = elicitation.view();
    let kept = routes.lock().ok().and_then(|mut routes| {
        let session_id = session_for(&routes, connection_key, &params)?;
        let key = routes.elicitations.insert(Pending {
            app_session_id: session_id.clone(),
            connection: connection.clone(),
            connection_key,
            request_id: id.clone(),
            elicitation,
            state: PendingState::Open,
        });
        Some((session_id, key))
    });
    match kept {
        Some((session_id, key)) => sink(AcpEvent::Elicitation {
            session_id,
            key,
            view,
        }),
        None => cancel_request(connection, id),
    }
}

/// The app session a request is for: its `sessionId` once routed, else the
/// session this connection is opening (the request came before the answer
/// that routes it, or names it by `requestId`).
fn session_for(routes: &Routes, connection_key: u64, params: &Value) -> Option<String> {
    params["sessionId"]
        .as_str()
        .and_then(|acp_id| routes.by_acp_id.get(&(connection_key, acp_id.to_string())))
        .or_else(|| routes.opening.get(&connection_key))
        .cloned()
}

/// Ends an accepted URL request the agent says is done. Unknown, unaccepted
/// and finished ids are ignored.
pub(super) fn route_complete(
    routes: &Arc<Mutex<Routes>>,
    sink: &Arc<AcpEventSink>,
    connection_key: u64,
    params: &Value,
) {
    let Some(elicitation_id) = params["elicitationId"].as_str() else {
        return;
    };
    let done = routes.lock().ok().and_then(|mut routes| {
        routes
            .elicitations
            .take_completed(connection_key, elicitation_id)
    });
    if let Some((key, pending)) = done {
        sink(AcpEvent::ElicitationComplete {
            session_id: pending.app_session_id,
            key,
        });
    }
}
