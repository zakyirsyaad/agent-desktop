//! Turns a registry entry into an [`AgentProfile`] the rest of the app can launch.
//! The webview never supplies a program or args; they come from the pinned entry.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::env_resolver::find_binary_in_path_str;
use crate::profiles::{AgentProfile, TRANSPORT_ACP};
use crate::registry::schema::{current_platform, Distribution, RegistryEntry};

/// Old built-in profile ids and the registry ids that replace them.
pub const LEGACY_IDS: [(&str, &str); 3] = [
    ("claude-code", "claude-acp"),
    ("codex", "codex-acp"),
    ("qwen", "qwen-code"),
];

pub const SOURCE_REGISTRY: &str = "registry";
pub const AVAILABILITY_READY: &str = "ready";
pub const AVAILABILITY_NEEDS_RUNTIME: &str = "needs_runtime";
pub const AVAILABILITY_NOT_INSTALLED: &str = "not_installed";

/// Maps a legacy built-in id to its registry id; other ids come back unchanged.
pub fn canonical_agent_id(id: &str) -> &str {
    LEGACY_IDS
        .iter()
        .find(|(legacy, _)| *legacy == id)
        .map_or(id, |(_, canonical)| canonical)
}

/// What this machine has: the login-shell `PATH` and globally installed npm packages.
pub struct SystemTools<'a> {
    pub path_var: Option<&'a str>,
    pub npm_globals: &'a BTreeSet<String>,
}

impl SystemTools<'_> {
    fn locate(&self, binary: &str) -> Option<String> {
        self.path_var
            .and_then(|path_var| find_binary_in_path_str(binary, path_var))
            .map(|path| path.to_string_lossy().to_string())
    }

    /// The first `binary` on `PATH` that is not one of Apple's system tools,
    /// so a binary agent named like one never counts as installed.
    fn locate_user_installed(&self, binary: &str) -> Option<String> {
        self.path_var?
            .split(':')
            .filter_map(|dir| find_binary_in_path_str(binary, dir))
            .find(|path| !is_system_tool(path))
            .map(|path| path.to_string_lossy().to_string())
    }
}

/// Where Apple keeps its own command-line tools and developer tools.
pub const SYSTEM_TOOL_DIRS: &[&str] = &[
    "/usr/bin/",
    "/bin/",
    "/usr/sbin/",
    "/sbin/",
    "/System/",
    "/Library/Developer/",
    "/Applications/Xcode",
];

/// True when `path` is inside one of [`SYSTEM_TOOL_DIRS`].
pub fn is_system_tool_path(path: &str) -> bool {
    SYSTEM_TOOL_DIRS.iter().any(|dir| path.starts_with(dir))
}

/// [`is_system_tool_path`] for `path` as found or as it resolves through symlinks.
fn is_system_tool(path: &Path) -> bool {
    is_system_tool_path(&path.to_string_lossy())
        || std::fs::canonicalize(path)
            .is_ok_and(|real| is_system_tool_path(&real.to_string_lossy()))
}

/// `@scope/name@1.2.3` -> `@scope/name`; `name@1` -> `name`.
fn package_name(package: &str) -> &str {
    match package.rfind('@') {
        Some(at) if at > 0 => &package[..at],
        _ => package,
    }
}

fn basename(cmd: &str) -> &str {
    cmd.rsplit('/').next().unwrap_or(cmd)
}

pub fn resolve_profile(entry: &RegistryEntry, tools: &SystemTools, listed: bool) -> AgentProfile {
    let (kind, program, args, program_path, installed_on_system) = match &entry.distribution {
        Distribution::Npx { package, args, .. } => (
            "npx",
            "npx".to_string(),
            [vec!["-y".to_string(), package.clone()], args.clone()].concat(),
            tools.locate("npx"),
            tools.npm_globals.contains(package_name(package)),
        ),
        Distribution::Uvx { package, args, .. } => (
            "uvx",
            "uvx".to_string(),
            [vec![package.clone()], args.clone()].concat(),
            tools.locate("uvx"),
            false,
        ),
        Distribution::Binary { platforms } => {
            let target = platforms.get(current_platform());
            let program = target.map_or_else(String::new, |t| basename(&t.cmd).to_string());
            let args = target.map_or_else(Vec::new, |t| t.args.clone());
            let path = tools.locate_user_installed(&program);
            let installed = path.is_some();
            ("binary", program, args, path, installed)
        }
    };

    let availability = match (&program_path, kind) {
        (Some(_), _) => AVAILABILITY_READY,
        (None, "binary") => AVAILABILITY_NOT_INSTALLED,
        (None, _) => AVAILABILITY_NEEDS_RUNTIME,
    };

    let mut profile = AgentProfile::new(entry.id.clone(), entry.name.clone(), program.clone());
    profile.transport = TRANSPORT_ACP.to_string();
    profile.acp_program = Some(program);
    profile.acp_args = args;
    profile.detected = availability == AVAILABILITY_READY;
    profile.detected_path = program_path.clone();
    profile.acp_program_path = program_path;
    profile.source = SOURCE_REGISTRY.to_string();
    profile.version = Some(entry.version.clone());
    profile.distribution = Some(kind.to_string());
    profile.availability = availability.to_string();
    profile.description = entry.description.clone();
    profile.installed_on_system = installed_on_system;
    profile.listed = listed;
    profile
}

/// The environment variables the registry sets for this entry: the package's
/// own, or the current platform's target for a binary.
pub fn registry_env(entry: &RegistryEntry) -> BTreeMap<String, String> {
    match &entry.distribution {
        Distribution::Npx { env, .. } | Distribution::Uvx { env, .. } => env.clone(),
        Distribution::Binary { platforms } => platforms
            .get(current_platform())
            .map(|target| target.env.clone())
            .unwrap_or_default(),
    }
}

/// Why a profile cannot run, for the launch error; `None` when it is ready.
pub fn missing_reason(profile: &AgentProfile) -> Option<String> {
    match profile.availability.as_str() {
        AVAILABILITY_NEEDS_RUNTIME => {
            let (runtime, tool) = match profile.distribution.as_deref() {
                Some("uvx") => ("uv", "uvx"),
                _ => ("Node.js", "npx"),
            };
            Some(format!(
                "{} needs {runtime} ({tool}), which was not found",
                profile.name
            ))
        }
        AVAILABILITY_NOT_INSTALLED => Some(format!(
            "{} is not installed ({} was not found on PATH)",
            profile.name, profile.command
        )),
        _ => None,
    }
}
