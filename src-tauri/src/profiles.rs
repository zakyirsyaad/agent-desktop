use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::env_resolver;
use crate::registry::{self, resolve::SystemTools};

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

/// Driven over the Agent Client Protocol (structured JSON-RPC on stdin/stdout).
pub const TRANSPORT_ACP: &str = "acp";
/// Driven through a pseudo-terminal; the UI shows the agent's own terminal.
pub const TRANSPORT_PTY: &str = "pty";

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
    /// [`TRANSPORT_ACP`] or [`TRANSPORT_PTY`].
    pub transport: String,
    /// Program that speaks ACP for this agent (the CLI itself, or `npx` for an adapter).
    pub acp_program: Option<String>,
    pub acp_args: Vec<String>,
    /// Absolute path of `acp_program` on this machine, once detected.
    pub acp_program_path: Option<String>,
    /// `"registry"` or `"builtin"`.
    pub source: String,
    pub version: Option<String>,
    /// `"npx"`, `"uvx"` or `"binary"` for registry agents.
    pub distribution: Option<String>,
    /// `"ready"`, `"needs_runtime"` or `"not_installed"`.
    pub availability: String,
    pub description: Option<String>,
    /// The agent's own CLI is already installed on this machine.
    pub installed_on_system: bool,
    /// Still listed in the ACP registry (always true before the first fetch).
    pub listed: bool,
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
            transport: TRANSPORT_PTY.to_string(),
            acp_program: None,
            acp_args: Vec::new(),
            acp_program_path: None,
            source: "builtin".to_string(),
            version: None,
            distribution: None,
            availability: "ready".to_string(),
            description: None,
            installed_on_system: false,
            listed: true,
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

/// The built-in terminal agents. ACP agents come from the registry catalog.
pub fn get_default_profiles() -> Vec<AgentProfile> {
    vec![omp_profile(), aider_profile()]
}

/// [`agent_profiles`] at each registry agent's offered version.
pub fn get_available_agent_profiles() -> Vec<AgentProfile> {
    agent_profiles(&BTreeMap::new())
}

/// Every agent the app can run, detected against the user's `PATH`: the
/// registry agents first (at the version in `versions` when the catalog has
/// it, else the offered one), then the built-in terminal agents.
///
/// Uses the cached user environment to avoid launching the login shell multiple times.
pub fn agent_profiles(versions: &BTreeMap<String, String>) -> Vec<AgentProfile> {
    let path_var = match env_resolver::cached_user_env() {
        Ok(env_map) => env_map.get("PATH").cloned(),
        Err(_) => None,
    }
    .or_else(|| std::env::var("PATH").ok());

    let catalog = registry::catalog();
    let npm_globals = catalog.npm_globals();
    let tools = SystemTools {
        path_var: path_var.as_deref(),
        npm_globals: &npm_globals,
    };
    let from_registry = catalog.profiles(&tools, versions, registry::unix_now());
    let terminal: Vec<AgentProfile> = get_default_profiles()
        .into_iter()
        .filter(|builtin| from_registry.iter().all(|p| p.id != builtin.id))
        .map(|profile| detect(profile, path_var.as_deref()))
        .collect();
    from_registry.into_iter().chain(terminal).collect()
}

/// Marks a profile detected when its CLI is on PATH and, for ACP agents, the
/// program that speaks ACP (the CLI itself or `npx` for an adapter) is too.
fn detect(profile: AgentProfile, path_var: Option<&str>) -> AgentProfile {
    let locate = |binary: &str| {
        path_var
            .and_then(|pv| env_resolver::find_binary_in_path_str(binary, pv))
            .map(|path| path.to_string_lossy().to_string())
    };
    let detected_path = locate(&profile.command);
    let acp_program_path = profile.acp_program.as_deref().and_then(locate);
    let detected =
        detected_path.is_some() && (profile.acp_program.is_none() || acp_program_path.is_some());

    AgentProfile {
        detected,
        detected_path,
        acp_program_path,
        ..profile
    }
}
