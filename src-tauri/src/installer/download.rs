//! Streams one URL to a file, checked against a SHA-256 known in advance.
//!
//! This is the installer's only way to fetch Node.js, uv and agent archives,
//! so it is strict: every hop must be HTTPS, redirects are followed by hand
//! (any host, at most `max_redirects`), the body is capped, a download that
//! sends nothing for `stall_timeout` fails, and the file is deleted on every
//! failure.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use ureq::http::Response;
use ureq::Body;
use url::Url;

const CHUNK_BYTES: usize = 64 * 1024;
/// How far the reader thread may run ahead of the writer, so a slow disk bounds memory.
const QUEUED_CHUNKS: usize = 4;
/// How often the writer wakes to check the cancel flag and the stall deadline.
const TICK: Duration = Duration::from_millis(250);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const MIB: u64 = 1 << 20;
const GIB: u64 = 1 << 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadLimits {
    pub max_bytes: u64,
    /// Applies to connecting (with TLS) and, separately, to receiving the response headers.
    pub connect_timeout: Duration,
    /// Fails the download after this long without a byte of body.
    pub stall_timeout: Duration,
    pub max_redirects: u32,
    pub require_https: bool,
}

impl DownloadLimits {
    pub fn production() -> Self {
        Self {
            max_bytes: GIB,
            connect_timeout: Duration::from_secs(30),
            stall_timeout: Duration::from_secs(60),
            max_redirects: 5,
            require_https: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadError {
    Cancelled,
    Network { host: String, reason: String },
    Stalled,
    TooLarge { max: u64 },
    ChecksumMismatch,
    InsecureUrl { url: String },
    TooManyRedirects,
    DiskFull,
    Io(String),
}

impl DownloadError {
    /// The message shown to the user; `name` is the agent or runtime being installed.
    pub fn user_message(&self, name: &str) -> String {
        match self {
            Self::Cancelled => format!("The download of {name} was cancelled"),
            Self::Network { host, reason } => {
                format!("Could not download {name} from {host} ({reason})")
            }
            Self::Stalled => format!("The download of {name} stalled"),
            Self::TooLarge { max } => {
                format!("{name} is larger than Zorvo allows ({})", format_size(*max))
            }
            Self::ChecksumMismatch => format!("The download of {name} did not match its checksum"),
            Self::InsecureUrl { url } => {
                format!("Zorvo downloads {name} only over HTTPS, not from {url}")
            }
            Self::TooManyRedirects => format!("Could not download {name} (too many redirects)"),
            Self::DiskFull => format!("Not enough disk space to install {name}"),
            Self::Io(reason) => format!("Could not save the download of {name} ({reason})"),
        }
    }
}

/// Downloads `url` to `dest` and checks it against `expected_sha256` (hex).
///
/// `on_progress(bytes_written, total)` is called at most every 250 ms and once
/// at the end; `total` is `None` when the server sends no `Content-Length`.
/// `cancel` is checked between hops and on every chunk or 250 ms tick. On any
/// error `dest` is deleted.
pub fn download(
    url: &str,
    expected_sha256: &str,
    dest: &Path,
    limits: &DownloadLimits,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(u64, Option<u64>),
) -> Result<(), DownloadError> {
    let result = fetch_to(url, expected_sha256, dest, limits, cancel, on_progress);
    if result.is_err() {
        let _ = fs::remove_file(dest);
    }
    result
}

fn fetch_to(
    url: &str,
    expected_sha256: &str,
    dest: &Path,
    limits: &DownloadLimits,
    cancel: &AtomicBool,
    on_progress: &mut dyn FnMut(u64, Option<u64>),
) -> Result<(), DownloadError> {
    // A malformed pin can never match, so fail before spending the download on it.
    if !is_sha256(expected_sha256) {
        return Err(DownloadError::ChecksumMismatch);
    }
    let start = Url::parse(url).map_err(|_| DownloadError::InsecureUrl {
        url: url.to_string(),
    })?;
    let (final_url, response) = open(check_scheme(start, limits.require_https)?, limits, cancel)?;
    let total = response.body().content_length();
    if total.is_some_and(|n| n > limits.max_bytes) {
        return Err(DownloadError::TooLarge {
            max: limits.max_bytes,
        });
    }
    let chunks = spawn_reader(response.into_body());
    let mut progress = Progress::new(total, on_progress);
    let host = host_of(&final_url);
    let digest = stream_to_file(&chunks, &host, dest, limits, cancel, &mut progress)?;
    if digest.eq_ignore_ascii_case(expected_sha256) {
        Ok(())
    } else {
        Err(DownloadError::ChecksumMismatch)
    }
}

fn build_agent(limits: &DownloadLimits) -> ureq::Agent {
    ureq::Agent::config_builder()
        .https_only(limits.require_https)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_connect(Some(limits.connect_timeout))
        .timeout_recv_response(Some(limits.connect_timeout))
        .build()
        .into()
}

/// Requests `start`, following redirects by hand so each hop's scheme is checked.
/// Returns the URL that answered with a 2xx, and its response.
fn open(
    start: Url,
    limits: &DownloadLimits,
    cancel: &AtomicBool,
) -> Result<(Url, Response<Body>), DownloadError> {
    let agent = build_agent(limits);
    let mut current = start;
    let mut redirects = 0;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(DownloadError::Cancelled);
        }
        let response = agent
            .get(current.as_str())
            .call()
            .map_err(|e| network(&current, e.to_string()))?;
        let status = response.status().as_u16();
        if response.status().is_success() {
            return Ok((current, response));
        }
        if !matches!(status, 301 | 302 | 303 | 307 | 308) {
            return Err(network(&current, format!("HTTP {status}")));
        }
        if redirects == limits.max_redirects {
            return Err(DownloadError::TooManyRedirects);
        }
        redirects += 1;
        let location = response
            .headers()
            .get("location")
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| network(&current, "a redirect without a location".to_string()))?;
        current = next_location(&current, location, limits.require_https)?;
    }
}

/// Resolves a `Location` header (absolute or relative) against the URL that sent it.
fn next_location(current: &Url, location: &str, require_https: bool) -> Result<Url, DownloadError> {
    let next = current
        .join(location)
        .map_err(|_| network(current, "a redirect to an invalid address".to_string()))?;
    check_scheme(next, require_https)
}

fn check_scheme(url: Url, require_https: bool) -> Result<Url, DownloadError> {
    let allowed = match url.scheme() {
        "https" => true,
        "http" => !require_https,
        _ => false,
    };
    if allowed {
        Ok(url)
    } else {
        Err(DownloadError::InsecureUrl {
            url: url.to_string(),
        })
    }
}

type Chunk = io::Result<Option<Vec<u8>>>;

/// Reads the body on its own thread, so the caller can wake on a timer to
/// notice a stall or a cancel even while a read is blocked. `Ok(None)` marks
/// the end. The thread ends once the receiver is dropped and its read returns.
fn spawn_reader(body: Body) -> Receiver<Chunk> {
    let (tx, rx) = mpsc::sync_channel(QUEUED_CHUNKS);
    thread::spawn(move || {
        let mut reader = body.into_reader();
        let mut buf = vec![0u8; CHUNK_BYTES];
        loop {
            let chunk = match reader.read(&mut buf) {
                Ok(0) => Ok(None),
                Ok(n) => Ok(Some(buf[..n].to_vec())),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => Err(e),
            };
            let is_last = !matches!(chunk, Ok(Some(_)));
            if tx.send(chunk).is_err() || is_last {
                return;
            }
        }
    });
    rx
}

/// Writes chunks to `dest` until the body ends, returning the hex SHA-256 of what was written.
fn stream_to_file(
    chunks: &Receiver<Chunk>,
    host: &str,
    dest: &Path,
    limits: &DownloadLimits,
    cancel: &AtomicBool,
    progress: &mut Progress,
) -> Result<String, DownloadError> {
    let mut sink = Sink::create(dest, limits.max_bytes)?;
    let mut last_data = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(DownloadError::Cancelled);
        }
        match chunks.recv_timeout(TICK) {
            Ok(Ok(Some(chunk))) => {
                sink.write(&chunk)?;
                last_data = Instant::now();
                progress.tick(sink.written);
            }
            Ok(Ok(None)) => break,
            Ok(Err(e)) => return Err(network_host(host, e.to_string())),
            Err(RecvTimeoutError::Timeout) if last_data.elapsed() >= limits.stall_timeout => {
                return Err(DownloadError::Stalled);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Err(network_host(host, "the connection closed".to_string()));
            }
        }
    }
    progress.report(sink.written);
    sink.finish()
}

/// The file being written and the running hash of its bytes.
struct Sink {
    file: File,
    hasher: Sha256,
    written: u64,
    max_bytes: u64,
}

impl Sink {
    fn create(dest: &Path, max_bytes: u64) -> Result<Self, DownloadError> {
        Ok(Self {
            file: File::create(dest).map_err(io_error)?,
            hasher: Sha256::new(),
            written: 0,
            max_bytes,
        })
    }

    /// Refuses a chunk that would take the file past the cap, before writing any of it.
    fn write(&mut self, chunk: &[u8]) -> Result<(), DownloadError> {
        let written = self.written + chunk.len() as u64;
        if written > self.max_bytes {
            return Err(DownloadError::TooLarge {
                max: self.max_bytes,
            });
        }
        self.file.write_all(chunk).map_err(io_error)?;
        self.hasher.update(chunk);
        self.written = written;
        Ok(())
    }

    fn finish(self) -> Result<String, DownloadError> {
        self.file.sync_all().map_err(io_error)?;
        Ok(self
            .hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect())
    }
}

/// Throttles progress calls to one per `PROGRESS_INTERVAL`.
struct Progress<'a> {
    total: Option<u64>,
    last: Option<Instant>,
    callback: &'a mut dyn FnMut(u64, Option<u64>),
}

impl<'a> Progress<'a> {
    fn new(total: Option<u64>, callback: &'a mut dyn FnMut(u64, Option<u64>)) -> Self {
        Self {
            total,
            last: None,
            callback,
        }
    }

    fn tick(&mut self, done: u64) {
        if self.last.is_none_or(|at| at.elapsed() >= PROGRESS_INTERVAL) {
            self.report(done);
        }
    }

    fn report(&mut self, done: u64) {
        (self.callback)(done, self.total);
        self.last = Some(Instant::now());
    }
}

fn io_error(e: io::Error) -> DownloadError {
    if e.kind() == io::ErrorKind::StorageFull {
        DownloadError::DiskFull
    } else {
        DownloadError::Io(e.to_string())
    }
}

fn network(url: &Url, reason: String) -> DownloadError {
    network_host(&host_of(url), reason)
}

fn network_host(host: &str, reason: String) -> DownloadError {
    DownloadError::Network {
        host: host.to_string(),
        reason,
    }
}

fn host_of(url: &Url) -> String {
    url.host_str().unwrap_or_default().to_string()
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn format_size(bytes: u64) -> String {
    if bytes >= GIB && bytes.is_multiple_of(GIB) {
        format!("{} GiB", bytes / GIB)
    } else if bytes >= MIB && bytes.is_multiple_of(MIB) {
        format!("{} MiB", bytes / MIB)
    } else {
        format!("{bytes} bytes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn rejects_a_redirect_to_http_when_https_is_required() {
        assert_eq!(
            next_location(&url("https://a/x"), "http://b/y", true),
            Err(DownloadError::InsecureUrl {
                url: "http://b/y".to_string()
            })
        );
    }

    #[test]
    fn resolves_a_relative_redirect_against_the_current_url() {
        assert_eq!(
            next_location(&url("https://a/dir/sub/x"), "../y", true),
            Ok(url("https://a/dir/y"))
        );
    }

    #[test]
    fn follows_a_redirect_to_another_https_host() {
        assert_eq!(
            next_location(
                &url("https://github.com/x"),
                "https://objects.example/y",
                true
            ),
            Ok(url("https://objects.example/y"))
        );
    }

    #[test]
    fn rejects_a_redirect_to_a_non_http_scheme() {
        assert!(matches!(
            next_location(&url("http://a/x"), "file:///etc/passwd", false),
            Err(DownloadError::InsecureUrl { .. })
        ));
    }

    #[test]
    fn formats_the_cap_in_the_largest_whole_unit() {
        assert_eq!(format_size(GIB), "1 GiB");
        assert_eq!(format_size(512 * MIB), "512 MiB");
        assert_eq!(format_size(100), "100 bytes");
    }
}
