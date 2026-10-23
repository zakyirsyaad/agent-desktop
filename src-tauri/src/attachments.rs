//! A preview of an attached image, served to the webview by Tauri's asset
//! protocol.
//!
//! The webview never reads files itself, and the asset protocol's scope starts
//! empty: a file is added to it only after [`check_previewable`] accepts it.
//! An attachment reaches the composer from Finder drag and drop, the file
//! picker, or a workspace file, so its path may lie outside a known workspace:
//! `files::ensure_known_workspace` is for commands that browse a folder, and
//! does not apply to a single file the user attached. What this command lets
//! the webview load is bounded instead by the image extension, the file's own
//! magic bytes, and [`MAX_PREVIEW_BYTES`].
//!
//! Serving the file, rather than returning it as a data URL, keeps
//! multi-megabyte base64 strings off the IPC bridge and out of the webview's
//! memory: a thumbnail costs one small string, its URL.

use std::io::Read;
use std::path::Path;

use tauri::{AppHandle, Manager};

/// Images above this size are not previewed: the attachment keeps its chip.
pub const MAX_PREVIEW_BYTES: u64 = 10 * 1024 * 1024;

/// Enough bytes to tell every supported image type apart.
const HEADER_BYTES: u64 = 16;

/// The image type the file's name promises, or None when it is not an image.
fn declared_mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// The image type the bytes really are, from their magic number.
fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

fn too_large(path: &Path) -> String {
    format!(
        "Cannot preview {}: larger than {} MB",
        path.display(),
        MAX_PREVIEW_BYTES / (1024 * 1024)
    )
}

/// Checks that `path` is an image the webview may show, and returns its type.
/// Reads only the file's first bytes, however large it is.
pub fn check_previewable(path: &Path) -> Result<&'static str, String> {
    if !path.is_absolute() {
        return Err(format!(
            "Cannot preview {}: not an absolute path",
            path.display()
        ));
    }
    let declared = declared_mime(path)
        .ok_or_else(|| format!("Cannot preview {}: not an image", path.display()))?;
    let metadata =
        std::fs::metadata(path).map_err(|e| format!("Cannot preview {}: {}", path.display(), e))?;
    if !metadata.is_file() {
        return Err(format!("Cannot preview {}: not a file", path.display()));
    }
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err(too_large(path));
    }
    let mut header = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(HEADER_BYTES).read_to_end(&mut header))
        .map_err(|e| format!("Cannot preview {}: {}", path.display(), e))?;
    let actual = sniff_mime(&header).ok_or_else(|| {
        format!(
            "Cannot preview {}: its contents are not an image",
            path.display()
        )
    })?;
    if actual != declared {
        return Err(format!(
            "Cannot preview {}: its contents do not match its name",
            path.display()
        ));
    }
    Ok(actual)
}

/// Lets the webview load an attached image through the asset protocol, once
/// [`check_previewable`] accepts it. The UI then builds its URL with
/// `convertFileSrc`.
#[tauri::command(async)]
pub fn attachment_preview(app: AppHandle, path: String) -> Result<(), String> {
    let path = Path::new(&path);
    check_previewable(path)?;
    app.asset_protocol_scope()
        .allow_file(path)
        .map_err(|e| format!("Cannot preview {}: {}", path.display(), e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use std::fs;
    use std::path::PathBuf;

    /// A 1×1 transparent PNG, enough for the header and the payload checks.
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    fn fixture_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("zorvo-attach-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create fixture dir");
        dir
    }

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, bytes).expect("write fixture");
        path
    }

    #[test]
    fn accepts_a_real_png() {
        let dir = fixture_dir("valid-png");
        let png = base64::engine::general_purpose::STANDARD
            .decode(PNG)
            .expect("decode png");
        let path = write(&dir, "shot.png", &png);

        assert_eq!(check_previewable(&path), Ok("image/png"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn reads_only_the_header_of_a_large_image() {
        // A big screenshot is checked by its first bytes, never read whole.
        let dir = fixture_dir("large-png");
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.resize(MAX_PREVIEW_BYTES as usize - 1, 0);
        let path = write(&dir, "big.png", &bytes);

        assert_eq!(check_previewable(&path), Ok("image/png"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn refuses_a_file_that_is_not_an_image() {
        let dir = fixture_dir("text");
        let path = write(&dir, "notes.txt", b"just notes");

        let error = check_previewable(&path).expect_err("a text file is not an image");

        assert!(error.contains("not an image"), "{error}");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn refuses_a_non_image_renamed_as_a_png() {
        let dir = fixture_dir("renamed");
        let path = write(&dir, "sneaky.png", b"just notes");

        let error = check_previewable(&path).expect_err("the bytes do not match the name");

        assert!(error.contains("contents are not an image"), "{error}");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn refuses_an_image_larger_than_the_cap() {
        let dir = fixture_dir("oversized");
        let path = write(&dir, "huge.png", &vec![0u8; MAX_PREVIEW_BYTES as usize + 1]);

        let error = check_previewable(&path).expect_err("too large to preview");

        assert!(error.contains("larger than 10 MB"), "{error}");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn refuses_a_missing_file() {
        let dir = fixture_dir("missing");
        let path = dir.join("gone.png");

        let error = check_previewable(&path).expect_err("nothing to read");

        assert!(error.contains("Cannot preview"), "{error}");
        fs::remove_dir_all(dir).ok();
    }
}
