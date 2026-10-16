use serde::{Deserialize, Serialize};

use crate::env_resolver;

/// A thinking/effort level the agent's CLI can actually be told to use.
///
/// `label` is what the UI shows and what `SpawnOptions::effort` carries. `args`
/// and `env` are the real mechanism: at least one must be non-empty, otherwise
/// the level is a no-op the user could select and get nothing from.
///
/// Effort used to be mapped onto `MAX_THINKING_TOKENS`, which expects a token
/// count, so `"High"` produced an invalid value. Every level below now uses a
/// flag that was read from the agent's own `--help`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EffortLevel {
    pub label: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl EffortLevel {
    /// An effort level driven purely by command-line args.
    pub fn from_args(label: impl Into<String>, args: &[&str]) -> Self {
        Self {
            label: label.into(),
            args: args.iter().map(|&s| s.to_string()).collect(),
            env: Vec::new(),
        }
    }
}

/// A permission/approval mode the agent's CLI supports.
///
/// `id` is the wire value: `"ask"` and `"bypass"` are the cross-agent ids the UI
/// already uses, and anything else is an agent-specific id (e.g. Claude Code's
/// `"plan"`). The `"ask"` entry must be first and carry no args, because asking
/// is the agent's own default and re-stating it can change behaviour.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionModeOption {
    pub id: String,
    pub label: String,
    pub args: Vec<String>,
}

impl PermissionModeOption {
    pub fn new(id: impl Into<String>, label: impl Into<String>, args: &[&str]) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            args: args.iter().map(|&s| s.to_string()).collect(),
        }
    }

    /// The "let the agent ask" option: no extra args, so the CLI default stands.
    pub fn ask(label: impl Into<String>) -> Self {
        Self::new("ask", label, &[])
    }
}

/// Fork support, as declared by a profile.
///
/// `"native"` means the CLI can both resume *and* fork a session id we chose, so
/// `resume_fork_args` holds a template. `"handoff"` means we can only start a
/// fresh session and hand the new id back to the caller.
pub const FORK_SUPPORT_NATIVE: &str = "native";
pub const FORK_SUPPORT_HANDOFF: &str = "handoff";

/// Static description of one agent CLI: what it is called, how to invoke it, and
/// which of its real flags this app is allowed to pass.
///
/// Every capability below was read from the agent's own `--help` on the
/// reference machine (Claude Code 2.1.x, omp v18.10.3, 2026-10-16). Where a
/// capability does not exist, the field is empty rather than approximated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub command: String,
    pub detected: bool,
    pub detected_path: Option<String>,
    /// Model aliases this profile is willing to pass. Empty means "no verified
    /// list", which makes `build_spawn_plan` reject every model instead of
    /// forwarding an unverified string to the CLI.
    pub models: Vec<String>,
    pub model_arg: Option<String>,
    pub effort_levels: Vec<EffortLevel>,
    pub permission_modes: Vec<PermissionModeOption>,
    /// Flag that assigns the session id at start (Claude Code: `--session-id`).
    pub session_id_arg: Option<String>,
    /// `"native"` or `"handoff"`; see [`FORK_SUPPORT_NATIVE`].
    pub fork_support: String,
    /// Resume/fork template with a `{session_id}` placeholder. Empty unless
    /// `fork_support` is `"native"`.
    pub resume_fork_args: Vec<String>,
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
            permission_modes: Vec::new(),
            session_id_arg: None,
            fork_support: FORK_SUPPORT_HANDOFF.to_string(),
            resume_fork_args: Vec::new(),
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

    pub fn with_effort_levels(mut self, levels: Vec<EffortLevel>) -> Self {
        self.effort_levels = levels;
        self
    }

    pub fn with_permission_modes(mut self, modes: Vec<PermissionModeOption>) -> Self {
        self.permission_modes = modes;
        self
    }

    pub fn with_session_id_arg(mut self, arg: impl Into<String>) -> Self {
        self.session_id_arg = Some(arg.into());
        self
    }

    /// Declares that this CLI can resume *and* fork a given session id, using
    /// `args` as the template (`{session_id}` is expanded at spawn time).
    pub fn with_native_fork(mut self, args: &[&str]) -> Self {
        self.fork_support = FORK_SUPPORT_NATIVE.to_string();
        self.resume_fork_args = args.iter().map(|&s| s.to_string()).collect();
        self
    }

    pub fn with_fork_support(mut self, support: impl Into<String>) -> Self {
        self.fork_support = support.into();
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

/// Claude Code, verified against `claude --help` (Claude Code 2.1.x).
///
/// - model selection: `--model <model>` — "Provide an alias for the latest model
///   (e.g. 'fable', 'opus', or 'sonnet') or a model's full name." Aliases are
///   published instead of versioned ids because those go stale every release.
/// - permission/approval mode: `--permission-mode <mode>` — choices
///   `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`.
///   Only `bypassPermissions`, `plan` and `acceptEdits` are surfaced: `--help`
///   gives no semantics for `auto`, `manual` or `dontAsk`, so publishing them
///   would be guessing at what the user is opting into.
/// - effort/thinking: `--effort <level>` — "(low, medium, high, xhigh, max)".
///   This is a real flag, so no env var is involved.
/// - assigning a session id at start: `--session-id <uuid>` — "Use a specific
///   session ID for the conversation (must be a valid UUID)".
/// - resuming/forking: `-r, --resume [value]` — "Resume a conversation by
///   session ID" — plus `--fork-session` — "When resuming, create a new session
///   ID instead of reusing the original (use with --resume or --continue)".
///   Both exist, so fork support is `native`.
///
/// Note: `opus`, `sonnet` and `fable` are the aliases `--help` names; `haiku`
/// is the third family alias (this repo previously listed `claude-haiku-4-5`)
/// and was not itself in the `--help` example list. Passing `--session-id`
/// together with `--resume ... --fork-session` is not verified against the CLI.
fn claude_code_profile() -> AgentProfile {
    AgentProfile::new("claude-code", "Claude Code", "claude")
        .with_models(&["opus", "sonnet", "haiku", "fable"])
        .with_model_arg("--model")
        .with_effort_levels(vec![
            EffortLevel::from_args("Low", &["--effort", "low"]),
            EffortLevel::from_args("Medium", &["--effort", "medium"]),
            EffortLevel::from_args("High", &["--effort", "high"]),
            EffortLevel::from_args("XHigh", &["--effort", "xhigh"]),
            EffortLevel::from_args("Max", &["--effort", "max"]),
        ])
        .with_permission_modes(vec![
            PermissionModeOption::ask("Ask"),
            PermissionModeOption::new("bypass", "Bypass permissions", &["--permission-mode", "bypassPermissions"]),
            PermissionModeOption::new("acceptEdits", "Accept edits", &["--permission-mode", "acceptEdits"]),
            PermissionModeOption::new("plan", "Plan mode", &["--permission-mode", "plan"]),
        ])
        .with_session_id_arg("--session-id")
        .with_native_fork(&["--resume", "{session_id}", "--fork-session"])
        .with_approval(r"(Allow this action\?|\[y/n\]|Run command\?)", "y\n", "n\n")
}

/// omp (Oh-My-Pi), verified against `omp --help` (omp v18.10.3).
///
/// - model selection: `--model=<value>` — "Model to use (fuzzy match: "opus",
///   "gpt-5.2", or "openai/gpt-5.2")". The flag is real but `models` is left
///   empty on purpose: omp fuzzy-matches against whatever providers this machine
///   is authenticated with, so the set is per-install (`omp models` here reports
///   only `alibaba-token-plan` (19) and `antigravity` (1)). A baked-in list
///   would be a guess that is wrong on every other machine.
/// - permission/approval mode: `--approval-mode=<value>` — "Override
///   tools.approvalMode for this session (always-ask|write|yolo)". `always-ask`
///   is the default, so the `ask` option passes nothing. (`--auto-approve` also
///   exists; `--approval-mode=yolo` is the more explicit form.)
/// - effort/thinking: `--thinking=<value>` — "Set thinking level: off, minimal,
///   low, medium, high, xhigh, max, auto". A real flag, so no env var is needed.
///   Which levels a given model honours is per-model (`omp models` prints a
///   `thinking` column), so only the widely supported low/medium/high are
///   published.
/// - assigning a session id at start: **no such flag**. omp has
///   `--session-dir=<value>` for storage location and `--no-session`, but
///   nothing equivalent to `--session-id`, so `session_id_arg` is `None`.
/// - resuming/forking: `-r, --resume=<value>` and `--restore=<value>` exist, but
///   there is **no fork flag**, so a chosen session id cannot be forked —
///   `fork_support` is `handoff`.
fn omp_profile() -> AgentProfile {
    AgentProfile::new("omp", "Oh-My-Pi", "omp")
        .with_model_arg("--model")
        .with_effort_levels(vec![
            EffortLevel::from_args("Low", &["--thinking=low"]),
            EffortLevel::from_args("Medium", &["--thinking=medium"]),
            EffortLevel::from_args("High", &["--thinking=high"]),
        ])
        .with_permission_modes(vec![
            PermissionModeOption::ask("Ask"),
            PermissionModeOption::new("bypass", "Bypass approvals", &["--approval-mode=yolo"]),
            PermissionModeOption::new("write", "Auto-approve writes", &["--approval-mode=write"]),
        ])
        .with_approval(r"(\[y/n\]|Confirm\?)", "y\n", "n\n")
}

/// Aider — **UNVERIFIED**: `aider` is not installed on the reference machine, so
/// nothing below could be checked against `aider --help`. These are the
/// long-documented flags from aider's own options list:
///
/// - model selection: `--model MODEL` ("Specify the model to use for the main
///   chat"). aider forwards the value to litellm, so any `provider/model` string
///   is legal and no static alias list is truthful — `models` stays empty.
/// - permission/approval mode: `--yes-always` ("Skip confirmation prompts and
///   answer 'yes' to all of them"). Prompting is the default, so `ask` passes
///   nothing.
/// - effort/thinking: none claimed.
/// - assigning a session id at start: none claimed.
/// - resuming/forking: aider restores the previous chat history by default but
///   exposes no fork-a-given-session-id flag, so `fork_support` is `handoff`.
fn aider_profile() -> AgentProfile {
    AgentProfile::new("aider", "Aider", "aider")
        .with_model_arg("--model")
        .with_permission_modes(vec![
            PermissionModeOption::ask("Ask"),
            PermissionModeOption::new("bypass", "Bypass approvals", &["--yes-always"]),
        ])
}

/// Returns the predefined list of default agent profile templates.
pub fn get_default_profiles() -> Vec<AgentProfile> {
    vec![
        claude_code_profile(),
        omp_profile(),
        aider_profile(),
        // A blank slate: the user supplies the command, so nothing here may
        // claim models, effort levels, permission modes, or session handling.
        AgentProfile::new("generic", "Custom CLI", ""),
    ]
}

/// Resolves default profiles and updates their detection status against the user's path.
///
/// Uses the cached user environment to avoid launching the login shell multiple times.
pub fn get_available_agent_profiles() -> Vec<AgentProfile> {
    let path_var = match env_resolver::cached_user_env() {
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
