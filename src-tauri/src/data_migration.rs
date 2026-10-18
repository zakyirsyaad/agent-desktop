//! One-time copy of persisted data from the app's pre-Zorvo data directory.
//!
//! The app was called Agent Desktop with the bundle identifier
//! [`LEGACY_IDENTIFIER`]. The platform app-data directory is named after the
//! identifier, so renaming it left existing sessions and transcripts behind.
//! On startup [`migrate_legacy_data`] copies them into the new directory once.
//! The legacy directory is never changed, so an older build still finds its
//! data and records that point into it (worktree and handoff paths) stay valid.

use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// The bundle identifier, and so the data directory name, before the rename.
pub const LEGACY_IDENTIFIER: &str = "com.agentdesktop.app";

/// The file whose presence marks a data directory as in use.
const STATE_FILE: &str = "state.json";

/// The scratch file `state.json` is staged in, the same one the store uses.
const STATE_TMP_FILE: &str = "state.json.tmp";

/// Top-level entries that are not copied. `worktrees/` holds git checkouts
/// registered with their repository by absolute path: a copy would be an
/// unregistered duplicate, and sessions keep using the originals.
const SKIPPED_ENTRIES: &[&str] = &["worktrees", STATE_TMP_FILE];

/// What [`migrate_legacy_data`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Migration {
    /// Legacy data was copied into the new directory.
    Copied,
    /// The new directory was already in use, or there was nothing to copy.
    NotNeeded,
}

/// The legacy data directory beside `new_root`, since both live in the same
/// platform app-data parent.
pub fn legacy_root_for(new_root: &Path) -> Option<PathBuf> {
    new_root
        .parent()
        .map(|parent| parent.join(LEGACY_IDENTIFIER))
}

/// Copies the legacy data directory into `new_root` when `new_root` has no
/// `state.json` yet and `legacy_root` exists.
///
/// `state.json` is copied last, so a copy interrupted part way is finished by
/// the next launch instead of being taken as done.
pub fn migrate_legacy_data(legacy_root: &Path, new_root: &Path) -> Result<Migration, String> {
    if new_root.join(STATE_FILE).exists() || !legacy_root.is_dir() {
        return Ok(Migration::NotNeeded);
    }

    fs::create_dir_all(new_root)
        .map_err(|e| format!("Cannot create {}: {e}", new_root.display()))?;

    for entry in read_dir(legacy_root)? {
        let name = entry.file_name();
        if name == STATE_FILE || SKIPPED_ENTRIES.iter().any(|skip| name == *skip) {
            continue;
        }
        copy_entry(&entry.path(), &new_root.join(&name))?;
    }

    // Staged and renamed so a half-copied state.json never marks the copy done.
    let legacy_state = legacy_root.join(STATE_FILE);
    if legacy_state.is_file() {
        let staged = new_root.join(STATE_TMP_FILE);
        copy_file(&legacy_state, &staged)?;
        fs::rename(&staged, new_root.join(STATE_FILE))
            .map_err(|e| format!("Cannot move {} into place: {e}", staged.display()))?;
    }
    Ok(Migration::Copied)
}

fn read_dir(dir: &Path) -> Result<Vec<fs::DirEntry>, String> {
    fs::read_dir(dir)
        .and_then(|entries| entries.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("Cannot read {}: {e}", dir.display()))
}

/// Copies a file or a directory tree. Symlinks are skipped rather than
/// followed, so the copy cannot reach outside the legacy directory.
fn copy_entry(from: &Path, to: &Path) -> Result<(), String> {
    let file_type = fs::symlink_metadata(from)
        .map_err(|e| format!("Cannot inspect {}: {e}", from.display()))?
        .file_type();

    if file_type.is_dir() {
        fs::create_dir_all(to).map_err(|e| format!("Cannot create {}: {e}", to.display()))?;
        for entry in read_dir(from)? {
            copy_entry(&entry.path(), &to.join(entry.file_name()))?;
        }
        Ok(())
    } else if file_type.is_file() {
        copy_file(from, to)
    } else {
        Ok(())
    }
}

fn copy_file(from: &Path, to: &Path) -> Result<(), String> {
    match fs::copy(from, to) {
        Ok(_) => Ok(()),
        // The file went away between listing and copying: nothing to keep.
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!(
            "Cannot copy {} to {}: {e}",
            from.display(),
            to.display()
        )),
    }
}
