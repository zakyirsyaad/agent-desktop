//! Downloads the ACP registry document.
//!
//! This is the app's only outbound request from the backend, so it stays
//! narrow: one URL, a global timeout, a size cap and no redirects.

use std::time::Duration;

pub const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_REGISTRY_BYTES: u64 = 5 * 1024 * 1024;

/// Fetches `url` and returns the body as text.
///
/// Fails on a non-2xx status, a redirect, a timeout, or a body larger than
/// `max_bytes`.
pub fn fetch_registry(url: &str, timeout: Duration, max_bytes: u64) -> Result<String, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .max_redirects(0)
        .http_status_as_error(true)
        .build()
        .into();

    let mut response = agent
        .get(url)
        .call()
        .map_err(|e| format!("registry request failed: {e}"))?;

    // With redirects disabled ureq hands a 3xx back as a normal response.
    let status = response.status();
    if !status.is_success() {
        return Err(format!("registry request returned HTTP {status}"));
    }

    // Read one byte past the cap so an oversized body is an error, not a truncation.
    let body = response
        .body_mut()
        .with_config()
        .limit(max_bytes + 1)
        .read_to_string()
        .map_err(|e| format!("registry body could not be read: {e}"))?;

    if body.len() as u64 > max_bytes {
        return Err(format!("registry is larger than {max_bytes} bytes"));
    }
    Ok(body)
}
