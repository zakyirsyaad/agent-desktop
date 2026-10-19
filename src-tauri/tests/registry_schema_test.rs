use zorvo_lib::registry::schema::{current_platform, parse_registry, Distribution, RegistryEntry};

const SHA: &str = "c2d0fecd27acf6e08be02c1f5d384614d07495587766bcc4a6bff3971749bb64";

fn npx(id: &str, package: &str) -> String {
    format!(
        r#"{{"id":"{id}","name":"N","version":"1.0.0","distribution":{{"npx":{{"package":"{package}","args":["--acp"]}}}}}}"#
    )
}

fn binary(id: &str, archive: &str, cmd: &str, sha: &str) -> String {
    format!(
        r#"{{"id":"{id}","name":"B","version":"1.0.0","distribution":{{"binary":{{"darwin-aarch64":{{"archive":"{archive}","cmd":"{cmd}","args":["acp"],"sha256":"{sha}"}}}}}}}}"#
    )
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
            args: vec!["--acp".into()]
        }
    );
    assert_eq!(entries[1].icon.as_deref(), Some("https://x/i.svg"));
    match &entries[1].distribution {
        Distribution::Uvx { package, args } => {
            assert_eq!(package, "py-agent@2.0.0");
            assert_eq!(args, &vec!["acp".to_string()]);
        }
        other => panic!("expected uvx, got {other:?}"),
    }
    match &entries[2].distribution {
        Distribution::Binary { platforms } => {
            let t = &platforms["darwin-aarch64"];
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
