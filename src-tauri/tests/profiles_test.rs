use std::collections::BTreeMap;

use zorvo_lib::profiles::{agent_profile, agent_profiles, AgentProfile};

/// Every agent at its offered version, as on a first launch.
fn offered_profiles() -> Vec<AgentProfile> {
    agent_profiles(&BTreeMap::new())
}

fn find<'a>(profiles: &'a [AgentProfile], id: &str) -> &'a AgentProfile {
    profiles
        .iter()
        .find(|p| p.id == id)
        .unwrap_or_else(|| panic!("profile '{id}' must exist"))
}

#[test]
fn test_offered_profiles_contain_defaults() {
    let profiles = offered_profiles();

    // The default registry agents, from the bundle with no catalog installed.
    for id in ["claude-acp", "codex-acp", "qwen-code"] {
        find(&profiles, id);
    }
    for legacy in ["claude-code", "codex", "qwen", "omp", "aider"] {
        assert!(profiles.iter().all(|p| p.id != legacy), "{legacy}");
    }
}

#[test]
fn test_every_listed_profile_comes_from_the_registry() {
    let profiles = offered_profiles();

    assert!(!profiles.is_empty());
    assert!(profiles.iter().all(|p| p.source == "registry"));
}

#[test]
fn test_profile_ids_are_unique() {
    let profiles = offered_profiles();
    let mut ids: Vec<&str> = profiles.iter().map(|p| p.id.as_str()).collect();
    let unique = ids.len();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), unique, "profile ids must be unique");
}

#[test]
fn test_npx_registry_agents_are_pinned_to_exact_versions() {
    let profiles = offered_profiles();
    let npx: Vec<&AgentProfile> = profiles
        .iter()
        .filter(|p| p.distribution.as_deref() == Some("npx"))
        .collect();
    assert!(!npx.is_empty());

    for profile in npx {
        assert_eq!(profile.acp_args.first().map(String::as_str), Some("-y"));
        let package = &profile.acp_args[1];
        let version = package.rsplit('@').next().unwrap();
        assert_eq!(
            Some(version),
            profile.version.as_deref(),
            "{} must pin its registry version, got {}",
            profile.id,
            package
        );
    }
}

#[test]
fn test_registry_profiles_are_detected_exactly_when_ready_and_plan_otherwise() {
    let profiles = offered_profiles();
    let registry: Vec<&AgentProfile> = profiles.iter().filter(|p| p.source == "registry").collect();
    assert!(!registry.is_empty());

    for profile in registry {
        let ready = profile.availability == "ready";
        assert_eq!(profile.detected, ready, "{}", profile.id);
        assert_eq!(profile.install_plan.is_none(), ready, "{}", profile.id);
        if ready {
            assert!(profile.acp_program_path.is_some(), "{}", profile.id);
        }
    }
}

#[test]
fn test_agent_profile_matches_the_listed_profile_for_each_id() {
    let none = BTreeMap::new();
    for listed in offered_profiles() {
        assert_eq!(agent_profile(&listed.id, &none).as_ref(), Some(&listed));
    }
    assert_eq!(agent_profile("no-such-agent", &none), None);
}
