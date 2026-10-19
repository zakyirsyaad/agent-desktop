use zorvo_lib::registry::schema::{current_platform, parse_registry, Distribution, RegistryEntry};

const SHA: &str = "c2d0fecd27acf6e08be02c1f5d384614d07495587766bcc4a6bff3971749bb64";

fn npx(id: &str, package: &str) -> String {
    format!(
        r#"{{"id":"{id}","name":"N","version":"1.0.0","distribution":{{"npx":{{"package":"{package}","args":["--acp"]}}}}}}"#
    )
}

fn target(archive: &str, cmd: &str, sha: &str) -> String {
    format!(r#"{{"archive":"{archive}","cmd":"{cmd}","args":["acp"],"sha256":"{sha}"}}"#)
}

fn binary_on(id: &str, targets: &[(&str, String)]) -> String {
    let body: Vec<String> = targets
        .iter()
        .map(|(platform, t)| format!(r#""{platform}":{t}"#))
        .collect();
    format!(
        r#"{{"id":"{id}","name":"B","version":"1.0.0","distribution":{{"binary":{{{}}}}}}}"#,
        body.join(",")
    )
}

fn binary(id: &str, archive: &str, cmd: &str, sha: &str) -> String {
    binary_on(id, &[(current_platform(), target(archive, cmd, sha))])
}

fn doc(entries: &[String]) -> String {
    format!(
        r#"{{"version":"1.0.0","agents":[{}],"extensions":[]}}"#,
        entries.join(",")
    )
}

fn ids(entries: &[RegistryEntry]) -> Vec<&str> {
    entries.iter().map(|e| e.id.as_str()).collect()
}

#[test]
fn parses_valid_npx_uvx_and_binary_entries() {
    let uvx = r#"{"id":"py","name":"Py","version":"2.0.0","description":"d","icon":"https://x/i.svg","distribution":{"uvx":{"package":"py-agent@2.0.0","args":["acp"]}},"license":"MIT","authors":["a"]}"#;
    let json = doc(&[
        npx("gemini", "@google/gemini-cli@0.64.0"),
        uvx.to_string(),
        binary(
            "opencode",
            "https://github.com/o/r/releases/download/v1/o.zip",
            "./opencode",
            SHA,
        ),
    ]);
    let entries = parse_registry(&json).unwrap();
    assert_eq!(ids(&entries), vec!["gemini", "py", "opencode"]);
    assert_eq!(
        entries[0].distribution,
        Distribution::Npx {
            package: "@google/gemini-cli@0.64.0".into(),
            args: vec!["--acp".into()],
            env: Default::default(),
        }
    );
    assert_eq!(entries[1].icon.as_deref(), Some("https://x/i.svg"));
    match &entries[1].distribution {
        Distribution::Uvx { package, args, .. } => {
            assert_eq!(package, "py-agent@2.0.0");
            assert_eq!(args, &vec!["acp".to_string()]);
        }
        other => panic!("expected uvx, got {other:?}"),
    }
    match &entries[2].distribution {
        Distribution::Binary { platforms } => {
            let t = &platforms[current_platform()];
            assert_eq!(t.cmd, "./opencode");
            assert_eq!(t.sha256, SHA);
            assert!(t.archive.starts_with("https://"));
        }
        other => panic!("expected binary, got {other:?}"),
    }
}

#[test]
fn entries_round_trip_through_the_registry_json_shape() {
    let json = doc(&[
        npx("gemini", "@google/gemini-cli@0.64.0"),
        binary("opencode", "https://h/o.zip", "./opencode", SHA),
    ]);
    let entries = parse_registry(&json).unwrap();
    let value = serde_json::to_value(&entries[0]).unwrap();
    assert_eq!(
        value["distribution"]["npx"]["package"],
        "@google/gemini-cli@0.64.0"
    );
    assert!(value["distribution"]["binary"].is_null());
    let back: Vec<RegistryEntry> =
        serde_json::from_value(serde_json::to_value(&entries).unwrap()).unwrap();
    assert_eq!(back, entries);
}

#[test]
fn skips_an_entry_whose_id_breaks_the_pattern() {
    let json = doc(&[npx("Bad_Id", "a@1.0.0"), npx("good-1", "b@1.0.0")]);
    assert_eq!(ids(&parse_registry(&json).unwrap()), vec!["good-1"]);
}

#[test]
fn skips_an_unpinned_package() {
    let json = doc(&[
        npx("a", "@x/y"),
        npx("b", "y@latest"),
        npx("c", "@x/y@1.2.3"),
        npx("d", "y@0.0.34"),
    ]);
    assert_eq!(ids(&parse_registry(&json).unwrap()), vec!["c", "d"]);
}

#[test]
fn skips_a_binary_without_https_or_a_64_hex_sha256() {
    let json = doc(&[
        binary("a", "http://h/o.zip", "./o", SHA),
        binary("b", "https://h/o.zip", "./o", "abc"),
        binary("c", "https://h/o.zip", "./o", SHA),
    ]);
    assert_eq!(ids(&parse_registry(&json).unwrap()), vec!["c"]);
}

#[test]
fn skips_a_cmd_that_is_absolute_or_climbs() {
    let json = doc(&[
        binary("a", "https://h/o.zip", "/bin/sh", SHA),
        binary("b", "https://h/o.zip", "../x", SHA),
        binary("c", "https://h/o.zip", "bin/../../x", SHA),
        binary("d", "https://h/o.zip", "./bin/o", SHA),
    ]);
    assert_eq!(ids(&parse_registry(&json).unwrap()), vec!["d"]);
}

#[test]
fn skips_an_entry_with_no_or_two_distributions() {
    let none = r#"{"id":"none","name":"N","version":"1.0.0","distribution":{}}"#;
    let two = r#"{"id":"two","name":"N","version":"1.0.0","distribution":{"npx":{"package":"a@1.0.0"},"uvx":{"package":"a@1.0.0"}}}"#;
    let json = doc(&[none.into(), two.into(), npx("ok", "a@1.0.0")]);
    assert_eq!(ids(&parse_registry(&json).unwrap()), vec!["ok"]);
}

#[test]
fn rejects_a_document_without_agents() {
    assert!(parse_registry("{}").is_err());
    assert!(parse_registry("not json").is_err());
}

#[test]
fn current_platform_names_os_and_arch() {
    let p = current_platform();
    assert!(p.contains('-'), "got {p}");
}

#[test]
fn keeps_an_id_that_starts_with_a_digit() {
    let json = doc(&[npx("7zip-agent", "a@1.0.0")]);
    assert_eq!(ids(&parse_registry(&json).unwrap()), vec!["7zip-agent"]);
}

#[test]
fn ignores_an_invalid_target_for_another_platform() {
    let good = target("https://h/o.zip", "./o", SHA);
    let bad = target("https://h/o.zip", ".\\\\agent.exe", SHA);
    let json = doc(&[binary_on(
        "mixed",
        &[(current_platform(), good), ("windows-x86_64-other", bad)],
    )]);
    assert_eq!(ids(&parse_registry(&json).unwrap()), vec!["mixed"]);
}

#[test]
fn skips_a_binary_with_no_target_for_this_platform() {
    let good = target("https://h/o.zip", "./o", SHA);
    let json = doc(&[
        binary_on("elsewhere", &[("other-platform", good)]),
        npx("ok", "a@1.0.0"),
    ]);
    assert_eq!(ids(&parse_registry(&json).unwrap()), vec!["ok"]);
}

fn uvx(id: &str, package: &str) -> String {
    format!(
        r#"{{"id":"{id}","name":"U","version":"1.0.0","distribution":{{"uvx":{{"package":"{package}"}}}}}}"#
    )
}

fn npx_env(id: &str, env: &str) -> String {
    format!(
        r#"{{"id":"{id}","name":"N","version":"1.0.0","distribution":{{"npx":{{"package":"p@1.0.0","env":{env}}}}}}}"#
    )
}

#[test]
fn uvx_accepts_pypi_pins_but_npx_does_not() {
    let json = doc(&[
        uvx("pypi", "fast-agent-acp==0.10.1"),
        uvx("at", "agent@1.0.0"),
        uvx("loose", "agent"),
        uvx("range", "agent==1.0"),
        npx("npm-eq", "agent==1.0.0"),
    ]);
    assert_eq!(ids(&parse_registry(&json).unwrap()), vec!["pypi", "at"]);
}

#[test]
fn env_is_parsed_and_round_trips() {
    let json = doc(&[
        npx_env("withenv", r#"{"AUGMENT_DISABLE_AUTO_UPDATE":"1"}"#),
        binary_on(
            "bin",
            &[(
                current_platform(),
                format!(
                    r#"{{"archive":"https://h/o.zip","cmd":"./o","sha256":"{SHA}","env":{{"VT_ACP_ENABLED":"1"}}}}"#
                ),
            )],
        ),
    ]);
    let entries = parse_registry(&json).unwrap();
    assert_eq!(ids(&entries), vec!["withenv", "bin"]);
    match &entries[0].distribution {
        Distribution::Npx { env, .. } => assert_eq!(env["AUGMENT_DISABLE_AUTO_UPDATE"], "1"),
        other => panic!("expected npx, got {other:?}"),
    }
    let value = serde_json::to_value(&entries).unwrap();
    assert_eq!(
        value[0]["distribution"]["npx"]["env"]["AUGMENT_DISABLE_AUTO_UPDATE"],
        "1"
    );
    let back: Vec<RegistryEntry> = serde_json::from_value(value).unwrap();
    assert_eq!(back, entries);
    // No env key is written when there is none.
    let plain = parse_registry(&doc(&[npx("plain", "p@1.0.0")])).unwrap();
    let plain = serde_json::to_value(&plain[0]).unwrap();
    assert!(plain["distribution"]["npx"]["env"].is_null());
}

#[test]
fn unsafe_env_names_skip_the_entry() {
    let json = doc(&[
        npx_env("ok", r#"{"GOOD_NAME":"1"}"#),
        npx_env("lower", r#"{"lower":"1"}"#),
        npx_env("dyld", r#"{"DYLD_INSERT_LIBRARIES":"x"}"#),
        npx_env("ld", r#"{"LD_PRELOAD":"x"}"#),
        npx_env("path", r#"{"PATH":"x"}"#),
        npx_env("home", r#"{"HOME":"x"}"#),
        npx_env("node", r#"{"NODE_OPTIONS":"x"}"#),
        binary_on(
            "binbad",
            &[(
                current_platform(),
                format!(
                    r#"{{"archive":"https://h/o.zip","cmd":"./o","sha256":"{SHA}","env":{{"PATH":"x"}}}}"#
                ),
            )],
        ),
    ]);
    assert_eq!(ids(&parse_registry(&json).unwrap()), vec!["ok"]);
}

#[test]
fn skips_a_package_name_that_is_an_option_or_a_url() {
    let json = doc(&[
        npx("opt", "--registry=https://evil.example/@1.0.0"),
        npx("url", "https://evil.example/a.tgz#@1.0.0"),
        uvx("git", "git+https://x/y@1.0.0"),
        uvx("index", "--index-url=https://x==1.0.0"),
        npx("dash", "-x@1.0.0"),
        npx("dot", ".x@1.0.0"),
        npx("deep", "a/b@1.0.0"),
        npx("scoped", "@scope-1/pkg.name_x@1.0.0"),
        npx("plain", "pkg-name.js@1.0.0"),
        uvx("pypi", "Fast_Agent-acp.x==0.10.1"),
    ]);
    assert_eq!(
        ids(&parse_registry(&json).unwrap()),
        vec!["scoped", "plain", "pypi"]
    );
}

#[test]
fn env_that_steers_package_managers_or_the_network_skips_the_entry() {
    let denied = [
        "NPM_CONFIG_REGISTRY",
        "UV_INDEX_URL",
        "PIP_INDEX_URL",
        "PYTHONPATH",
        "NODE_TLS_REJECT_UNAUTHORIZED",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        "BASH_ENV",
        "ENV",
        "SHELL",
    ];
    let mut entries: Vec<String> = denied
        .iter()
        .map(|key| {
            npx_env(
                &key.to_lowercase().replace('_', "-"),
                &format!(r#"{{"{key}":"x"}}"#),
            )
        })
        .collect();
    entries.push(npx_env("ok", r#"{"GOOD_NAME":"1"}"#));
    assert_eq!(ids(&parse_registry(&doc(&entries)).unwrap()), vec!["ok"]);
}

#[test]
fn keeps_the_env_keys_real_registry_agents_use() {
    let json = doc(&[
        npx_env("auggie", r#"{"AUGMENT_DISABLE_AUTO_UPDATE":"1"}"#),
        npx_env(
            "factory-droid",
            r#"{"DROID_DISABLE_AUTO_UPDATE":"1","FACTORY_DROID_AUTO_UPDATE_ENABLED":"false"}"#,
        ),
        npx_env("fast-agent", r#"{"FAST_AGENT_MODEL":"m"}"#),
        npx_env(
            "vtcode",
            r#"{"VT_ACP_ENABLED":"1","VT_ACP_ZED_ENABLED":"1"}"#,
        ),
    ]);
    assert_eq!(
        ids(&parse_registry(&json).unwrap()),
        vec!["auggie", "factory-droid", "fast-agent", "vtcode"]
    );
}

#[test]
fn skips_an_id_that_collides_with_a_legacy_or_terminal_agent() {
    let json = doc(&[
        npx("claude-code", "a@1.0.0"),
        npx("codex", "a@1.0.0"),
        npx("qwen", "a@1.0.0"),
        npx("omp", "a@1.0.0"),
        npx("aider", "a@1.0.0"),
        npx("claude-acp", "a@1.0.0"),
    ]);
    assert_eq!(ids(&parse_registry(&json).unwrap()), vec!["claude-acp"]);
}

#[test]
fn skips_a_binary_whose_cmd_is_an_interpreter_shell_or_package_runner() {
    let json = doc(&[
        binary("runs-node", "https://h/o.zip", "./node", SHA),
        binary("runs-bash", "https://h/o.zip", "./bash", SHA),
        binary("runs-npx", "https://h/o.zip", "bin/NPX", SHA),
        binary("runs-python", "https://h/o.zip", "python3", SHA),
        binary("opencode", "https://h/o.zip", "./opencode", SHA),
    ]);
    assert_eq!(ids(&parse_registry(&json).unwrap()), vec!["opencode"]);
}
