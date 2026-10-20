use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use zorvo_lib::installer::download::{download, DownloadError, DownloadLimits};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh, empty dir unique to one test, removed when dropped.
struct TempDir(PathBuf);

impl Deref for TempDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn temp_dir() -> TempDir {
    let dir = std::env::temp_dir().join(format!(
        "zorvo-download-test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
}

/// One step of a canned reply: bytes to write, or a pause.
enum Part {
    Bytes(Vec<u8>),
    Sleep(Duration),
}

fn bytes(text: impl AsRef<[u8]>) -> Part {
    Part::Bytes(text.as_ref().to_vec())
}

fn url_of(listener: &TcpListener, path: &str) -> String {
    format!("http://{}{path}", listener.local_addr().unwrap())
}

/// Serves one connection on `listener` with `parts`, in order.
/// The receiver yields once a request has arrived.
fn serve(listener: TcpListener, parts: Vec<Part>) -> Receiver<()> {
    let (tx, rx) = channel();
    thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let mut buf = [0u8; 4096];
        let _ = stream.read(&mut buf);
        let _ = tx.send(());
        for part in parts {
            match part {
                Part::Bytes(data) => {
                    if stream.write_all(&data).is_err() {
                        return;
                    }
                    let _ = stream.flush();
                }
                Part::Sleep(pause) => thread::sleep(pause),
            }
        }
    });
    rx
}

fn bind() -> TcpListener {
    TcpListener::bind("127.0.0.1:0").unwrap()
}

fn ok(body: &[u8]) -> Part {
    let mut reply = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes();
    reply.extend_from_slice(body);
    Part::Bytes(reply)
}

fn redirect(location: &str) -> Part {
    bytes(format!(
        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    ))
}

fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn limits(max_bytes: u64) -> DownloadLimits {
    DownloadLimits {
        max_bytes,
        connect_timeout: Duration::from_secs(5),
        stall_timeout: Duration::from_secs(1),
        max_redirects: 5,
        require_https: false,
    }
}

fn run(url: &str, sha: &str, dest: &Path, limits: &DownloadLimits) -> Result<(), DownloadError> {
    let cancel = AtomicBool::new(false);
    download(url, sha, dest, limits, &cancel, &mut |_, _| {})
}

/// Asserts nobody connected to `listener` within a short grace period.
fn assert_never_contacted(listener: &TcpListener) {
    listener.set_nonblocking(true).unwrap();
    thread::sleep(Duration::from_millis(200));
    let hit: Option<TcpStream> = listener.accept().ok().map(|(s, _)| s);
    assert!(hit.is_none(), "the server must not be contacted");
}

#[test]
fn writes_the_body_when_the_hash_matches() {
    let body = b"hello, zorvo".to_vec();
    let listener = bind();
    let url = url_of(&listener, "/file.tar.gz");
    serve(listener, vec![ok(&body)]);
    let dir = temp_dir();
    let dest = dir.join("file.tar.gz");
    let cancel = AtomicBool::new(false);
    let mut calls = Vec::new();

    let result = download(
        &url,
        &sha256_hex(&body),
        &dest,
        &limits(1024),
        &cancel,
        &mut |done, total| calls.push((done, total)),
    );

    assert_eq!(result, Ok(()));
    assert_eq!(fs::read(&dest).unwrap(), body);
    let len = body.len() as u64;
    assert_eq!(calls.last(), Some(&(len, Some(len))));
}

#[test]
fn fails_on_a_hash_mismatch_and_leaves_no_file() {
    let listener = bind();
    let url = url_of(&listener, "/file");
    serve(listener, vec![ok(b"tampered")]);
    let dir = temp_dir();
    let dest = dir.join("file");

    let result = run(&url, &sha256_hex(b"original"), &dest, &limits(1024));

    assert_eq!(result, Err(DownloadError::ChecksumMismatch));
    assert!(!dest.exists());
}

#[test]
fn fails_at_once_when_content_length_exceeds_the_cap() {
    let listener = bind();
    let url = url_of(&listener, "/big");
    let head = "HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\n";
    serve(
        listener,
        vec![
            bytes(head),
            bytes([0u8; 10]),
            Part::Sleep(Duration::from_secs(3)),
        ],
    );
    let dir = temp_dir();
    let dest = dir.join("big");
    let started = Instant::now();

    let result = run(&url, &sha256_hex(b""), &dest, &limits(100));

    assert_eq!(result, Err(DownloadError::TooLarge { max: 100 }));
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(!dest.exists());
}

#[test]
fn stops_a_chunked_body_at_the_cap() {
    let listener = bind();
    let url = url_of(&listener, "/chunked");
    let mut parts = vec![bytes(
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
    )];
    for _ in 0..5 {
        let mut chunk = b"40\r\n".to_vec();
        chunk.extend_from_slice(&[7u8; 64]);
        chunk.extend_from_slice(b"\r\n");
        parts.push(Part::Bytes(chunk));
        parts.push(Part::Sleep(Duration::from_millis(50)));
    }
    parts.push(bytes("0\r\n\r\n"));
    serve(listener, parts);
    let dir = temp_dir();
    let dest = dir.join("chunked");
    let cancel = AtomicBool::new(false);
    let mut totals = Vec::new();

    let result = download(
        &url,
        &sha256_hex(&[7u8; 320]),
        &dest,
        &limits(100),
        &cancel,
        &mut |_, total| totals.push(total),
    );

    assert_eq!(result, Err(DownloadError::TooLarge { max: 100 }));
    assert!(
        !totals.is_empty(),
        "progress is reported for a chunked body"
    );
    assert!(totals.iter().all(Option::is_none));
    assert!(!dest.exists());
}

#[test]
fn follows_a_redirect_to_another_port() {
    let body = b"moved here".to_vec();
    let target = bind();
    let target_url = url_of(&target, "/real");
    serve(target, vec![ok(&body)]);
    let start = bind();
    let url = url_of(&start, "/first");
    serve(start, vec![redirect(&target_url)]);
    let dir = temp_dir();
    let dest = dir.join("file");

    let result = run(&url, &sha256_hex(&body), &dest, &limits(1024));

    assert_eq!(result, Ok(()));
    assert_eq!(fs::read(&dest).unwrap(), body);
}

#[test]
fn follows_exactly_max_redirects() {
    // Five redirects in a row, then the server that answers: the limit itself is allowed.
    let body = b"five hops away".to_vec();
    let listeners: Vec<TcpListener> = (0..6).map(|_| bind()).collect();
    let urls: Vec<String> = listeners.iter().map(|l| url_of(l, "/hop")).collect();
    let mut listeners = listeners.into_iter();
    for next in &urls[1..] {
        serve(listeners.next().unwrap(), vec![redirect(next)]);
    }
    serve(listeners.next().unwrap(), vec![ok(&body)]);
    let dir = temp_dir();
    let dest = dir.join("file");

    let result = run(&urls[0], &sha256_hex(&body), &dest, &limits(1024));

    assert_eq!(result, Ok(()));
    assert_eq!(fs::read(&dest).unwrap(), body);
}

#[test]
fn fails_after_more_than_max_redirects() {
    // Six redirects in a row, then a server that would answer: one hop too many.
    let listeners: Vec<TcpListener> = (0..7).map(|_| bind()).collect();
    let urls: Vec<String> = listeners.iter().map(|l| url_of(l, "/hop")).collect();
    let mut listeners = listeners.into_iter();
    for next in &urls[1..] {
        serve(listeners.next().unwrap(), vec![redirect(next)]);
    }
    let last = listeners.next().unwrap();
    let dir = temp_dir();
    let dest = dir.join("file");

    let result = run(&urls[0], &sha256_hex(b""), &dest, &limits(1024));

    assert_eq!(result, Err(DownloadError::TooManyRedirects));
    assert_never_contacted(&last);
    assert!(!dest.exists());
}

#[test]
fn rejects_an_http_url_when_https_is_required() {
    let listener = bind();
    let url = url_of(&listener, "/file?token=secret");
    let dir = temp_dir();
    let dest = dir.join("file");
    let strict = DownloadLimits {
        require_https: true,
        ..limits(1024)
    };

    let result = run(&url, &sha256_hex(b""), &dest, &strict);

    assert_eq!(
        result,
        Err(DownloadError::InsecureUrl {
            origin: "http://127.0.0.1".to_string()
        })
    );
    assert_never_contacted(&listener);
}

#[test]
fn reports_a_stall() {
    let listener = bind();
    let url = url_of(&listener, "/slow");
    let head = "HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n";
    serve(
        listener,
        vec![
            bytes(head),
            bytes([1u8; 10]),
            Part::Sleep(Duration::from_secs(3)),
        ],
    );
    let dir = temp_dir();
    let dest = dir.join("slow");
    let started = Instant::now();

    let result = run(&url, &sha256_hex(&[1u8; 100]), &dest, &limits(1024));

    assert_eq!(result, Err(DownloadError::Stalled));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(!dest.exists());
}

#[test]
fn stops_when_cancelled() {
    let listener = bind();
    let url = url_of(&listener, "/file");
    let head = "HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n";
    serve(
        listener,
        vec![
            bytes(head),
            bytes([2u8; 10]),
            Part::Sleep(Duration::from_secs(3)),
        ],
    );
    let dir = temp_dir();
    let dest = dir.join("file");
    let cancel = AtomicBool::new(false);
    let started = Instant::now();

    let result = download(
        &url,
        &sha256_hex(&[2u8; 100]),
        &dest,
        &limits(1024),
        &cancel,
        &mut |_, _| cancel.store(true, Ordering::SeqCst),
    );

    assert_eq!(result, Err(DownloadError::Cancelled));
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(!dest.exists());
}

#[test]
fn user_message_names_the_agent_and_host() {
    let network = DownloadError::Network {
        host: "github.com".to_string(),
        reason: "HTTP 404".to_string(),
    };
    assert_eq!(
        network.user_message("Gemini CLI"),
        "Could not download Gemini CLI from github.com (HTTP 404)"
    );
    assert_eq!(
        DownloadError::ChecksumMismatch.user_message("Gemini CLI"),
        "The download of Gemini CLI did not match its checksum"
    );
}

#[test]
fn production_limits_match_the_spec() {
    let limits = DownloadLimits::production();
    assert_eq!(limits.max_bytes, 1 << 30);
    assert_eq!(limits.connect_timeout, Duration::from_secs(30));
    assert_eq!(limits.stall_timeout, Duration::from_secs(60));
    assert_eq!(limits.max_redirects, 5);
    assert!(limits.require_https);
    assert_eq!(
        DownloadError::TooLarge {
            max: limits.max_bytes
        }
        .user_message("Goose"),
        "Goose is larger than Zorvo allows (1 GiB)"
    );
}

#[test]
fn reports_a_server_error_with_its_host_and_status() {
    let listener = bind();
    let url = url_of(&listener, "/missing");
    serve(
        listener,
        vec![bytes(
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )],
    );
    let dir = temp_dir();
    let dest = dir.join("missing");

    let result = run(&url, &sha256_hex(b""), &dest, &limits(1024));

    assert_eq!(
        result,
        Err(DownloadError::Network {
            host: "127.0.0.1".to_string(),
            reason: "HTTP 404".to_string(),
        })
    );
    assert!(!dest.exists());
}

#[test]
fn rejects_a_malformed_checksum_before_any_request() {
    let listener = bind();
    let url = url_of(&listener, "/file");
    let dir = temp_dir();
    let dest = dir.join("file");

    let result = run(&url, "not-a-sha", &dest, &limits(1024));

    assert_eq!(result, Err(DownloadError::ChecksumMismatch));
    assert_never_contacted(&listener);
}
