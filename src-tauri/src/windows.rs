//! Detached session windows and "reveal in Finder" for a workspace folder.
//!
//! Both features take a string that reaches an OS surface — a window label and
//! URL, or a path handed to `open` — so the validation lives in pure functions
//! that the tests below can exercise without a running Tauri app.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
use std::process::Command;
#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;

/// Longest session id accepted in a window label or a popout URL.
pub const MAX_SESSION_ID_LEN: usize = 64;
/// Prefix that turns a session id into a window label unique to that session.
pub const SESSION_WINDOW_LABEL_PREFIX: &str = "session-";
pub const SESSION_WINDOW_TITLE: &str = "Zorvo";
pub const SESSION_WINDOW_WIDTH: f64 = 900.0;
pub const SESSION_WINDOW_HEIGHT: f64 = 700.0;

/// Whether `session_id` is safe to embed in a window label and a URL query.
///
/// Only `[A-Za-z0-9_-]` is allowed: anything else could address a different
/// window, or smuggle extra query parameters into the popout URL that the
/// frontend reads to decide which session to attach to.
pub fn is_valid_session_id(session_id: &str) -> bool {
    (1..=MAX_SESSION_ID_LEN).contains(&session_id.chars().count())
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The window label for a session, or why the id was rejected.
pub fn session_window_label(session_id: &str) -> Result<String, String> {
    if !is_valid_session_id(session_id) {
        return Err(invalid_session_id_error(session_id));
    }
    Ok(format!("{SESSION_WINDOW_LABEL_PREFIX}{session_id}"))
}

/// The frontend URL for a session popout, or why the id was rejected.
pub fn session_window_url(session_id: &str) -> Result<String, String> {
    if !is_valid_session_id(session_id) {
        return Err(invalid_session_id_error(session_id));
    }
    Ok(format!("index.html?session={session_id}&popout=1"))
}

fn invalid_session_id_error(session_id: &str) -> String {
    format!(
        "Invalid session id {session_id:?}: expected 1 to {MAX_SESSION_ID_LEN} characters of [A-Za-z0-9_-]"
    )
}

/// Resolves a user-supplied path to an existing directory, or explains why not.
///
/// A relative path is rejected because `open` would resolve it against the
/// app's own working directory rather than the folder the user meant.
pub fn validated_reveal_path(path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return Err(format!("Path {path:?} is not absolute"));
    }
    if !candidate.is_dir() {
        return Err(format!("Path {path:?} is not an existing directory"));
    }
    Ok(candidate.to_path_buf())
}

/// Opens the session in its own window, focusing the existing one if it is open.
///
/// Sync on purpose: Tauri 2 runs non-async commands on the main thread, which
/// is where window creation has to happen.
#[tauri::command]
pub fn open_session_window(app: AppHandle, session_id: String) -> Result<(), String> {
    let label = session_window_label(&session_id)?;
    let url = session_window_url(&session_id)?;

    if let Some(existing) = app.get_webview_window(&label) {
        return existing.set_focus().map_err(|e| e.to_string());
    }

    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(SESSION_WINDOW_TITLE)
        .inner_size(SESSION_WINDOW_WIDTH, SESSION_WINDOW_HEIGHT);

    // Match the main window's chrome so the popout gets native traffic lights
    // floating over the same TopBar inset instead of a duplicate title bar.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true);

    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

/// Reveals a workspace folder in the platform file manager.
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    reveal_directory(&validated_reveal_path(&path)?)
}

#[cfg(target_os = "macos")]
fn reveal_directory(dir: &Path) -> Result<(), String> {
    let status = Command::new("open")
        .arg(dir)
        .status()
        .map_err(|e| format!("Failed to run `open {}`: {}", dir.display(), e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("`open {}` exited with {status}", dir.display()))
    }
}

#[cfg(not(target_os = "macos"))]
fn reveal_directory(_dir: &Path) -> Result<(), String> {
    Err("not supported".to_string())
}

/// Schemes a link in an agent's reply may open: web pages and mail, never
/// `file:`, `javascript:` or app-specific schemes that could run something.
const EXTERNAL_URL_SCHEMES: [&str; 3] = ["https://", "http://", "mailto:"];

/// Accepts `url` when it uses one of [`EXTERNAL_URL_SCHEMES`] and has no
/// whitespace or control characters (so it stays one argument to `open`).
pub fn validated_external_url(url: &str) -> Result<&str, String> {
    let lower = url.to_ascii_lowercase();
    let has_allowed_scheme = EXTERNAL_URL_SCHEMES
        .iter()
        .any(|scheme| lower.starts_with(scheme));
    let is_clean = !url.is_empty() && !url.chars().any(|c| c.is_whitespace() || c.is_control());
    if has_allowed_scheme && is_clean {
        Ok(url)
    } else {
        Err(format!(
            "Not opening {url:?}: only http, https and mailto links are opened"
        ))
    }
}

/// Opens a link from an agent's reply in the user's default browser or mail app.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    open_url(validated_external_url(&url)?)
}

#[cfg(target_os = "macos")]
fn open_url(url: &str) -> Result<(), String> {
    let status = Command::new("open")
        .arg(url)
        .status()
        .map_err(|e| format!("Failed to open {url}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("`open {url}` exited with {status}"))
    }
}

#[cfg(not(target_os = "macos"))]
fn open_url(_url: &str) -> Result<(), String> {
    Err("not supported".to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn opens_only_web_and_mail_links() {
        assert!(super::validated_external_url("https://example.com/docs?a=1").is_ok());
        assert!(super::validated_external_url("HTTP://example.com").is_ok());
        assert!(super::validated_external_url("mailto:me@example.com").is_ok());
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "vscode://x",
            "/Applications/Calculator.app",
            "https://a b",
            "",
        ] {
            assert!(
                super::validated_external_url(bad).is_err(),
                "{bad:?} must be refused"
            );
        }
    }

    use super::*;

    #[test]
    fn accepts_ids_made_of_letters_digits_underscore_and_dash() {
        for id in ["s-1", "abc", "ABC123", "a_b-c", "1", "sess_2026-10-16"] {
            assert!(is_valid_session_id(id), "expected {id:?} to be valid");
        }
    }

    #[test]
    fn rejects_an_empty_id() {
        assert!(!is_valid_session_id(""));
    }

    #[test]
    fn rejects_ids_longer_than_the_label_limit() {
        let too_long = "a".repeat(MAX_SESSION_ID_LEN + 1);
        let at_limit = "a".repeat(MAX_SESSION_ID_LEN);

        assert!(!is_valid_session_id(&too_long));
        assert!(is_valid_session_id(&at_limit));
    }

    #[test]
    fn rejects_ids_that_could_escape_the_window_label_or_url() {
        // A label or query string containing these would address a different
        // window or smuggle extra query parameters into the popout URL.
        for id in [
            "s 1",
            "s.1",
            "s/1",
            "s\\1",
            "s&popout=0",
            "s=1",
            "s?x",
            "s#1",
            "s:1",
            "ünicode",
            "s\x001",
        ] {
            assert!(!is_valid_session_id(id), "expected {id:?} to be rejected");
        }
    }

    #[test]
    fn builds_the_window_label_from_a_valid_id() {
        assert_eq!(
            session_window_label("s-1").expect("valid id"),
            "session-s-1".to_string()
        );
    }

    #[test]
    fn refuses_to_build_a_window_label_from_an_invalid_id() {
        let err = session_window_label("../etc").expect_err("invalid id must fail");
        assert!(err.contains("session id"), "unexpected error: {err}");
    }

    #[test]
    fn builds_the_popout_url_with_the_session_and_popout_flags() {
        assert_eq!(
            session_window_url("s-1").expect("valid id"),
            "index.html?session=s-1&popout=1".to_string()
        );
    }

    #[test]
    fn refuses_to_build_a_popout_url_from_an_invalid_id() {
        assert!(session_window_url("a b").is_err());
    }

    #[test]
    fn accepts_an_absolute_path_to_an_existing_directory() {
        let dir = unique_temp_dir("existing");
        std::fs::create_dir_all(&dir).expect("create temp dir");

        let resolved = validated_reveal_path(dir.to_str().expect("utf-8 path"))
            .expect("an existing absolute directory must be accepted");

        assert_eq!(resolved, dir);
        std::fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn rejects_a_relative_path() {
        let err =
            validated_reveal_path("developer/zorvo").expect_err("a relative path must be rejected");
        assert!(err.contains("absolute"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_a_path_that_does_not_exist() {
        let missing = unique_temp_dir("missing").join("no-such-folder");
        assert!(!missing.exists(), "test precondition: path must not exist");

        let err = validated_reveal_path(missing.to_str().expect("utf-8 path"))
            .expect_err("a missing path must be rejected");
        assert!(
            err.contains("not an existing directory"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn rejects_a_path_that_points_at_a_file() {
        let dir = unique_temp_dir("file");
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let file = dir.join("notes.txt");
        std::fs::write(&file, "not a folder").expect("write file");

        assert!(
            validated_reveal_path(file.to_str().expect("utf-8 path")).is_err(),
            "a plain file is not a folder to reveal"
        );

        std::fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn rejects_an_empty_path() {
        assert!(validated_reveal_path("").is_err());
    }

    /// Builds a temp path unique to this process and call, so parallel tests
    /// cannot collide with each other or with a leftover directory.
    fn unique_temp_dir(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock is before the unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "zorvo-windows-{}-{}-{}",
            tag,
            std::process::id(),
            nanos
        ))
    }
}
