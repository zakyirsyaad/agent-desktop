//! Reopens an agent's earlier session with the ACP method the agent offers.

use serde::Serialize;
use serde_json::{json, Value};

use super::{open_request, AcpLaunch, AcpManager, OpenError, StartedSession};

/// Why an agent's earlier session is being reopened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReopenPurpose {
    /// A Zorvo session with its transcript: resume, else load with the replay dropped.
    Continue,
    /// A session from the agent's list: load with the replay routed, else resume.
    Import,
}

/// The ACP method a reopen used, so the UI knows whether the agent replayed a
/// history it has to show.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReopenMethod {
    Resume,
    Load,
}

impl ReopenMethod {
    /// The ACP method to send.
    fn acp_method(self) -> &'static str {
        match self {
            Self::Resume => "session/resume",
            Self::Load => "session/load",
        }
    }
}

/// The error for an agent that offers neither `session/resume` nor `session/load`.
const CANNOT_REOPEN: &str = "This agent cannot resume earlier sessions";

impl AcpManager {
    /// Reopens the agent's earlier session `acp_session_id` as app session
    /// `app_session_id`, with `session/resume` or `session/load`, whichever
    /// `purpose` prefers and the agent offers.
    ///
    /// The session is registered only once the agent answers, so nothing it
    /// sends while reopening is routed to the app yet.
    pub fn reopen(
        &self,
        app_session_id: &str,
        cwd: &str,
        launch: &AcpLaunch,
        acp_session_id: &str,
        purpose: ReopenPurpose,
    ) -> Result<StartedSession, String> {
        self.open(app_session_id, cwd, launch, |connection, init, key| {
            let capabilities = init["agentCapabilities"].clone();
            let Some(method) = reopen_method(&capabilities, purpose) else {
                return Err(OpenError::Agent(CANNOT_REOPEN.to_string()));
            };
            let response = open_request(
                connection,
                init,
                method.acp_method(),
                json!({ "sessionId": acp_session_id, "cwd": cwd, "mcpServers": [] }),
                self.route_on_answer(key, app_session_id, Some(acp_session_id), true),
            )?;
            Ok(StartedSession {
                // Neither answer names the session: it is the one asked for.
                acp_session_id: acp_session_id.to_string(),
                agent_capabilities: capabilities,
                modes: response["modes"].clone(),
                // A resume answer carries no models, which the UI handles.
                models: response["models"].clone(),
                config_options: response["configOptions"].clone(),
                reopened_with: Some(method),
            })
        })
    }
}

/// The method to reopen with: `purpose`'s preference when the agent offers it,
/// else the other one it offers, else `None`.
pub(super) fn reopen_method(
    agent_capabilities: &Value,
    purpose: ReopenPurpose,
) -> Option<ReopenMethod> {
    // Load when Zorvo needs the history, resume when it already has it.
    let (preferred, other) = match purpose {
        ReopenPurpose::Continue => (ReopenMethod::Resume, ReopenMethod::Load),
        ReopenPurpose::Import => (ReopenMethod::Load, ReopenMethod::Resume),
    };
    [preferred, other]
        .into_iter()
        .find(|method| offers(agent_capabilities, *method))
}

/// Whether the agent's `initialize` answer allows `method`.
fn offers(agent_capabilities: &Value, method: ReopenMethod) -> bool {
    match method {
        ReopenMethod::Resume => agent_capabilities["sessionCapabilities"]["resume"].is_object(),
        ReopenMethod::Load => agent_capabilities["loadSession"] == Value::Bool(true),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn continue_prefers_resume() {
        let capabilities = json!({ "loadSession": true, "sessionCapabilities": { "resume": {} } });

        assert_eq!(
            reopen_method(&capabilities, ReopenPurpose::Continue),
            Some(ReopenMethod::Resume)
        );
    }

    #[test]
    fn continue_falls_back_to_load() {
        let capabilities = json!({ "loadSession": true });

        assert_eq!(
            reopen_method(&capabilities, ReopenPurpose::Continue),
            Some(ReopenMethod::Load)
        );
    }

    #[test]
    fn import_prefers_load() {
        let capabilities = json!({ "loadSession": true, "sessionCapabilities": { "resume": {} } });

        assert_eq!(
            reopen_method(&capabilities, ReopenPurpose::Import),
            Some(ReopenMethod::Load)
        );
    }

    #[test]
    fn import_falls_back_to_resume() {
        let capabilities = json!({ "sessionCapabilities": { "resume": {} } });

        assert_eq!(
            reopen_method(&capabilities, ReopenPurpose::Import),
            Some(ReopenMethod::Resume)
        );
    }

    #[test]
    fn neither_method_gives_none() {
        let capabilities = json!({});

        assert_eq!(reopen_method(&capabilities, ReopenPurpose::Continue), None);
        assert_eq!(reopen_method(&capabilities, ReopenPurpose::Import), None);
    }
}
