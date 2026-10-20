//! Strict parsing of the ACP agent registry. Each entry is validated on its own,
//! so one malformed entry never hides the others.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::resolve::LEGACY_IDS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RegistryEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub distribution: Distribution,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "DistributionWire", into = "DistributionWire")]
pub enum Distribution {
    Npx {
        package: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
    },
    Uvx {
        package: String,
        args: Vec<String>,
        env: BTreeMap<String, String>,
    },
    Binary {
        platforms: BTreeMap<String, BinaryTarget>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BinaryTarget {
    pub archive: String,
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
struct PackageWire {
    package: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    env: BTreeMap<String, String>,
}

/// The registry's own `distribution` shape: exactly one of the three keys.
#[derive(Serialize, Deserialize)]
struct DistributionWire {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    npx: Option<PackageWire>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    uvx: Option<PackageWire>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    binary: Option<BTreeMap<String, BinaryTarget>>,
}

impl TryFrom<DistributionWire> for Distribution {
    type Error = String;

    fn try_from(wire: DistributionWire) -> Result<Self, String> {
        match (wire.npx, wire.uvx, wire.binary) {
            (Some(p), None, None) => Ok(Self::Npx {
                package: p.package,
                args: p.args,
                env: p.env,
            }),
            (None, Some(p), None) => Ok(Self::Uvx {
                package: p.package,
                args: p.args,
                env: p.env,
            }),
            (None, None, Some(platforms)) => Ok(Self::Binary { platforms }),
            _ => Err("distribution must have exactly one of npx, uvx or binary".into()),
        }
    }
}

impl From<Distribution> for DistributionWire {
    fn from(distribution: Distribution) -> Self {
        let empty = || DistributionWire {
            npx: None,
            uvx: None,
            binary: None,
        };
        match distribution {
            Distribution::Npx { package, args, env } => DistributionWire {
                npx: Some(PackageWire { package, args, env }),
                ..empty()
            },
            Distribution::Uvx { package, args, env } => DistributionWire {
                uvx: Some(PackageWire { package, args, env }),
                ..empty()
            },
            Distribution::Binary { platforms } => DistributionWire {
                binary: Some(platforms),
                ..empty()
            },
        }
    }
}

/// Parses a registry document, keeping only the entries that pass validation.
/// Fails only when the document itself is not a registry.
pub fn parse_registry(json: &str) -> Result<Vec<RegistryEntry>, String> {
    let root: Value =
        serde_json::from_str(json).map_err(|e| format!("registry is not valid JSON: {e}"))?;
    let agents = root
        .get("agents")
        .and_then(Value::as_array)
        .ok_or_else(|| "registry has no agents list".to_string())?;
    Ok(agents.iter().filter_map(parse_entry).collect())
}

/// Deserializes one registry entry and applies the validation rules; `None` when
/// it is malformed or fails them. Shared by the registry and the version history.
pub fn parse_entry(value: &Value) -> Option<RegistryEntry> {
    serde_json::from_value::<RegistryEntry>(value.clone())
        .ok()
        .filter(is_valid_entry)
}

/// The platform key the registry uses for this machine, e.g. `darwin-aarch64`.
pub fn current_platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-aarch64",
        ("macos", "x86_64") => "darwin-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        ("linux", "x86_64") => "linux-x86_64",
        ("windows", "aarch64") => "windows-aarch64",
        ("windows", "x86_64") => "windows-x86_64",
        _ => "unsupported",
    }
}

/// Ids the app already uses for something else: the old built-in ACP agents
/// (migrated to their registry ids) and the removed agents, whose ids stay
/// reserved because the frontend still strips them from saved settings.
const REMOVED_AGENT_IDS: [&str; 2] = ["omp", "aider"];

fn is_reserved_id(id: &str) -> bool {
    LEGACY_IDS.iter().any(|(legacy, _)| *legacy == id) || REMOVED_AGENT_IDS.contains(&id)
}

/// A binary's version is checked too: the installer joins it into a path
/// under `tools/`. An npx or uvx version is only shown; its package is pinned.
fn is_valid_entry(entry: &RegistryEntry) -> bool {
    is_valid_id(&entry.id)
        && !is_reserved_id(&entry.id)
        && match &entry.distribution {
            Distribution::Npx { package, env, .. } => {
                is_pinned_npm_package(package) && is_safe_env(env)
            }
            Distribution::Uvx { package, env, .. } => {
                (is_pinned_npm_package(package) || is_pinned_pypi_package(package))
                    && is_safe_env(env)
            }
            Distribution::Binary { platforms } => {
                // Only this machine's target matters; others are kept but never run.
                // An entry without one stays in the catalog, shown as unsupported.
                is_exact_version(&entry.version)
                    && platforms
                        .get(current_platform())
                        .is_none_or(|t| is_valid_binary_target(t) && is_safe_env(&t.env))
            }
        }
}

/// `^[a-z0-9][a-z0-9-]*$`
fn is_valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `name@X.Y.Z` where `name` is a plain npm package name, so the package can
/// never be read as a command-line option or a URL.
fn is_pinned_npm_package(package: &str) -> bool {
    let Some(at) = package.rfind('@').filter(|&i| i > 0) else {
        return false;
    };
    is_npm_name(&package[..at]) && is_exact_version(&package[at + 1..])
}

/// `^(@[a-z0-9~][a-z0-9-._~]*/)?[a-z0-9~][a-z0-9-._~]*$`: no leading `-` or
/// `.`, no `:`, and `/` only after a scope.
fn is_npm_name(name: &str) -> bool {
    match name.strip_prefix('@') {
        Some(scoped) => scoped
            .split_once('/')
            .is_some_and(|(scope, rest)| is_npm_name_part(scope) && is_npm_name_part(rest)),
        None => is_npm_name_part(name),
    }
}

fn is_npm_name_part(part: &str) -> bool {
    let mut chars = part.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '~')
        && chars.all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '.' | '_' | '~')
        })
}

/// PyPI style `name==X.Y.Z`, `name` matching `^[A-Za-z0-9][A-Za-z0-9._-]*$`.
fn is_pinned_pypi_package(package: &str) -> bool {
    package
        .split_once("==")
        .is_some_and(|(name, version)| is_pypi_name(name) && is_exact_version(version))
}

fn is_pypi_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Prefixes of variables that steer the loader, a runtime or a package manager.
const DENIED_ENV_PREFIXES: [&str; 7] = [
    "DYLD_",
    "LD_",
    "NPM_CONFIG_",
    "UV_",
    "PIP_",
    "PYTHON",
    "NODE_",
];

/// Variables that steer the search path, the shell, proxies or trusted certificates.
const DENIED_ENV_KEYS: [&str; 13] = [
    "PATH",
    "HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "BASH_ENV",
    "ENV",
    "SHELL",
];

/// Variable names must look like `^[A-Z_][A-Z0-9_]*$` and must not be denied.
fn is_safe_env(env: &BTreeMap<String, String>) -> bool {
    env.keys().all(|key| is_safe_env_key(key))
}

/// One variable name that passes the `is_safe_env` rules.
pub(crate) fn is_safe_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_uppercase() || c == '_')
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        && !DENIED_ENV_KEYS.contains(&key)
        && !DENIED_ENV_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
}

/// `^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$`
fn is_exact_version(version: &str) -> bool {
    let core_end = version.find(['-', '+']).unwrap_or(version.len());
    let (core, suffix) = version.split_at(core_end);
    let parts: Vec<&str> = core.split('.').collect();
    let core_ok = parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    let suffix_ok = suffix.is_empty()
        || (suffix.len() > 1
            && suffix[1..]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'));
    core_ok && suffix_ok
}

fn is_valid_binary_target(target: &BinaryTarget) -> bool {
    target.archive.starts_with("https://")
        && is_sha256(&target.sha256)
        && is_safe_relative_cmd(&target.cmd)
        && !is_generic_program(&target.cmd)
}

/// Programs a Mac may already have that run whatever they are given. A binary
/// agent is found on `PATH` by its `cmd`'s file name, so one named like these
/// would count as installed and run the registry's args with that program.
const GENERIC_PROGRAMS: &[&str] = &[
    "git",
    "awk",
    "gawk",
    "nawk",
    "sed",
    "tclsh",
    "wish",
    "expect",
    "ssh",
    "scp",
    "curl",
    "wget",
    "make",
    "xargs",
    "env",
    "sudo",
    "open",
    "osascript",
    "sh",
    "bash",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "csh",
    "tcsh",
    "deno",
    "bun",
    "npx",
    "npm",
    "pnpm",
    "yarn",
    "uv",
    "uvx",
];

/// Interpreter and runtime families, matched as a prefix so versioned names
/// (`python3.12`, `node22`, `lua5.4`) are caught too.
const GENERIC_PROGRAM_PREFIXES: &[&str] = &[
    "python",
    "pip",
    "node",
    "ruby",
    "perl",
    "php",
    "lua",
    "java",
    "swift",
    "pwsh",
    "powershell",
];

/// True when `cmd`'s file name (any case) is a general-purpose program or
/// starts like an interpreter or runtime.
fn is_generic_program(cmd: &str) -> bool {
    let name = cmd.rsplit('/').next().unwrap_or(cmd).to_ascii_lowercase();
    GENERIC_PROGRAMS.contains(&name.as_str())
        || GENERIC_PROGRAM_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

/// A path inside the archive: relative (a leading `./` is fine) and never climbing out.
fn is_safe_relative_cmd(cmd: &str) -> bool {
    !cmd.is_empty()
        && !cmd.starts_with('/')
        && !cmd.contains('\\')
        && !cmd.split('/').any(|part| part == "..")
}
