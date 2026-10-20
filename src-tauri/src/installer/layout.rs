//! Where installed tools live under the app data dir, and how a download
//! becomes one. Every install is built in a private staging dir and moved into
//! place with a single rename, so a crash or a failed download never leaves a
//! half-written tool at its final path.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const RECORD_FILE: &str = "install.json";

/// Keeps two stagings made in the same nanosecond of one process apart.
static STAGING_COUNTER: AtomicU64 = AtomicU64::new(0);

/// What was installed and where it came from, written next to the files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallRecord {
    pub source: String,
    pub sha256: Option<String>,
    pub installed_at: u64,
    pub bin: Option<String>,
}

/// Reads `install.json` from an installed dir; `None` when it is missing or unreadable.
pub fn read_record(dir: &Path) -> Option<InstallRecord> {
    let text = fs::read_to_string(dir.join(RECORD_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// Deletes whatever is at `path`, a dir with everything in it or a file,
/// without following a symlink there. Nothing there is not an error.
pub fn remove_path(path: &Path) -> Result<(), String> {
    let removed = match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) => Err(e),
    };
    match removed {
        Err(e) if e.kind() != ErrorKind::NotFound => {
            Err(format!("Could not remove {}: {e}", path.display()))
        }
        _ => Ok(()),
    }
}

/// How a commit ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitOutcome {
    Installed,
    /// The destination already existed (another install won); it was left alone.
    AlreadyPresent,
}

/// The `tools` folder under the app data dir.
#[derive(Debug, Clone)]
pub struct ToolsDir {
    root: PathBuf,
}

impl ToolsDir {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            root: data_dir.join("tools"),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn node_dir(&self, version: &str, platform: &str) -> PathBuf {
        self.root.join("node").join(format!("{version}-{platform}"))
    }

    pub fn uv_dir(&self, version: &str, platform: &str) -> PathBuf {
        self.root.join("uv").join(format!("{version}-{platform}"))
    }

    pub fn agent_dir(&self, id: &str, version: &str) -> PathBuf {
        self.root.join("agents").join(id).join(version)
    }

    pub fn prereq_dir(&self, command: &str, version: &str) -> PathBuf {
        self.root.join("prereqs").join(command).join(version)
    }

    /// Where unfinished installs are built. Kept inside `tools` so the final
    /// rename stays on one filesystem.
    pub fn staging_root(&self) -> PathBuf {
        self.root.join("staging")
    }

    /// Creates a fresh staging dir with an empty `content` folder inside.
    pub fn new_staging(&self) -> Result<Staging, String> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let counter = STAGING_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = self
            .staging_root()
            .join(format!("{}-{nanos}-{counter}", process::id()));
        let content = path.join("content");
        fs::create_dir_all(&content)
            .map_err(|e| format!("Could not create {}: {e}", content.display()))?;
        Ok(Staging { path })
    }
}

/// A private work dir for one install. Dropping it deletes it, so an install
/// that fails or is cancelled cleans up after itself.
#[derive(Debug)]
pub struct Staging {
    path: PathBuf,
}

impl Staging {
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Where the raw download is written.
    pub fn download_path(&self) -> PathBuf {
        self.path.join("download")
    }

    /// Where the unpacked tool is built; this folder becomes the install dir.
    pub fn content_path(&self) -> PathBuf {
        self.path.join("content")
    }

    /// Writes the record into `content` and renames it to `dest`. An existing
    /// `dest` is never touched: a parallel install of the same version already
    /// finished, and replacing it could break a tool in use.
    pub fn commit(self, dest: &Path, record: &InstallRecord) -> Result<CommitOutcome, String> {
        if dest.exists() {
            return Ok(CommitOutcome::AlreadyPresent);
        }
        let content = self.content_path();
        let json = serde_json::to_string_pretty(record)
            .map_err(|e| format!("Could not write the install record: {e}"))?;
        fs::write(content.join(RECORD_FILE), json)
            .map_err(|e| format!("Could not write the install record: {e}"))?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
        }
        match fs::rename(&content, dest) {
            Ok(()) => Ok(CommitOutcome::Installed),
            // Lost a race between the check above and the rename.
            Err(e)
                if matches!(
                    e.kind(),
                    ErrorKind::AlreadyExists | ErrorKind::DirectoryNotEmpty
                ) =>
            {
                Ok(CommitOutcome::AlreadyPresent)
            }
            Err(e) => Err(format!("Could not move the install into place: {e}")),
        }
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}
