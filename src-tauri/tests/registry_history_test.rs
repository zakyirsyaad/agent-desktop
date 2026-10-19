use zorvo_lib::registry::history::{VersionHistory, MIN_AGE_SECS};
use zorvo_lib::registry::schema::{Distribution, RegistryEntry};

fn entry(id: &str, version: &str) -> RegistryEntry {
    RegistryEntry {
        id: id.into(),
        name: id.into(),
        version: version.into(),
        description: None,
        icon: None,
        distribution: Distribution::Npx {
            package: format!("{id}@{version}"),
            args: vec![],
            env: Default::default(),
        },
    }
}

fn history(seen: &[(&str, &str, u64)]) -> VersionHistory {
    let mut h = VersionHistory::default();
    for (id, version, at) in seen {
        h.observe(&[entry(id, version)], *at);
    }
    h
}

#[test]
fn offers_the_newest_version_past_seven_days() {
    let h = history(&[("a", "1.0.0", 0), ("a", "2.0.0", 100)]);
    assert_eq!(h.offered("a", MIN_AGE_SECS + 100).unwrap().version, "2.0.0");
    assert_eq!(h.offered("a", MIN_AGE_SECS + 99).unwrap().version, "1.0.0");
}

#[test]
fn offers_nothing_before_seven_days() {
    let h = history(&[("a", "1.0.0", 0)]);
    assert!(h.offered("a", MIN_AGE_SECS - 1).is_none());
    assert!(h.offered("a", MIN_AGE_SECS).is_some());
    assert!(h.offered("missing", MIN_AGE_SECS).is_none());
}

#[test]
fn offers_nothing_newer_than_the_ceiling() {
    let h = history(&[("a", "1.0.0", 0), ("a", "1.10.0", 0), ("a", "2.0.0", 0)]);
    let now = MIN_AGE_SECS;
    assert_eq!(
        h.offered_up_to("a", now, Some("1.10.0")).unwrap().version,
        "1.10.0"
    );
    assert_eq!(
        h.offered_up_to("a", now, Some("1.9.0")).unwrap().version,
        "1.0.0"
    );
    assert_eq!(h.offered_up_to("a", now, None).unwrap().version, "2.0.0");
    assert!(h.offered_up_to("a", now, Some("0.9.0")).is_none());
}

#[test]
fn observe_never_moves_an_existing_date() {
    let mut h = VersionHistory::default();
    assert!(h.observe(&[entry("a", "1.0.0")], 10));
    assert!(!h.observe(&[entry("a", "1.0.0")], 20));
    assert_eq!(h.agents["a"]["1.0.0"].first_seen, 10);
}

#[test]
fn merge_keeps_the_earlier_date() {
    let mut mine = history(&[("a", "1.0.0", 50)]);
    let theirs = history(&[("a", "1.0.0", 5), ("b", "1.0.0", 9)]);
    mine.merge(&theirs);
    assert_eq!(mine.agents["a"]["1.0.0"].first_seen, 5);
    assert_eq!(mine.agents["b"]["1.0.0"].first_seen, 9);

    let mut early = history(&[("a", "1.0.0", 1)]);
    early.merge(&history(&[("a", "1.0.0", 7)]));
    assert_eq!(early.agents["a"]["1.0.0"].first_seen, 1);
}

#[test]
fn orders_versions_by_semver_not_text() {
    let h = history(&[
        ("a", "0.9.9", 0),
        ("a", "0.10.0", 0),
        ("a", "0.10.0-beta.1", 0),
    ]);
    assert_eq!(h.offered("a", MIN_AGE_SECS).unwrap().version, "0.10.0");
    let pre = history(&[("a", "1.0.0-rc.1", 0), ("a", "0.9.0", 0)]);
    assert_eq!(
        pre.offered("a", MIN_AGE_SECS).unwrap().version,
        "1.0.0-rc.1"
    );
    let both = history(&[("a", "1.0.0-rc.1", 0), ("a", "1.0.0", 0)]);
    assert_eq!(both.offered("a", MIN_AGE_SECS).unwrap().version, "1.0.0");
}

#[test]
fn looks_up_versions_and_ids() {
    let h = history(&[("b", "1.0.0", 0), ("a", "1.0.0", 0), ("a", "2.0.0", 0)]);
    assert_eq!(h.version("a", "2.0.0").unwrap().version, "2.0.0");
    assert!(h.version("a", "3.0.0").is_none());
    assert_eq!(h.ids().collect::<Vec<_>>(), vec!["a", "b"]);
}

#[test]
fn round_trips_through_json() {
    let h = history(&[("a", "1.0.0", 3), ("a", "1.1.0", 4)]);
    assert_eq!(VersionHistory::from_json(&h.to_json()).unwrap(), h);
    assert!(VersionHistory::from_json("nope").is_err());
}

#[test]
fn bundled_history_offers_the_default_agents() {
    let h = VersionHistory::from_json(include_str!("../resources/registry-history.json")).unwrap();
    let generated_at = h
        .agents
        .values()
        .flat_map(|versions| versions.values())
        .map(|record| record.first_seen)
        .max()
        .unwrap();
    for id in ["claude-acp", "codex-acp", "qwen-code"] {
        assert!(h.offered(id, generated_at).is_some(), "{id} is not offered");
    }
}

fn record(id: &str, version: &str, package: &str) -> String {
    format!(
        r#""{version}": {{"first_seen": 5, "entry": {{"id": "{id}", "name": "{id}", "version": "{version}",
        "distribution": {{"npx": {{"package": "{package}"}}}}}}}}"#
    )
}

#[test]
fn skips_invalid_records_and_keeps_the_rest() {
    let json = format!(
        r#"{{"agents": {{"a": {{ {good}, {unpinned}, {two_kinds} }}}}}}"#,
        good = record("a", "1.0.0", "a@1.0.0"),
        unpinned = record("a", "2.0.0", "a"),
        two_kinds = r#""3.0.0": {"first_seen": 5, "entry": {"id": "a", "name": "a", "version": "3.0.0",
            "distribution": {"npx": {"package": "a@3.0.0"}, "uvx": {"package": "a@3.0.0"}}}}"#,
    );
    let h = VersionHistory::from_json(&json).unwrap();
    assert!(h.version("a", "1.0.0").is_some());
    assert!(h.version("a", "2.0.0").is_none());
    assert!(h.version("a", "3.0.0").is_none());
}

#[test]
fn skips_a_record_whose_entry_does_not_match_its_key() {
    let json = format!(
        r#"{{"agents": {{"a": {{ {} }}}}}}"#,
        record("a", "9.9.9", "a@9.9.9").replace("\"9.9.9\": {", "\"1.0.0\": {")
    );
    assert!(VersionHistory::from_json(&json)
        .unwrap()
        .version("a", "1.0.0")
        .is_none());
}

#[test]
fn rejects_a_file_without_agents() {
    assert!(VersionHistory::from_json("{}").is_err());
    assert!(VersionHistory::from_json("[]").is_err());
}
