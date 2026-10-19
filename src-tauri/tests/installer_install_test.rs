use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::ops::Deref;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use zorvo_lib::installer::archive::UnpackLimits;
use zorvo_lib::installer::download::DownloadLimits;
use zorvo_lib::installer::install::{InstallProgress, Installer, INSTALL_CANCELLED};
use zorvo_lib::installer::layout::{read_record, ToolsDir};
use zorvo_lib::installer::plan::PlannedStep;
use zorvo_lib::installer::prerequisites::prerequisites_for;
use zorvo_lib::installer::runtimes::{RuntimeKind, RuntimeManifest, RuntimeRelease, RuntimeTarget};

static COUNTER: AtomicU64 = AtomicU64::new(0);
const PLATFORM: &str = "darwin-aarch64";
const NODE_VERSION: &str = "24.0.0";
const NODE_BIN: &str = "node-v24/bin";
/// Long enough to outlast any test, so a stalled reply only ends by cancelling.
const STALL: Duration = Duration::from_secs(30);
const WAIT_LIMIT: Duration = Duration::from_secs(10);

/// A fresh, empty data dir unique to one test, removed when dropped.
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

fn data_dir() -> TempDir {
    let dir = std::env::temp_dir().join(format!(
        "zorvo-install-test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
}

/// How the server answers one path.
#[derive(Clone)]
enum Reply {
    Ok(Vec<u8>),
    /// Sends half the body, waits, then sends the rest.
    Slow(Vec<u8>, Duration),
    /// The first request gets half the body and then nothing; later ones get it all.
    StallFirst(Vec<u8>),
}

/// A local HTTP server that counts the requests for each path.
struct Server {
    base: String,
    hits: Arc<Mutex<HashMap<String, usize>>>,
}

impl Server {
    fn start(routes: Vec<(&str, Reply)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let routes: HashMap<String, Reply> = routes
            .into_iter()
            .map(|(path, reply)| (path.to_string(), reply))
            .collect();
        let hits = Arc::new(Mutex::new(HashMap::new()));
        let counted = Arc::clone(&hits);
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let routes = routes.clone();
                let hits = Arc::clone(&counted);
                thread::spawn(move || answer(stream, &routes, &hits));
            }
        });
        Self { base, hits }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn hits(&self, path: &str) -> usize {
        self.hits.lock().unwrap().get(path).copied().unwrap_or(0)
    }

    fn wait_for_hits(&self, path: &str, count: usize) {
        let deadline = Instant::now() + WAIT_LIMIT;
        while self.hits(path) < count {
            assert!(Instant::now() < deadline, "no request for {path}");
            thread::sleep(Duration::from_millis(20));
        }
    }
}

fn answer(
    mut stream: TcpStream,
    routes: &HashMap<String, Reply>,
    hits: &Mutex<HashMap<String, usize>>,
) {
    let mut request = Vec::new();
    let mut buf = [0u8; 1024];
    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => request.extend_from_slice(&buf[..n]),
        }
    }
    let text = String::from_utf8_lossy(&request);
    let path = text.split_whitespace().nth(1).unwrap_or("").to_string();
    let seen = {
        let mut hits = hits.lock().unwrap();
        let count = hits.entry(path.clone()).or_insert(0);
        *count += 1;
        *count
    };
    let Some(reply) = routes.get(&path) else {
        let _ = stream
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    };
    let (body, pause) = match reply {
        Reply::Ok(body) => (body, None),
        Reply::Slow(body, pause) => (body, Some(*pause)),
        Reply::StallFirst(body) if seen == 1 => (body, Some(STALL)),
        Reply::StallFirst(body) => (body, None),
    };
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let half = body.len() / 2;
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(&body[..half]);
    let _ = stream.flush();
    if let Some(pause) = pause {
        thread::sleep(pause);
    }
    let _ = stream.write_all(&body[half..]);
}

/// A gzipped tar of `(path, contents, mode)` files.
fn tar_gz(files: &[(&str, &str, u32)]) -> Vec<u8> {
    let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut builder = tar::Builder::new(gz);
    for (path, contents, mode) in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(contents.len() as u64);
        header.set_mode(*mode);
        header.set_entry_type(tar::EntryType::Regular);
        builder
            .append_data(&mut header, path, contents.as_bytes())
            .unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// An `npm` that installs a `pi` script under `--prefix` and records its PATH there.
const FAKE_NPM: &str = r#"#!/bin/sh
while [ $# -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then prefix="$2"; fi
  shift
done
/bin/mkdir -p "$prefix/bin"
printf '%s' "$PATH" > "$prefix/path.txt"
printf '#!/bin/sh\n' > "$prefix/bin/pi"
/bin/chmod +x "$prefix/bin/pi"
"#;

/// Zorvo's Node as an archive: `node` and an `npm` that installs `pi`.
fn node_archive() -> Vec<u8> {
    tar_gz(&[
        ("node-v24/bin/node", "#!/bin/sh\necho v24.0.0\n", 0o755),
        ("node-v24/bin/npm", FAKE_NPM, 0o755),
    ])
}

fn agent_archive() -> Vec<u8> {
    // No exec bit, as is common in zips: the installer sets it on `cmd`.
    tar_gz(&[
        ("dist/my-agent", "#!/bin/sh\n", 0o644),
        ("dist/README", "hello", 0o644),
    ])
}

fn target(server: &Server, path: &str, archive: &[u8], bin: &str) -> RuntimeTarget {
    RuntimeTarget {
        url: server.url(path),
        sha256: sha256_hex(archive),
        size: archive.len() as u64,
        bin: bin.to_string(),
    }
}

fn manifest(server: &Server, node: &[u8]) -> RuntimeManifest {
    let release = |version: &str, target: RuntimeTarget| RuntimeRelease {
        version: version.to_string(),
        released: "2026-09-01".to_string(),
        targets: BTreeMap::from([(PLATFORM.to_string(), target)]),
    };
    RuntimeManifest {
        node: release(NODE_VERSION, target(server, "/node.tar.gz", node, NODE_BIN)),
        uv: release("0.9.0", target(server, "/uv.tar.gz", b"uv", "uv")),
    }
}

fn installer(dir: &Path, server: &Server) -> Installer {
    Installer::new(
        ToolsDir::new(dir),
        manifest(server, &node_archive()),
        PLATFORM.to_string(),
        DownloadLimits {
            max_bytes: 1 << 20,
            connect_timeout: Duration::from_secs(5),
            stall_timeout: STALL,
            max_redirects: 5,
            require_https: false,
        },
        UnpackLimits {
            max_total_bytes: 1 << 20,
            max_entries: 100,
        },
    )
}

fn agent_step(server: &Server, id: &str, path: &str, archive: &[u8]) -> PlannedStep {
    PlannedStep::Agent {
        id: id.to_string(),
        name: format!("Agent {id}"),
        version: "1.0.0".to_string(),
        url: server.url(path),
        sha256: sha256_hex(archive),
        cmd: "./dist/my-agent".to_string(),
    }
}

fn env() -> HashMap<String, String> {
    HashMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())])
}

fn no_progress(_: InstallProgress) {}

fn node_dir(dir: &Path) -> PathBuf {
    ToolsDir::new(dir).node_dir(NODE_VERSION, PLATFORM)
}

fn staging_is_empty(dir: &Path) -> bool {
    fs::read_dir(ToolsDir::new(dir).staging_root())
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(true)
}

#[test]
fn installs_a_binary_agent_and_reports_each_phase() {
    let archive = agent_archive();
    let server = Server::start(vec![("/agent.tar.gz", Reply::Ok(archive.clone()))]);
    let d = data_dir();
    let events = Mutex::new(Vec::new());
    let steps = [agent_step(&server, "my-agent", "/agent.tar.gz", &archive)];

    installer(&d, &server)
        .run("my-agent", &steps, &env(), None, &|p| {
            events.lock().unwrap().push(p)
        })
        .unwrap();

    let events = events.into_inner().unwrap();
    let mut phases: Vec<String> = events.iter().map(|e| e.phase.clone()).collect();
    phases.dedup();
    assert_eq!(phases, ["download", "verify", "unpack"]);
    let last = events.last().unwrap();
    assert_eq!(last.agent_id, "my-agent");
    assert_eq!((last.step_index, last.step_count), (0, 1));
    assert_eq!(
        (last.kind.as_str(), last.name.as_str()),
        ("agent", "Agent my-agent")
    );
    let done = events.iter().find(|e| e.phase == "verify").unwrap();
    assert_eq!(done.received_bytes, archive.len() as u64);
    assert_eq!(done.total_bytes, Some(archive.len() as u64));

    let dest = ToolsDir::new(&d).agent_dir("my-agent", "1.0.0");
    let mode = fs::metadata(dest.join("dist/my-agent"))
        .unwrap()
        .permissions()
        .mode();
    assert_ne!(mode & 0o111, 0, "cmd must be executable");
    assert!(read_record(&dest).is_some());
    assert!(staging_is_empty(&d));
}

#[test]
fn installs_a_runtime_then_skips_it_when_present() {
    let server = Server::start(vec![("/node.tar.gz", Reply::Ok(node_archive()))]);
    let d = data_dir();
    let install = installer(&d, &server);
    let steps = [PlannedStep::Runtime(RuntimeKind::Node)];

    install
        .run("runtime:node", &steps, &env(), None, &no_progress)
        .unwrap();
    install
        .run("runtime:node", &steps, &env(), None, &no_progress)
        .unwrap();

    assert_eq!(server.hits("/node.tar.gz"), 1);
    let record = read_record(&node_dir(&d)).unwrap();
    assert_eq!(record.bin.as_deref(), Some(NODE_BIN));
    assert!(node_dir(&d).join(NODE_BIN).join("node").is_file());
}

#[test]
fn a_hash_mismatch_installs_nothing_and_empties_staging() {
    let archive = agent_archive();
    let server = Server::start(vec![("/agent.tar.gz", Reply::Ok(archive))]);
    let d = data_dir();
    let steps = [agent_step(
        &server,
        "my-agent",
        "/agent.tar.gz",
        b"something else",
    )];

    let err = installer(&d, &server)
        .run("my-agent", &steps, &env(), None, &no_progress)
        .unwrap_err();

    assert_eq!(
        err,
        "The download of Agent my-agent did not match its checksum"
    );
    assert!(!ToolsDir::new(&d).agent_dir("my-agent", "1.0.0").exists());
    assert!(staging_is_empty(&d));
}

#[test]
fn an_unknown_archive_format_fails_before_downloading() {
    let archive = agent_archive();
    let server = Server::start(vec![("/agent.exe", Reply::Ok(archive.clone()))]);
    let d = data_dir();
    let steps = [agent_step(&server, "my-agent", "/agent.exe", &archive)];

    let err = installer(&d, &server)
        .run("my-agent", &steps, &env(), None, &no_progress)
        .unwrap_err();

    assert_eq!(err, "Zorvo cannot unpack this archive format");
    assert_eq!(server.hits("/agent.exe"), 0);
}

#[test]
fn an_archive_without_the_cmd_installs_nothing() {
    let archive = tar_gz(&[("other/file", "x", 0o644)]);
    let server = Server::start(vec![("/agent.tar.gz", Reply::Ok(archive.clone()))]);
    let d = data_dir();
    let steps = [agent_step(&server, "my-agent", "/agent.tar.gz", &archive)];

    let err = installer(&d, &server)
        .run("my-agent", &steps, &env(), None, &no_progress)
        .unwrap_err();

    assert_eq!(
        err,
        "Agent my-agent's archive does not contain ./dist/my-agent"
    );
    assert!(!ToolsDir::new(&d).agent_dir("my-agent", "1.0.0").exists());
    assert!(staging_is_empty(&d));
}

#[test]
fn a_second_run_with_the_same_job_id_is_rejected() {
    let server = Server::start(vec![("/node.tar.gz", Reply::StallFirst(node_archive()))]);
    let d = data_dir();
    let install = installer(&d, &server);
    let steps = [PlannedStep::Runtime(RuntimeKind::Node)];

    thread::scope(|s| {
        let first = s.spawn(|| install.run("job", &steps, &env(), None, &no_progress));
        server.wait_for_hits("/node.tar.gz", 1);

        let second = install.run("job", &steps, &env(), None, &no_progress);
        // The user sees the plan's name, not the job id.
        assert_eq!(second, Err("Node.js is already installing".to_string()));

        assert!(install.cancel("job"));
        assert_eq!(first.join().unwrap(), Err(INSTALL_CANCELLED.to_string()));
    });
    assert!(!install.cancel("job"), "a finished job is forgotten");
    assert!(staging_is_empty(&d));
}

#[test]
fn two_agents_needing_node_download_it_once() {
    let a = agent_archive();
    let b = tar_gz(&[("dist/my-agent", "#!/bin/sh\necho b\n", 0o755)]);
    let server = Server::start(vec![
        (
            "/node.tar.gz",
            Reply::Slow(node_archive(), Duration::from_millis(300)),
        ),
        ("/a.tar.gz", Reply::Ok(a.clone())),
        ("/b.tar.gz", Reply::Ok(b.clone())),
    ]);
    let d = data_dir();
    let install = installer(&d, &server);
    let steps_a = [
        PlannedStep::Runtime(RuntimeKind::Node),
        agent_step(&server, "a", "/a.tar.gz", &a),
    ];
    let steps_b = [
        PlannedStep::Runtime(RuntimeKind::Node),
        agent_step(&server, "b", "/b.tar.gz", &b),
    ];

    let (ra, rb) = thread::scope(|s| {
        let ta = s.spawn(|| install.run("a", &steps_a, &env(), None, &no_progress));
        let tb = s.spawn(|| install.run("b", &steps_b, &env(), None, &no_progress));
        (ta.join().unwrap(), tb.join().unwrap())
    });

    assert_eq!((ra, rb), (Ok(()), Ok(())));
    assert_eq!(server.hits("/node.tar.gz"), 1);
    let tools = ToolsDir::new(&d);
    assert!(read_record(&tools.agent_dir("a", "1.0.0")).is_some());
    assert!(read_record(&tools.agent_dir("b", "1.0.0")).is_some());
}

#[test]
fn cancelling_one_job_leaves_the_other_to_finish() {
    let b = agent_archive();
    let server = Server::start(vec![
        ("/node.tar.gz", Reply::StallFirst(node_archive())),
        ("/b.tar.gz", Reply::Ok(b.clone())),
    ]);
    let d = data_dir();
    let install = installer(&d, &server);
    let steps_a = [PlannedStep::Runtime(RuntimeKind::Node)];
    let steps_b = [
        PlannedStep::Runtime(RuntimeKind::Node),
        agent_step(&server, "b", "/b.tar.gz", &b),
    ];

    thread::scope(|s| {
        let ta = s.spawn(|| install.run("a", &steps_a, &env(), None, &no_progress));
        server.wait_for_hits("/node.tar.gz", 1);
        let tb = s.spawn(|| install.run("b", &steps_b, &env(), None, &no_progress));
        // Let B reach Node's lock, which A holds while its download stalls.
        thread::sleep(Duration::from_millis(300));

        assert!(install.cancel("a"));
        assert_eq!(ta.join().unwrap(), Err(INSTALL_CANCELLED.to_string()));
        assert_eq!(tb.join().unwrap(), Ok(()));
    });

    assert_eq!(server.hits("/node.tar.gz"), 2);
    assert!(read_record(&node_dir(&d)).is_some());
    assert!(read_record(&ToolsDir::new(&d).agent_dir("b", "1.0.0")).is_some());
    assert!(staging_is_empty(&d));
}

#[test]
fn a_job_waiting_on_a_lock_is_cancelled_promptly() {
    let server = Server::start(vec![("/node.tar.gz", Reply::StallFirst(node_archive()))]);
    let d = data_dir();
    let install = installer(&d, &server);
    let steps = [PlannedStep::Runtime(RuntimeKind::Node)];

    thread::scope(|s| {
        let ta = s.spawn(|| install.run("a", &steps, &env(), None, &no_progress));
        server.wait_for_hits("/node.tar.gz", 1);
        let tb = s.spawn(|| install.run("b", &steps, &env(), None, &no_progress));
        thread::sleep(Duration::from_millis(200));

        let started = Instant::now();
        assert!(install.cancel("b"));
        assert_eq!(tb.join().unwrap(), Err(INSTALL_CANCELLED.to_string()));
        assert!(started.elapsed() < Duration::from_secs(2));

        assert!(install.cancel("a"));
        assert_eq!(ta.join().unwrap(), Err(INSTALL_CANCELLED.to_string()));
    });
    assert_eq!(server.hits("/node.tar.gz"), 1);
}

#[test]
fn a_prerequisite_uses_zorvos_node_when_the_users_is_too_old() {
    let server = Server::start(vec![("/node.tar.gz", Reply::Ok(node_archive()))]);
    let d = data_dir();
    let pi = &prerequisites_for("pi-acp")[0];
    let steps = [
        PlannedStep::Runtime(RuntimeKind::Node),
        PlannedStep::Prerequisite(pi),
    ];
    let events = Mutex::new(Vec::new());

    installer(&d, &server)
        .run("pi-acp", &steps, &env(), Some(20), &|p| {
            events.lock().unwrap().push(p)
        })
        .unwrap();

    let dest = ToolsDir::new(&d).prereq_dir(pi.command, pi.version);
    assert!(read_record(&dest).is_some());
    assert!(dest.join("bin/pi").is_file());
    let node_bin = node_dir(&d).join(NODE_BIN);
    let path = fs::read_to_string(dest.join("path.txt")).unwrap();
    assert_eq!(path, format!("{}:/usr/bin:/bin", node_bin.display()));
    let events = events.into_inner().unwrap();
    let npm = events.iter().find(|e| e.phase == "npm").unwrap();
    assert_eq!((npm.step_index, npm.step_count), (1, 2));
    assert_eq!(
        (npm.kind.as_str(), npm.name.as_str()),
        ("prerequisite", "pi")
    );
}

#[test]
fn a_prerequisite_uses_the_users_npm_when_node_is_new_enough() {
    let server = Server::start(vec![]);
    let d = data_dir();
    let user_bin = d.join("user-bin");
    fs::create_dir_all(&user_bin).unwrap();
    fs::write(user_bin.join("npm"), FAKE_NPM).unwrap();
    fs::set_permissions(user_bin.join("npm"), fs::Permissions::from_mode(0o755)).unwrap();
    let user_path = format!("{}:/usr/bin:/bin", user_bin.display());
    let env = HashMap::from([("PATH".to_string(), user_path.clone())]);
    let pi = &prerequisites_for("pi-acp")[0];

    installer(&d, &server)
        .run(
            "pi-acp",
            &[PlannedStep::Prerequisite(pi)],
            &env,
            Some(22),
            &no_progress,
        )
        .unwrap();

    let dest = ToolsDir::new(&d).prereq_dir(pi.command, pi.version);
    assert!(dest.join("bin/pi").is_file());
    assert_eq!(
        fs::read_to_string(dest.join("path.txt")).unwrap(),
        user_path
    );
}

#[test]
fn a_prerequisite_without_any_node_fails() {
    let server = Server::start(vec![]);
    let d = data_dir();
    let pi = &prerequisites_for("pi-acp")[0];

    let err = installer(&d, &server)
        .run(
            "pi-acp",
            &[PlannedStep::Prerequisite(pi)],
            &env(),
            None,
            &no_progress,
        )
        .unwrap_err();

    assert_eq!(err, "pi needs Node.js, which is not installed");
    assert!(!ToolsDir::new(&d)
        .prereq_dir(pi.command, pi.version)
        .exists());
}

/// Makes `dir` look installed.
fn mark_installed(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    fs::write(
        dir.join("install.json"),
        r#"{"source":"test","sha256":null,"installed_at":1,"bin":null}"#,
    )
    .unwrap();
}

#[test]
fn remove_agent_keeps_prereqs_still_needed() {
    let server = Server::start(vec![]);
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    let pi = &prerequisites_for("pi-acp")[0];
    mark_installed(&tools.agent_dir("pi-acp", "1.0.0"));
    mark_installed(&tools.agent_dir("pi-acp", "1.1.0"));
    mark_installed(&tools.agent_dir("other", "1.0.0"));
    let prereq = tools.prereq_dir(pi.command, pi.version);
    mark_installed(&prereq);
    let install = installer(&d, &server);

    install
        .remove_agent("pi-acp", &BTreeSet::from(["pi".to_string()]))
        .unwrap();
    assert!(!tools.root().join("agents/pi-acp").exists());
    assert!(read_record(&tools.agent_dir("other", "1.0.0")).is_some());
    assert!(read_record(&prereq).is_some());

    install.remove_agent("pi-acp", &BTreeSet::new()).unwrap();
    assert!(!prereq.exists());
    assert!(read_record(&tools.agent_dir("other", "1.0.0")).is_some());
}

#[test]
fn remove_agent_refuses_an_id_that_leaves_the_agents_dir() {
    let server = Server::start(vec![]);
    let d = data_dir();
    let tools = ToolsDir::new(&d);
    mark_installed(&tools.node_dir(NODE_VERSION, PLATFORM));
    let install = installer(&d, &server);

    for id in ["", ".", "..", "../node", "a/b"] {
        assert!(
            install.remove_agent(id, &BTreeSet::new()).is_err(),
            "{id:?}"
        );
    }
    assert!(read_record(&tools.node_dir(NODE_VERSION, PLATFORM)).is_some());
}

#[test]
fn an_agent_version_that_is_not_a_plain_name_installs_nothing() {
    let archive = agent_archive();
    let server = Server::start(vec![("/agent.tar.gz", Reply::Ok(archive.clone()))]);
    let d = data_dir();
    for (id, version) in [("my-agent", "../x"), ("my-agent", "a/b"), ("..", "1.0.0")] {
        let step = PlannedStep::Agent {
            id: id.to_string(),
            name: "Agent".to_string(),
            version: version.to_string(),
            url: server.url("/agent.tar.gz"),
            sha256: sha256_hex(&archive),
            cmd: "./dist/my-agent".to_string(),
        };

        let err = installer(&d, &server)
            .run("job", &[step], &env(), None, &no_progress)
            .unwrap_err();

        assert_eq!(
            err,
            "Zorvo cannot install Agent: its id or version is not a plain name"
        );
    }
    assert_eq!(server.hits("/agent.tar.gz"), 0);
    assert!(!ToolsDir::new(&d).root().exists(), "nothing is created");
}

#[test]
fn an_install_replaces_a_dir_left_without_a_record() {
    let archive = agent_archive();
    let server = Server::start(vec![("/agent.tar.gz", Reply::Ok(archive.clone()))]);
    let d = data_dir();
    let dest = ToolsDir::new(&d).agent_dir("my-agent", "1.0.0");
    fs::create_dir_all(dest.join("dist")).unwrap();
    fs::write(dest.join("dist/stale"), "left by a failed removal").unwrap();
    let steps = [agent_step(&server, "my-agent", "/agent.tar.gz", &archive)];

    installer(&d, &server)
        .run("my-agent", &steps, &env(), None, &no_progress)
        .unwrap();

    assert!(read_record(&dest).is_some());
    assert!(dest.join("dist/my-agent").is_file());
    assert!(!dest.join("dist/stale").exists());
}

#[test]
fn a_prerequisite_with_a_new_enough_node_but_no_npm_says_so() {
    let server = Server::start(vec![]);
    let d = data_dir();
    let pi = &prerequisites_for("pi-acp")[0];

    let err = installer(&d, &server)
        .run(
            "pi-acp",
            &[PlannedStep::Prerequisite(pi)],
            &env(),
            Some(22),
            &no_progress,
        )
        .unwrap_err();

    assert_eq!(err, "pi needs npm, which is not on your PATH");
}

#[test]
fn clean_up_waits_for_no_job_and_skips_while_one_runs() {
    use zorvo_lib::installer::cleanup::CleanupInputs;

    let server = Server::start(vec![("/node.tar.gz", Reply::StallFirst(node_archive()))]);
    let d = data_dir();
    let install = installer(&d, &server);
    let tools = ToolsDir::new(&d);
    let left_over = tools.staging_root().join("left-over");
    fs::create_dir_all(&left_over).unwrap();
    let inputs = CleanupInputs {
        agents_in_use: BTreeMap::new(),
        uses_npx: true,
        uses_uvx: true,
        prereqs_needed: BTreeSet::new(),
    };
    let steps = [PlannedStep::Runtime(RuntimeKind::Node)];

    thread::scope(|s| {
        let job = s.spawn(|| install.run("job", &steps, &env(), None, &no_progress));
        server.wait_for_hits("/node.tar.gz", 1);

        assert_eq!(install.clean_up(&inputs), None, "a job is running");
        assert!(left_over.exists());

        assert!(install.cancel("job"));
        assert_eq!(job.join().unwrap(), Err(INSTALL_CANCELLED.to_string()));
    });
    assert_eq!(install.clean_up(&inputs), Some(Vec::new()));
    assert!(!left_over.exists());
}

#[test]
fn a_cancel_during_a_slow_clean_up_returns_promptly_and_ends_the_waiting_install() {
    let server = Server::start(vec![("/node.tar.gz", Reply::Ok(node_archive()))]);
    let d = data_dir();
    let install = installer(&d, &server);
    let steps = [PlannedStep::Runtime(RuntimeKind::Node)];
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (finish_tx, finish_rx) = std::sync::mpsc::channel::<()>();

    thread::scope(|s| {
        // A clean-up that deletes until the test lets it finish.
        let install = &install;
        let started_tx = started_tx.clone();
        let cleaning = s.spawn(move || {
            install.run_exclusive(|| {
                started_tx.send(()).unwrap();
                let _ = finish_rx.recv_timeout(Duration::from_secs(3));
            })
        });
        started_rx.recv().unwrap();
        let job = s.spawn(|| install.run("job", &steps, &env(), None, &no_progress));
        thread::sleep(Duration::from_millis(200));

        let asked = Instant::now();
        install.cancel("job");
        let cancel_took = asked.elapsed();
        let ended = job.join().unwrap();
        let job_took = asked.elapsed();
        let _ = finish_tx.send(());
        assert!(cleaning.join().unwrap().is_some());

        assert!(cancel_took < Duration::from_millis(500), "{cancel_took:?}");
        assert_eq!(ended, Err(INSTALL_CANCELLED.to_string()));
        assert!(job_took < Duration::from_secs(2), "{job_took:?}");
    });
    assert_eq!(server.hits("/node.tar.gz"), 0);
}

#[test]
fn a_cancel_before_the_job_starts_is_not_lost() {
    let server = Server::start(vec![("/node.tar.gz", Reply::Ok(node_archive()))]);
    let d = data_dir();
    let install = installer(&d, &server);
    let steps = [PlannedStep::Runtime(RuntimeKind::Node)];

    install.cancel("job");
    assert_eq!(
        install.run("job", &steps, &env(), None, &no_progress),
        Err(INSTALL_CANCELLED.to_string())
    );
    assert_eq!(server.hits("/node.tar.gz"), 0);

    // The cancel is used up: the next install runs.
    assert_eq!(
        install.run("job", &steps, &env(), None, &no_progress),
        Ok(())
    );
}

#[test]
fn stopping_a_job_that_is_not_running_records_nothing() {
    let server = Server::start(vec![("/node.tar.gz", Reply::Ok(node_archive()))]);
    let d = data_dir();
    let install = installer(&d, &server);
    let steps = [PlannedStep::Runtime(RuntimeKind::Node)];

    assert!(!install.stop_if_running("job"));
    assert_eq!(
        install.run("job", &steps, &env(), None, &no_progress),
        Ok(())
    );
}
