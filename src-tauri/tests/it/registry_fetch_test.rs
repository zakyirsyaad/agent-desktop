use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{channel, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use zorvo_lib::registry::fetch::fetch_registry;

const TIMEOUT: Duration = Duration::from_secs(5);

/// Serves one canned response (or none, when `response` is None) on a local port.
/// The receiver yields once a request has arrived.
fn serve_once(response: Option<String>) -> (String, Receiver<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/registry.json", listener.local_addr().unwrap());
    let (tx, rx) = channel();
    thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let mut buf = [0u8; 4096];
        let _ = stream.read(&mut buf);
        let _ = tx.send(());
        match response {
            Some(text) => {
                let _ = stream.write_all(text.as_bytes());
                let _ = stream.flush();
            }
            None => thread::sleep(Duration::from_secs(3)),
        }
    });
    (url, rx)
}

fn ok(body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[test]
fn returns_the_body_of_a_200() {
    let (url, _) = serve_once(Some(ok("{\"agents\":[]}")));
    assert_eq!(
        fetch_registry(&url, TIMEOUT, 1024).unwrap(),
        "{\"agents\":[]}"
    );
}

#[test]
fn fails_on_a_server_error() {
    let response =
        "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    let (url, _) = serve_once(Some(response.to_string()));
    assert!(fetch_registry(&url, TIMEOUT, 1024).is_err());
}

#[test]
fn fails_after_the_timeout() {
    let (url, _) = serve_once(None);
    let started = Instant::now();
    let result = fetch_registry(&url, Duration::from_millis(300), 1024);
    assert!(result.is_err());
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[test]
fn fails_on_a_body_over_the_cap() {
    let (url, _) = serve_once(Some(ok("12345678901")));
    assert!(fetch_registry(&url, TIMEOUT, 10).is_err());
}

#[test]
fn accepts_a_body_exactly_at_the_cap() {
    let (url, _) = serve_once(Some(ok("1234567890")));
    assert_eq!(fetch_registry(&url, TIMEOUT, 10).unwrap(), "1234567890");
}

#[test]
fn refuses_a_redirect() {
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    target.set_nonblocking(true).unwrap();
    let location = format!("http://{}/elsewhere", target.local_addr().unwrap());
    let response = format!(
        "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let (url, _) = serve_once(Some(response));
    assert!(fetch_registry(&url, TIMEOUT, 1024).is_err());
    thread::sleep(Duration::from_millis(200));
    let hit: Option<TcpStream> = target.accept().ok().map(|(s, _)| s);
    assert!(hit.is_none(), "the redirect target must not be contacted");
}
