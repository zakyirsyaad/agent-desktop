//! Routes `elicitation/create` requests and `elicitation/complete`
//! notifications to the app session they are for, and sends the user's
//! answers back.

use std::sync::{Arc, Mutex, Weak};

use serde_json::{json, Value};

use super::routing::answer;
use super::{AcpEvent, AcpEventSink, AcpManager, Routes};
use crate::acp::connection::AcpConnection;
use crate::acp::elicitation::{parse_request, validate, Elicitation, Pending, PendingState};

/// JSON-RPC "invalid params", for a request Zorvo cannot read.
const INVALID_PARAMS: i64 = -32602;

/// Starts the error of a form that failed validation; the field errors follow as JSON.
pub const ELICITATION_INVALID_PREFIX: &str = "ELICITATION_INVALID:";
/// The error for a request that was answered, finished, or belongs to a stopped session.
pub const ELICITATION_GONE: &str = "This request can no longer be answered.";
/// The error for a URL request whose page opened but whose accept never reached the agent.
pub const ELICITATION_UNDELIVERED: &str =
    "The page opened, but the agent could not be told. Its request was cancelled.";

/// Opens an accepted URL request's link in the browser.
pub type UrlOpener = Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

/// How the user answered a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Action {
    Accept,
    Decline,
    Cancel,
}

impl Action {
    fn parse(action: &str) -> Result<Self, String> {
        match action {
            "accept" => Ok(Self::Accept),
            "decline" => Ok(Self::Decline),
            "cancel" => Ok(Self::Cancel),
            _ => Err("Unknown answer".to_string()),
        }
    }
}

impl AcpManager {
    /// Answers the request `key` of a session. A form is checked against the
    /// agent's schema first; an accepted URL request opens its checked link
    /// first and then waits for the agent to say it is done. When either
    /// fails, the request stays open. `content` goes straight to the agent.
    pub fn respond_elicitation(
        &self,
        app_session_id: &str,
        key: &str,
        action: &str,
        content: Option<Value>,
    ) -> Result<(), String> {
        let action = Action::parse(action)?;
        let pending = self
            .routes
            .lock()
            .ok()
            .and_then(|mut routes| routes.elicitations.take_open(app_session_id, key))
            .ok_or_else(|| ELICITATION_GONE.to_string())?;
        // The lock is released: the opener and the agent may be slow.
        let reply = match self.reply_for(&pending, action, content) {
            Ok(reply) => reply,
            Err(error) => {
                self.put_back(key, pending);
                return Err(error);
            }
        };
        if action == Action::Accept && is_url(&pending) {
            return self.send_url_accept(key, pending, reply);
        }
        match send(&pending.connection, &pending.request_id, reply) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.put_back(key, pending);
                Err(error)
            }
        }
    }

    /// Sends the accept of a URL request whose link is open. The request
    /// already waits for completion when the accept goes out, since the agent
    /// may say it is done the moment the accept arrives. When the accept
    /// cannot be sent, the request ends: its page is already open, so offering
    /// it again would open a second one. The agent is told `cancel` if it can
    /// still hear it.
    fn send_url_accept(&self, key: &str, pending: Pending, reply: Value) -> Result<(), String> {
        let app_session_id = pending.app_session_id.clone();
        let connection = pending.connection.clone();
        let request_id = pending.request_id.clone();
        let awaiting = Pending {
            state: PendingState::AwaitingCompletion,
            ..pending
        };
        if !self.put_back(key, awaiting) {
            // Its session stopped meanwhile: no completion could reach the card.
            cancel_request(&connection, request_id);
            return Err(ELICITATION_GONE.to_string());
        }
        if send(&connection, &request_id, reply).is_ok() {
            return Ok(());
        }
        // Taken out, if still there, so no completion or reopen finds it.
        let _ = self
            .routes
            .lock()
            .ok()
            .and_then(|mut routes| routes.elicitations.take_awaiting(&app_session_id, key));
        cancel_request(&connection, request_id);
        Err(ELICITATION_UNDELIVERED.to_string())
    }

    /// Opens the link of an accepted URL request again.
    pub fn reopen_elicitation_url(&self, app_session_id: &str, key: &str) -> Result<(), String> {
        let url = self
            .routes
            .lock()
            .ok()
            .and_then(
                |routes| match routes.elicitations.get(app_session_id, key)? {
                    Pending {
                        state: PendingState::AwaitingCompletion,
                        elicitation: Elicitation::Url { url, .. },
                        ..
                    } => Some(url.clone()),
                    _ => None,
                },
            )
            .ok_or_else(|| ELICITATION_GONE.to_string())?;
        (self.url_opener)(&url)
    }

    /// Answers `cancel` to a session's unanswered requests before its turn is
    /// cancelled, and returns their keys. Accepted URL requests stay.
    pub(super) fn cancel_open_elicitations(&self, app_session_id: &str) -> Vec<String> {
        let open = self
            .routes
            .lock()
            .map(|mut routes| routes.elicitations.take_open_of_session(app_session_id))
            .unwrap_or_default();
        let mut keys = Vec::with_capacity(open.len());
        for (key, pending) in open {
            // Written here, not on a thread through `cancel_request`/`answer`,
            // so these replies reach the agent before `session/cancel`. Best
            // effort, like every answer Zorvo sends unasked: a write fails
            // only when the agent is gone, and the turn is cancelled anyway.
            let _ = send(
                &pending.connection,
                &pending.request_id,
                json!({ "action": "cancel" }),
            );
            keys.push(key);
        }
        keys
    }

    /// Builds the agent's answer. Nothing is to be sent when the agent is
    /// gone, the form is invalid, or the link is blocked or cannot be opened.
    fn reply_for(
        &self,
        pending: &Pending,
        action: Action,
        content: Option<Value>,
    ) -> Result<Value, String> {
        if pending.connection.strong_count() == 0 {
            return Err(ELICITATION_GONE.to_string());
        }
        let reply = match (action, &pending.elicitation) {
            (Action::Accept, Elicitation::Form { fields, .. }) => {
                let content = validate(fields, &content.unwrap_or(Value::Null))
                    .map_err(|errors| invalid_form_error(&errors))?;
                json!({ "action": "accept", "content": content })
            }
            (Action::Accept, Elicitation::Url { url, check, .. }) => {
                if let Some(blocked) = &check.blocked {
                    return Err(blocked.clone());
                }
                (self.url_opener)(url)?;
                json!({ "action": "accept" })
            }
            (Action::Decline, _) => json!({ "action": "decline" }),
            (Action::Cancel, _) => json!({ "action": "cancel" }),
        };
        Ok(reply)
    }

    /// Keeps a request taken out to answer again, unless its session stopped
    /// or its agent exited meanwhile (they already dropped its requests). An
    /// unanswered request of a stopped session is answered `cancel`, as stop
    /// does, once the lock is released. Returns whether it was kept.
    fn put_back(&self, key: &str, pending: Pending) -> bool {
        let dropped = {
            let Ok(mut routes) = self.routes.lock() else {
                return false;
            };
            let id = &pending.app_session_id;
            let session_known = routes.sessions.contains_key(id)
                || routes.opening.values().any(|opening| opening == id)
                || routes.by_acp_id.values().any(|routed| routed == id);
            if session_known && pending.connection.strong_count() > 0 {
                routes.elicitations.put_back(key.to_string(), pending);
                return true;
            }
            pending
        };
        cancel_open(vec![dropped]);
        false
    }
}

/// Writes an answer to the agent's request `request_id`.
fn send(connection: &Weak<AcpConnection>, request_id: &Value, reply: Value) -> Result<(), String> {
    connection
        .upgrade()
        .ok_or_else(|| ELICITATION_GONE.to_string())?
        .respond(request_id, reply)
}

fn is_url(pending: &Pending) -> bool {
    matches!(pending.elicitation, Elicitation::Url { .. })
}

/// [`ELICITATION_INVALID_PREFIX`] and the field errors, which never quote a value.
fn invalid_form_error(errors: &crate::acp::elicitation::FieldErrors) -> String {
    let errors = serde_json::to_string(errors).unwrap_or_else(|_| "{}".to_string());
    format!("{ELICITATION_INVALID_PREFIX}{errors}")
}

/// Answers `cancel` to the unanswered requests of a session that stopped.
/// Through [`answer`], since the agent may be killed right after.
pub(super) fn cancel_open(requests: Vec<Pending>) {
    for pending in requests {
        if pending.state == PendingState::Open {
            cancel_request(&pending.connection, pending.request_id);
        }
    }
}

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
