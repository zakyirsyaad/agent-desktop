//! Elicitation requests the user has not finished answering, by key.

use std::collections::HashMap;
use std::sync::Weak;

use serde_json::Value;

use super::Elicitation;
use crate::acp::connection::AcpConnection;

/// Where a request is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingState {
    /// Shown to the user, not answered yet.
    Open,
    /// A URL request the user accepted; the agent will say when it is done.
    AwaitingCompletion,
}

/// One request an agent sent, kept until it is answered or finished.
pub struct Pending {
    pub app_session_id: String,
    /// Weak, so the store never keeps an agent process alive.
    pub connection: Weak<AcpConnection>,
    pub connection_key: u64,
    /// The JSON-RPC id the answer goes to.
    pub request_id: Value,
    pub elicitation: Elicitation,
    pub state: PendingState,
}

impl Pending {
    fn is_completed_by(&self, connection_key: u64, elicitation_id: &str) -> bool {
        self.connection_key == connection_key
            && self.state == PendingState::AwaitingCompletion
            && matches!(&self.elicitation, Elicitation::Url { elicitation_id: id, .. } if id == elicitation_id)
    }
}

/// The open requests of every session. Keys are `el-<n>`, never reused.
#[derive(Default)]
pub struct PendingElicitations {
    requests: HashMap<String, Pending>,
    last_key: u64,
}

impl PendingElicitations {
    /// Keeps `pending` and returns its new key.
    pub fn insert(&mut self, pending: Pending) -> String {
        self.last_key += 1;
        let key = format!("el-{}", self.last_key);
        self.requests.insert(key.clone(), pending);
        key
    }

    /// The request `key`, only when it belongs to `app_session_id`.
    pub fn get(&self, app_session_id: &str, key: &str) -> Option<&Pending> {
        self.requests
            .get(key)
            .filter(|pending| pending.app_session_id == app_session_id)
    }

    /// The request `key`, only when it belongs to `app_session_id`.
    pub fn get_mut(&mut self, app_session_id: &str, key: &str) -> Option<&mut Pending> {
        self.requests
            .get_mut(key)
            .filter(|pending| pending.app_session_id == app_session_id)
    }

    pub fn remove(&mut self, key: &str) -> Option<Pending> {
        self.requests.remove(key)
    }

    /// Takes the request `key` while it is still unanswered and belongs to
    /// `app_session_id`, so only one answer can be sent for it.
    pub fn take_open(&mut self, app_session_id: &str, key: &str) -> Option<Pending> {
        let pending = self.get(app_session_id, key)?;
        if pending.state != PendingState::Open {
            return None;
        }
        self.requests.remove(key)
    }

    /// Keeps a request taken with [`take_open`](Self::take_open) again, under
    /// the same key.
    pub fn put_back(&mut self, key: String, pending: Pending) {
        self.requests.insert(key, pending);
    }

    /// Takes the accepted URL request `elicitation_id` of this connection,
    /// with its key. Open requests and other connections' ids are left alone.
    pub fn take_completed(
        &mut self,
        connection_key: u64,
        elicitation_id: &str,
    ) -> Option<(String, Pending)> {
        let key = self
            .requests
            .iter()
            .find(|(_, pending)| pending.is_completed_by(connection_key, elicitation_id))
            .map(|(key, _)| key.clone())?;
        self.requests.remove_entry(&key)
    }

    /// Takes every request of a session that stopped or failed to open.
    pub fn take_session(&mut self, app_session_id: &str) -> Vec<Pending> {
        self.take_where(|pending| pending.app_session_id == app_session_id)
    }

    /// Takes a session's unanswered requests; accepted URL requests stay.
    pub fn take_open_of_session(&mut self, app_session_id: &str) -> Vec<Pending> {
        self.take_where(|pending| {
            pending.app_session_id == app_session_id && pending.state == PendingState::Open
        })
    }

    /// Takes every request of an agent process that exited.
    pub fn take_connection(&mut self, connection_key: u64) -> Vec<Pending> {
        self.take_where(|pending| pending.connection_key == connection_key)
    }

    fn take_where(&mut self, matches: impl Fn(&Pending) -> bool) -> Vec<Pending> {
        let keys: Vec<String> = self
            .requests
            .iter()
            .filter(|(_, pending)| matches(pending))
            .map(|(key, _)| key.clone())
            .collect();
        keys.iter()
            .filter_map(|key| self.requests.remove(key))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::elicitation::check_url;
    use serde_json::json;

    fn form(app_session_id: &str, connection_key: u64) -> Pending {
        Pending {
            app_session_id: app_session_id.to_string(),
            connection: Weak::new(),
            connection_key,
            request_id: json!("elic-1"),
            elicitation: Elicitation::Form {
                message: String::new(),
                fields: Vec::new(),
            },
            state: PendingState::Open,
        }
    }

    fn url(elicitation_id: &str, connection_key: u64, state: PendingState) -> Pending {
        let link = "https://agent.example.com/connect";
        Pending {
            elicitation: Elicitation::Url {
                message: String::new(),
                elicitation_id: elicitation_id.to_string(),
                url: link.to_string(),
                check: check_url(link),
            },
            state,
            ..form("s-1", connection_key)
        }
    }

    #[test]
    fn gives_each_request_its_own_key() {
        let mut pending = PendingElicitations::default();

        let first = pending.insert(form("s-1", 1));
        let second = pending.insert(form("s-1", 1));

        assert_eq!((first.as_str(), second.as_str()), ("el-1", "el-2"));
    }

    #[test]
    fn finds_a_request_only_for_its_own_session() {
        let mut pending = PendingElicitations::default();
        let key = pending.insert(form("s-1", 1));

        assert!(pending.get("s-1", &key).is_some());
        assert!(pending.get("s-2", &key).is_none());
        assert!(pending.get_mut("s-2", &key).is_none());
        assert!(pending.get("s-1", "el-99").is_none());
    }

    #[test]
    fn completes_only_an_accepted_url_request_of_the_same_connection() {
        let mut pending = PendingElicitations::default();
        pending.insert(url("gh-1", 1, PendingState::Open));
        let accepted = pending.insert(url("gh-1", 2, PendingState::AwaitingCompletion));

        assert!(pending.take_completed(1, "gh-1").is_none());
        assert!(pending.take_completed(2, "nope").is_none());
        let (key, done) = pending.take_completed(2, "gh-1").expect("completed");
        assert_eq!(key, accepted);
        assert_eq!(done.connection_key, 2);
        assert!(pending.take_completed(2, "gh-1").is_none());
    }

    #[test]
    fn takes_an_open_request_once_and_puts_it_back_under_its_key() {
        let mut pending = PendingElicitations::default();
        let key = pending.insert(form("s-1", 1));

        assert!(pending.take_open("s-2", &key).is_none());
        let taken = pending.take_open("s-1", &key).expect("open");
        assert!(pending.take_open("s-1", &key).is_none());
        pending.put_back(key.clone(), taken);
        assert!(pending.get("s-1", &key).is_some());
    }

    #[test]
    fn does_not_take_an_accepted_url_request_as_open() {
        let mut pending = PendingElicitations::default();
        let accepted = pending.insert(url("gh-1", 1, PendingState::AwaitingCompletion));
        pending.insert(url("gh-2", 1, PendingState::Open));

        assert!(pending.take_open("s-1", &accepted).is_none());
        assert_eq!(pending.take_open_of_session("s-1").len(), 1);
        assert!(pending.get("s-1", &accepted).is_some());
    }

    #[test]
    fn drops_the_requests_of_a_session_or_a_connection() {
        let mut pending = PendingElicitations::default();
        pending.insert(form("s-1", 1));
        pending.insert(form("s-1", 1));
        let other = pending.insert(form("s-2", 2));

        assert_eq!(pending.take_session("s-1").len(), 2);
        assert!(pending.take_session("s-1").is_empty());
        assert_eq!(pending.take_connection(2).len(), 1);
        assert!(pending.remove(&other).is_none());
    }
}
