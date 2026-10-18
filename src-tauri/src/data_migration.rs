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

use crate::store::{atomic_write, AppStore, STATE_FILE, STATE_TMP_FILE, WORKTREES_DIR};

/// The bundle identifier, and so the data directory name, before the rename.
pub const LEGACY_IDENTIFIER: &str = "com.agentdesktop.app";

/// Top-level entries that are not copied. `worktrees/` holds git checkouts
/// registered with their repository by absolute path: a copy would be an
/// unregistered duplicate, and sessions keep using the originals (the store
/// is told about the legacy worktrees folder so it can still remove them).
const SKIPPED_ENTRIES: &[&str] = &[STATE_FILE, STATE_TMP_FILE, WORKTREES_DIR];

/// Written in the new directory before a copy starts and removed once it
/// finished, so a failed copy is retried even after the store saved.
const PENDING_MARKER: &str = "legacy-migration-pending";

/// Written in the new directory once a copy finished: its state came from the
/// legacy directory, whose worktrees the migrated sessions still use.
const DONE_MARKER: &str = "legacy-migration-done";

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
///
/// Its `worktrees/` folder is `legacy_root_for(..).join(WORKTREES_DIR)`.
pub fn legacy_root_for(new_root: &Path) -> Option<PathBuf> {
    new_root
        .parent()
        .map(|parent| parent.join(LEGACY_IDENTIFIER))
}

/// Whether `new_root`'s state was copied from the legacy directory.
pub fn migrated_from_legacy(new_root: &Path) -> bool {
    new_root.join(DONE_MARKER).is_file()
}

/// Copies the legacy data directory into `new_root` when `legacy_root` has a
/// `state.json` and `new_root` has none, or has one but an earlier copy failed.
///
/// A copy that fails or is interrupted leaves [`PENDING_MARKER`] behind and is
/// retried on the next launch. The retry replaces whatever state was saved in
/// between, which started empty because the copy failed. Without a legacy
/// `state.json` there are no sessions to bring over.
pub fn migrate_legacy_data(legacy_root: &Path, new_root: &Path) -> Result<Migration, String> {
    let legacy_state = legacy_root.join(STATE_FILE);
    let pending = new_root.join(PENDING_MARKER);
    let new_root_in_use = new_root.join(STATE_FILE).exists() && !pending.exists();
    if migrated_from_legacy(new_root) || new_root_in_use || !legacy_state.is_file() {
        return Ok(Migration::NotNeeded);
    }

    fs::create_dir_all(new_root)
        .map_err(|e| format!("Cannot create {}: {e}", new_root.display()))?;
    write_marker(&pending)?;

    for entry in read_dir(legacy_root)? {
        let name = entry.file_name();
        if SKIPPED_ENTRIES.iter().any(|skip| name == *skip) {
            continue;
        }
        copy_entry(&entry.path(), &new_root.join(&name))?;
    }

    let state = fs::read(&legacy_state)
        .map_err(|e| format!("Cannot read {}: {e}", legacy_state.display()))?;
    atomic_write(
        &new_root.join(STATE_FILE),
        &new_root.join(STATE_TMP_FILE),
        &state,
    )?;
    write_marker(&new_root.join(DONE_MARKER))?;
    fs::remove_file(&pending).map_err(|e| format!("Cannot remove {}: {e}", pending.display()))?;
    Ok(Migration::Copied)
}

/// Builds the store over `data_dir`, first copying the legacy data into it.
///
/// The store is returned even when the copy failed, so the app still starts;
/// the caller reports the error. The legacy worktrees folder is accepted for
/// worktree removal only once a copy finished, since only then do saved
/// sessions point into it.
pub fn open_store(data_dir: PathBuf) -> (AppStore, Result<Migration, String>) {
    let Some(legacy_root) = legacy_root_for(&data_dir) else {
        return (AppStore::new(data_dir), Ok(Migration::NotNeeded));
    };
    let migration = migrate_legacy_data(&legacy_root, &data_dir);
    let store = if migrated_from_legacy(&data_dir) {
        AppStore::new(data_dir).with_legacy_worktrees_root(legacy_root.join(WORKTREES_DIR))
    } else {
        AppStore::new(data_dir)
    };
    (store, migration)
}

fn write_marker(path: &Path) -> Result<(), String> {
    fs::write(path, LEGACY_IDENTIFIER).map_err(|e| format!("Cannot write {}: {e}", path.display()))
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
        // The source went away between listing and copying: nothing to keep.
        // A missing destination folder is a real failure and falls through.
        Err(e) if e.kind() == ErrorKind::NotFound && !from.exists() => Ok(()),
        Err(e) => Err(format!(
            "Cannot copy {} to {}: {e}",
            from.display(),
            to.display()
        )),
    }
}
