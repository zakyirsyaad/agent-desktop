//! A preview of an attached image, as a data URL the webview can show.
//!
//! The webview never reads files itself. An attachment reaches the composer
//! from Finder drag and drop, the file picker, or a workspace file, so its
//! path may lie outside a known workspace: `files::ensure_known_workspace`
//! is for commands that browse a folder, and does not apply to a single file
//! the user attached. What this command will read is bounded instead by the
//! image extension, the file's own magic bytes, and [`MAX_PREVIEW_BYTES`].

use std::io::Read;
use std::path::Path;

use base64::Engine as _;

/// Images above this size are not previewed: the attachment keeps its chip.
pub const MAX_PREVIEW_BYTES: u64 = 10 * 1024 * 1024;

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

/// Reads an attached image and returns it as a `data:` URL, or an error the
/// composer shows on the attachment's chip.
///
/// The bytes are returned as they are: decoding and downscaling would mean an
/// image decoder in the backend, and the cap keeps the payload bounded.
pub fn preview_data_url(path: &Path) -> Result<String, String> {
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
    // Bounded read: a file that grew after the size check still stops at the cap.
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .and_then(|file| file.take(MAX_PREVIEW_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|e| format!("Cannot preview {}: {}", path.display(), e))?;
    if bytes.len() as u64 > MAX_PREVIEW_BYTES {
        return Err(too_large(path));
    }
    let actual = sniff_mime(&bytes).ok_or_else(|| {
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
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{actual};base64,{data}"))
}

#[tauri::command(async)]
pub fn attachment_preview(path: String) -> Result<String, String> {
    preview_data_url(Path::new(&path))
}

#[cfg(test)]
mod tests {
    use super::*;
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
    fn returns_a_png_as_a_data_url() {
        let dir = fixture_dir("valid-png");
        let png = base64::engine::general_purpose::STANDARD
            .decode(PNG)
            .expect("decode png");
        let path = write(&dir, "shot.png", &png);

        let url = preview_data_url(&path).expect("preview a png");

        assert!(url.starts_with("data:image/png;base64,"), "{url}");
        assert!(url.ends_with(PNG));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn refuses_a_file_that_is_not_an_image() {
        let dir = fixture_dir("text");
        let path = write(&dir, "notes.txt", b"just notes");

        let error = preview_data_url(&path).expect_err("a text file is not an image");

        assert!(error.contains("not an image"), "{error}");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn refuses_a_non_image_renamed_as_a_png() {
        let dir = fixture_dir("renamed");
        let path = write(&dir, "sneaky.png", b"just notes");

        let error = preview_data_url(&path).expect_err("the bytes do not match the name");

        assert!(error.contains("contents are not an image"), "{error}");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn refuses_an_image_larger_than_the_cap() {
        let dir = fixture_dir("oversized");
        let path = write(&dir, "huge.png", &vec![0u8; MAX_PREVIEW_BYTES as usize + 1]);

        let error = preview_data_url(&path).expect_err("too large to preview");

        assert!(error.contains("larger than 10 MB"), "{error}");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn refuses_a_missing_file() {
        let dir = fixture_dir("missing");
        let path = dir.join("gone.png");

        let error = preview_data_url(&path).expect_err("nothing to read");

        assert!(error.contains("Cannot preview"), "{error}");
        fs::remove_dir_all(dir).ok();
    }
}
