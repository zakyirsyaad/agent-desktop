use serde::{Deserialize, Serialize};

use crate::env_resolver;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub command: String,
    pub detected: bool,
    pub detected_path: Option<String>,
    pub models: Vec<String>,
    pub model_arg: Option<String>,
    pub effort_levels: Vec<String>,
    pub effort_env: Option<String>,
    pub approval_pattern: Option<String>,
    pub approval_key: Option<String>,
    pub reject_key: Option<String>,
}

impl AgentProfile {
    pub fn new(id: impl Into<String>, name: impl Into<String>, command: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            command: command.into(),
            detected: false,
            detected_path: None,
            models: Vec::new(),
            model_arg: None,
            effort_levels: Vec::new(),
            effort_env: None,
            approval_pattern: None,
            approval_key: None,
            reject_key: None,
        }
    }

    pub fn with_models(mut self, models: &[&str]) -> Self {
        self.models = models.iter().map(|&s| s.to_string()).collect();
        self
    }

    pub fn with_model_arg(mut self, arg: impl Into<String>) -> Self {
        self.model_arg = Some(arg.into());
        self
    }

    pub fn with_effort(mut self, levels: &[&str], env_var: impl Into<String>) -> Self {
        self.effort_levels = levels.iter().map(|&s| s.to_string()).collect();
        self.effort_env = Some(env_var.into());
        self
    }

    pub fn with_approval(
        mut self,
        pattern: impl Into<String>,
        approval_key: impl Into<String>,
        reject_key: impl Into<String>,
    ) -> Self {
        self.approval_pattern = Some(pattern.into());
        self.approval_key = Some(approval_key.into());
        self.reject_key = Some(reject_key.into());
        self
    }
}

/// Returns the predefined list of default agent profile templates.
pub fn get_default_profiles() -> Vec<AgentProfile> {
    vec![
        AgentProfile::new("claude-code", "Claude Code", "claude")
            .with_models(&["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"])
            .with_model_arg("--model")
            .with_effort(&["Low", "Medium", "High"], "MAX_THINKING_TOKENS")
            .with_approval(r"(Allow this action\?|\[y/n\]|Run command\?)", "y\n", "n\n"),
        AgentProfile::new("omp", "Oh-My-Pi", "omp")
            .with_models(&["gemini-3.8-flash-tiered", "gemini-3.8-pro"])
            .with_model_arg("--model")
            .with_approval(r"(\[y/n\]|Confirm\?)", "y\n", "n\n"),
        AgentProfile::new("aider", "Aider", "aider")
            .with_models(&["claude-3-7-sonnet", "gpt-4o", "deepseek-r1"])
            .with_model_arg("--model"),
        AgentProfile::new("generic", "Custom CLI", ""),
    ]
}

/// Resolves default profiles and updates their detection status against the user's path.
///
/// Resolves the user environment once to avoid launching the login shell multiple times.
pub fn get_available_agent_profiles() -> Vec<AgentProfile> {
    let path_var = match env_resolver::resolve_user_env() {
        Ok(env_map) => env_map.get("PATH").cloned(),
        Err(_) => None,
    }
    .or_else(|| std::env::var("PATH").ok());

    get_default_profiles()
        .into_iter()
        .map(|mut profile| {
            if !profile.command.is_empty() {
                let found = path_var
                    .as_deref()
                    .and_then(|pv| env_resolver::find_binary_in_path_str(&profile.command, pv));

                if let Some(path) = found {
                    profile.detected = true;
                    profile.detected_path = Some(path.to_string_lossy().to_string());
                } else {
                    profile.detected = false;
                    profile.detected_path = None;
                }
            } else {
                profile.detected = false;
                profile.detected_path = None;
            }
            profile
        })
        .collect()
}
