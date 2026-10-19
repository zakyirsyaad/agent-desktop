//! The pinned Node.js and uv Zorvo can install, and the choice between the
//! user's own Node and a runtime Zorvo installed itself.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::layout::{read_record, ToolsDir};
use crate::env_resolver::find_binary_in_path_str;

/// The manifest compiled into the app. Only the app's own build can change it.
pub const BUNDLED_RUNTIMES: &str = include_str!("../../resources/runtimes.json");

/// The oldest Node major the user's own install may have to be used for `npx` agents.
pub const MIN_USER_NODE_MAJOR: u32 = 22;

/// How long `node --version` may take in production.
pub const NODE_VERSION_TIMEOUT: Duration = Duration::from_secs(5);

const NODE_URL_PREFIX: &str = "https://nodejs.org/dist/";
const UV_URL_PREFIX: &str = "https://github.com/astral-sh/uv/releases/download/";
const SHA256_HEX_LEN: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Node,
    Uv,
}

impl RuntimeKind {
    pub fn parse(kind: &str) -> Option<Self> {
        match kind {
            "node" => Some(Self::Node),
            "uv" => Some(Self::Uv),
            _ => None,
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Node => "Node.js",
            Self::Uv => "uv",
        }
    }

    fn url_prefix(self) -> &'static str {
        match self {
            Self::Node => NODE_URL_PREFIX,
            Self::Uv => UV_URL_PREFIX,
        }
    }

    pub(super) fn dir(self, tools: &ToolsDir, version: &str, platform: &str) -> PathBuf {
        match self {
            Self::Node => tools.node_dir(version, platform),
            Self::Uv => tools.uv_dir(version, platform),
        }
    }

    /// The folder under `tools` that holds every installed version.
    fn kind_root(self, tools: &ToolsDir) -> PathBuf {
        tools.root().join(match self {
            Self::Node => "node",
            Self::Uv => "uv",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RuntimeTarget {
    pub url: String,
    pub sha256: String,
    pub size: u64,
    /// The folder inside the unpacked archive that holds the executables.
    pub bin: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RuntimeRelease {
    pub version: String,
    pub released: String,
    pub targets: BTreeMap<String, RuntimeTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct RuntimeManifest {
    pub node: RuntimeRelease,
    pub uv: RuntimeRelease,
}

impl RuntimeManifest {
    pub fn release(&self, kind: RuntimeKind) -> &RuntimeRelease {
        match kind {
            RuntimeKind::Node => &self.node,
            RuntimeKind::Uv => &self.uv,
        }
    }
}

/// Parses a manifest and rejects anything that could download from the wrong
/// place, carry a malformed checksum or unpack outside its install dir.
pub fn parse_manifest(json: &str) -> Result<RuntimeManifest, String> {
    let manifest: RuntimeManifest =
        serde_json::from_str(json).map_err(|e| format!("Invalid runtime manifest: {e}"))?;
    for kind in [RuntimeKind::Node, RuntimeKind::Uv] {
        let release = manifest.release(kind);
        for (platform, target) in &release.targets {
            validate_target(kind, platform, target)?;
        }
    }
    Ok(manifest)
}

fn validate_target(
    kind: RuntimeKind,
    platform: &str,
    target: &RuntimeTarget,
) -> Result<(), String> {
    let name = kind.display_name();
    if !target.url.starts_with(kind.url_prefix()) {
        return Err(format!(
            "{name} download for {platform} is not under {}",
            kind.url_prefix()
        ));
    }
    let is_hex = target.sha256.bytes().all(|b| b.is_ascii_hexdigit());
    if target.sha256.len() != SHA256_HEX_LEN || !is_hex {
        return Err(format!("{name} checksum for {platform} is not a SHA-256"));
    }
    if !is_relative_path_without_parent(&target.bin) {
        return Err(format!(
            "{name} bin folder for {platform} is not a safe relative path"
        ));
    }
    Ok(())
}

fn is_relative_path_without_parent(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

/// The major version in `node --version` output such as `v22.0.0`.
pub fn parse_node_major(output: &str) -> Option<u32> {
    output
        .trim()
        .strip_prefix('v')?
        .split('.')
        .next()?
        .parse()
        .ok()
}

/// The major version of the user's own Node, or `None` unless both `node` and
/// `npx` are on the env's `PATH` and `node --version` answers within `timeout`.
pub fn user_node_major(env: &HashMap<String, String>, timeout: Duration) -> Option<u32> {
    let path_var = env.get("PATH")?;
    let node = find_binary_in_path_str("node", path_var)?;
    find_binary_in_path_str("npx", path_var)?;

    let mut child = Command::new(node)
        .arg("--version")
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };

    // Read on another thread so a hung node never blocks past the timeout.
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut output = String::new();
        let read = stdout.take(256).read_to_string(&mut output).map(|_| output);
        let _ = sender.send(read);
    });
    let output = receiver.recv_timeout(timeout);
    let _ = child.kill();
    let _ = child.wait();
    match output {
        Ok(Ok(output)) => parse_node_major(&output),
        _ => None,
    }
}

/// A runtime Zorvo installed, with the folder to put on `PATH`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledRuntime {
    pub version: String,
    pub bin_dir: PathBuf,
}

/// The pinned version when installed, else the newest other installed version
/// for `platform`. A dir counts only with an `install.json`, since a crash can
/// leave an empty one.
pub fn installed_runtime(
    tools: &ToolsDir,
    kind: RuntimeKind,
    manifest: &RuntimeManifest,
    platform: &str,
) -> Option<InstalledRuntime> {
    let release = manifest.release(kind);
    let pinned_dir = kind.dir(tools, &release.version, platform);
    if read_record(&pinned_dir).is_some() {
        let target = release.targets.get(platform)?;
        return Some(InstalledRuntime {
            version: release.version.clone(),
            bin_dir: pinned_dir.join(&target.bin),
        });
    }

    let suffix = format!("-{platform}");
    let mut found: Vec<InstalledRuntime> = fs::read_dir(kind.kind_root(tools))
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let version = name.strip_suffix(&suffix)?.to_string();
            let bin = read_record(&entry.path())?.bin?;
            if !is_relative_path_without_parent(&bin) {
                return None;
            }
            Some(InstalledRuntime {
                version,
                bin_dir: entry.path().join(bin),
            })
        })
        .collect();
    found.sort_by_key(|r| version_key(&r.version));
    found.pop()
}

/// Orders dotted versions numerically (`22.10.0` after `22.9.0`).
fn version_key(version: &str) -> Vec<u64> {
    version
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}
