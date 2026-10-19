//! Strict parsing of the ACP agent registry. Each entry is validated on its own,
//! so one malformed entry never hides the others.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    },
    Uvx {
        package: String,
        args: Vec<String>,
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
}

#[derive(Serialize, Deserialize)]
struct PackageWire {
    package: String,
    #[serde(default)]
    args: Vec<String>,
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
            }),
            (None, Some(p), None) => Ok(Self::Uvx {
                package: p.package,
                args: p.args,
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
            Distribution::Npx { package, args } => DistributionWire {
                npx: Some(PackageWire { package, args }),
                ..empty()
            },
            Distribution::Uvx { package, args } => DistributionWire {
                uvx: Some(PackageWire { package, args }),
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

fn is_valid_entry(entry: &RegistryEntry) -> bool {
    is_valid_id(&entry.id)
        && match &entry.distribution {
            Distribution::Npx { package, .. } | Distribution::Uvx { package, .. } => {
                is_pinned_package(package)
            }
            Distribution::Binary { platforms } => {
                // Only this machine's target matters; others are kept but never run.
                platforms
                    .get(current_platform())
                    .is_some_and(is_valid_binary_target)
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

/// The text after the last `@` (not counting a leading scope `@`) must be an exact version.
fn is_pinned_package(package: &str) -> bool {
    let Some(at) = package.rfind('@').filter(|&i| i > 0) else {
        return false;
    };
    is_exact_version(&package[at + 1..])
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
