//! Fork handoff persistence.
//!
//! Forking a conversation writes everything up to the chosen message into a
//! markdown document that the new agent session is told to read first. The
//! document lives under `<app data dir>/handoffs/<id>.md` and is written
//! through a synced temp file plus rename, so a crash mid-write cannot leave a
//! half-written handoff that a later session would read as complete. On Unix
//! the file is created owner-only (0600) because it holds a conversation
//! transcript.
//!
//! The id comes from the frontend and is used verbatim as a file name, so it is
//! validated against a boring character set before it ever reaches the path.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Hard ceiling for one handoff document, in bytes. Larger documents are rejected, not truncated.
pub const MAX_HANDOFF_BYTES: usize = 256 * 1024;

/// Longest accepted handoff id, in characters.
pub const MAX_HANDOFF_ID_LEN: usize = 64;

/// Directory under the app data root that holds handoff documents.
pub const HANDOFF_DIR: &str = "handoffs";

/// Unix permissions for handoff files: readable and writable by the owner only.
#[cfg(unix)]
const HANDOFF_FILE_MODE: u32 = 0o600;

/// Opens `path` for writing, truncating it, owner-only on Unix.
fn create_private_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(HANDOFF_FILE_MODE);
    }
    options.open(path)
}

/// Writes and fsyncs `content`, so the rename never publishes an empty file.
fn write_synced(path: &Path, content: &str) -> std::io::Result<()> {
    let mut file = create_private_file(path)?;
    file.write_all(content.as_bytes())?;
    file.sync_all()
}

/// Accepts 1..=`MAX_HANDOFF_ID_LEN` characters of `[A-Za-z0-9_-]` and nothing else.
///
/// Anything with a separator, dot, space, or non-ASCII character is rejected so the
/// id can never escape `HANDOFF_DIR` or name an unexpected file.
pub fn validate_handoff_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > MAX_HANDOFF_ID_LEN {
        return Err(format!(
            "Handoff id must be 1 to {MAX_HANDOFF_ID_LEN} characters, got {}",
            id.chars().count()
        ));
    }
    let is_allowed = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    if !id.chars().all(is_allowed) {
        return Err(format!(
            "Handoff id {id:?} may only contain letters, digits, '_' and '-'"
        ));
    }
    Ok(())
}

/// Resolves `<root>/handoffs/<id>.md`, validating the id first and touching no files.
pub fn handoff_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    validate_handoff_id(id)?;
    Ok(root.join(HANDOFF_DIR).join(format!("{id}.md")))
}

/// Atomically writes `content` to `<root>/handoffs/<id>.md` and returns the final path.
///
/// Rejects an invalid id or oversized content before creating anything, writes to a
/// temp file in the same directory, renames it over the target, and cleans the temp
/// file up again if the rename fails.
pub fn write_handoff(root: &Path, id: &str, content: &str) -> Result<PathBuf, String> {
    let path = handoff_path(root, id)?;
    if content.len() > MAX_HANDOFF_BYTES {
        return Err(format!(
            "Handoff is {} bytes, the limit is {MAX_HANDOFF_BYTES} bytes",
            content.len()
        ));
    }

    let dir = root.join(HANDOFF_DIR);
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create handoff dir {}: {e}", dir.display()))?;

    let tmp_path = dir.join(format!(".{id}.md.tmp"));
    if let Err(e) = write_synced(&tmp_path, content) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!(
            "Failed to write handoff {}: {e}",
            tmp_path.display()
        ));
    }
    if let Err(e) = fs::rename(&tmp_path, &path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed to save handoff {}: {e}", path.display()));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static DIR_COUNTER: AtomicU32 = AtomicU32::new(0);

    /// Unique temp dir that removes itself on drop, so a failing test leaves nothing behind.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(label: &str) -> Self {
            let unique = DIR_COUNTER.fetch_add(1, Ordering::SeqCst);
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let path =
                std::env::temp_dir().join(format!("zorvo-handoff-{}-{}-{}", label, nanos, unique));
            fs::create_dir_all(&path).expect("the test temp dir should be creatable");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }

        fn handoff_dir(&self) -> PathBuf {
            self.path.join(HANDOFF_DIR)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    /// Entries in `dir`, or 0 when the directory does not exist.
    fn count_entries(dir: &Path) -> usize {
        match fs::read_dir(dir) {
            Ok(entries) => entries.filter_map(Result::ok).count(),
            Err(_) => 0,
        }
    }

    const VALID_ID: &str = "abc-DEF_123";

    #[test]
    fn validate_accepts_letters_digits_underscore_and_hyphen() {
        assert!(validate_handoff_id(VALID_ID).is_ok());
        assert!(validate_handoff_id("a").is_ok());
        assert!(validate_handoff_id("_-_").is_ok());
    }

    #[test]
    fn validate_accepts_exactly_max_handoff_id_len_characters() {
        let id = "a".repeat(MAX_HANDOFF_ID_LEN);
        assert_eq!(id.chars().count(), MAX_HANDOFF_ID_LEN);
        assert!(validate_handoff_id(&id).is_ok());
    }

    #[test]
    fn validate_rejects_an_empty_id() {
        assert!(validate_handoff_id("").is_err());
    }

    #[test]
    fn validate_rejects_an_id_one_character_too_long() {
        let id = "a".repeat(MAX_HANDOFF_ID_LEN + 1);
        assert!(validate_handoff_id(&id).is_err());
    }

    #[test]
    fn validate_rejects_ids_that_could_escape_the_handoff_dir() {
        for id in ["../x", "..", ".", "a/b", "a\\b", "/abs"] {
            assert!(validate_handoff_id(id).is_err(), "{id:?} must be rejected");
        }
    }

    #[test]
    fn validate_rejects_dots_spaces_and_other_punctuation() {
        for id in ["a.b", "a b", "a\tb", "a:b", "a$b", "a*b", "a.md"] {
            assert!(validate_handoff_id(id).is_err(), "{id:?} must be rejected");
        }
    }

    #[test]
    fn validate_rejects_non_ascii_ids() {
        for id in ["héllo", "日本語", "ａｂｃ"] {
            assert!(validate_handoff_id(id).is_err(), "{id:?} must be rejected");
        }
    }

    #[test]
    fn validate_returns_a_non_empty_reason() {
        let err = validate_handoff_id("../x").unwrap_err();
        assert!(!err.is_empty());
    }

    #[test]
    fn handoff_path_resolves_to_handoffs_dir_under_the_root() {
        let tmp = TempDir::new("path");

        let path = handoff_path(tmp.path(), VALID_ID).expect("a valid id resolves");

        assert!(path.starts_with(tmp.path()));
        assert!(path.ends_with(format!("{HANDOFF_DIR}/{VALID_ID}.md")));
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some("abc-DEF_123.md")
        );
        assert_eq!(
            path.parent()
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str()),
            Some(HANDOFF_DIR)
        );
    }

    #[test]
    fn handoff_path_rejects_an_invalid_id_without_touching_the_filesystem() {
        let tmp = TempDir::new("path-invalid");

        assert!(handoff_path(tmp.path(), "../escape").is_err());
        assert!(handoff_path(tmp.path(), "").is_err());

        assert!(!tmp.handoff_dir().join("escape.md").exists());
    }

    #[test]
    fn write_handoff_writes_the_exact_content_and_returns_an_existing_path() {
        let tmp = TempDir::new("write");
        let content = "# Session handoff\n\n- Source session: s-1\n- Agent: Aider\n";

        let path = write_handoff(tmp.path(), VALID_ID, content).expect("the write should succeed");

        assert!(path.exists(), "the returned path should exist");
        assert_eq!(path, handoff_path(tmp.path(), VALID_ID).expect("valid id"));
        assert_eq!(fs::read_to_string(&path).expect("readable"), content);
    }

    #[test]
    fn write_handoff_creates_the_handoffs_dir_when_it_is_missing() {
        let tmp = TempDir::new("create-dir");
        assert!(!tmp.handoff_dir().exists());

        write_handoff(tmp.path(), VALID_ID, "content").expect("the write should succeed");

        assert!(tmp.handoff_dir().is_dir());
    }

    #[test]
    fn write_handoff_overwrites_an_existing_handoff_in_place() {
        let tmp = TempDir::new("overwrite");
        write_handoff(tmp.path(), VALID_ID, "first version with a long tail").expect("first write");

        let path = write_handoff(tmp.path(), VALID_ID, "second").expect("second write");

        assert_eq!(fs::read_to_string(&path).expect("readable"), "second");
        assert_eq!(count_entries(&tmp.handoff_dir()), 1);
    }

    #[test]
    fn write_handoff_leaves_no_temp_file_behind() {
        let tmp = TempDir::new("no-temp");
        write_handoff(tmp.path(), VALID_ID, "content").expect("the write should succeed");

        let leftovers: Vec<String> = fs::read_dir(tmp.handoff_dir())
            .expect("the handoff dir should exist")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp") || name.starts_with('.'))
            .collect();

        assert!(leftovers.is_empty(), "unexpected leftovers: {leftovers:?}");
        assert_eq!(count_entries(&tmp.handoff_dir()), 1);
    }

    #[test]
    fn write_handoff_accepts_content_at_exactly_the_byte_limit() {
        let tmp = TempDir::new("max-bytes");
        let content = "a".repeat(MAX_HANDOFF_BYTES);

        let path = write_handoff(tmp.path(), VALID_ID, &content).expect("the limit is inclusive");

        assert_eq!(
            fs::read_to_string(&path).expect("readable").len(),
            MAX_HANDOFF_BYTES
        );
    }

    #[test]
    fn write_handoff_rejects_content_one_byte_over_the_limit_without_creating_the_file() {
        let tmp = TempDir::new("over-limit");
        let content = "a".repeat(MAX_HANDOFF_BYTES + 1);

        let err = write_handoff(tmp.path(), VALID_ID, &content).unwrap_err();

        assert!(!err.is_empty());
        assert!(!tmp.handoff_dir().join(format!("{VALID_ID}.md")).exists());
        assert_eq!(count_entries(&tmp.handoff_dir()), 0);
    }

    #[test]
    fn write_handoff_measures_the_limit_in_bytes_not_characters() {
        let tmp = TempDir::new("byte-limit");
        // Each あ is three bytes in UTF-8, so this is far fewer characters than the byte cap.
        let content = "あ".repeat(MAX_HANDOFF_BYTES / 3 + 1);
        assert!(content.len() > MAX_HANDOFF_BYTES);
        assert!(content.chars().count() < MAX_HANDOFF_BYTES);

        assert!(write_handoff(tmp.path(), VALID_ID, &content).is_err());
        assert!(!tmp.handoff_dir().join(format!("{VALID_ID}.md")).exists());
    }

    #[test]
    fn write_handoff_rejects_an_invalid_id_without_writing_anything() {
        let tmp = TempDir::new("invalid-id");
        let too_long = "x".repeat(MAX_HANDOFF_ID_LEN + 1);

        for id in ["", "../evil", "a/b", "a b", "a.b", too_long.as_str()] {
            assert!(
                write_handoff(tmp.path(), id, "payload").is_err(),
                "{id:?} must be rejected"
            );
        }

        assert!(!tmp.handoff_dir().join("evil.md").exists());
        assert!(!tmp.path().join("evil.md").exists());
        assert_eq!(count_entries(&tmp.handoff_dir()), 0);
    }

    #[test]
    fn write_handoff_preserves_utf8_content_byte_for_byte() {
        let tmp = TempDir::new("utf8");
        let content = "# 会话交接\n\n- Source session: café — naïve\n";

        let path = write_handoff(tmp.path(), VALID_ID, content).expect("the write should succeed");

        assert_eq!(fs::read_to_string(&path).expect("readable"), content);
    }

    #[cfg(unix)]
    #[test]
    fn write_handoff_creates_an_owner_only_file() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new("mode");

        let path = write_handoff(tmp.path(), VALID_ID, "secret").expect("the write should succeed");

        let mode = fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
        assert_eq!(mode, HANDOFF_FILE_MODE);
    }
}
