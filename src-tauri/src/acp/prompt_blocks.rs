//! Turns a user prompt and its attached files into ACP content blocks.

use std::path::Path;

use base64::Engine as _;
use serde_json::{json, Value};

/// Images above this size are linked instead of inlined, to keep prompts small.
pub const MAX_INLINE_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

fn image_mime_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// A `resource_link`, which every ACP agent must accept.
fn resource_link(path: &Path) -> Result<Value, String> {
    let uri = url::Url::from_file_path(path)
        .map_err(|_| format!("Cannot attach {}: not an absolute path", path.display()))?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(json!({ "type": "resource_link", "uri": uri.as_str(), "name": name }))
}

fn attachment_block(raw: &str, supports_images: bool) -> Result<Value, String> {
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(format!("Cannot attach {}: not an absolute path", raw));
    }
    let metadata = std::fs::metadata(path).map_err(|e| format!("Cannot attach {}: {}", raw, e))?;
    if !metadata.is_file() {
        return Err(format!("Cannot attach {}: not a file", raw));
    }
    match image_mime_type(path) {
        Some(mime_type) if supports_images && metadata.len() <= MAX_INLINE_IMAGE_BYTES => {
            let bytes = std::fs::read(path).map_err(|e| format!("Cannot attach {}: {}", raw, e))?;
            let data = base64::engine::general_purpose::STANDARD.encode(bytes);
            Ok(json!({ "type": "image", "mimeType": mime_type, "data": data }))
        }
        _ => resource_link(path),
    }
}

/// The prompt's text, then one block per attachment: an inline image when
/// the agent takes images and the file is small enough, a file link otherwise.
pub fn prompt_blocks(
    text: &str,
    attachments: &[String],
    supports_images: bool,
) -> Result<Vec<Value>, String> {
    let mut blocks = vec![json!({ "type": "text", "text": text })];
    for attachment in attachments {
        blocks.push(attachment_block(attachment, supports_images)?);
    }
    Ok(blocks)
}
