use agent_desktop_lib::profiles::{
    get_available_agent_profiles, get_default_profiles, AgentProfile,
};

fn find<'a>(profiles: &'a [AgentProfile], id: &str) -> &'a AgentProfile {
    profiles
        .iter()
        .find(|p| p.id == id)
        .unwrap_or_else(|| panic!("profile '{id}' must exist"))
}

#[test]
fn test_get_available_agent_profiles_contains_defaults() {
    let profiles = get_available_agent_profiles();

    // Every agent this app knows how to drive.
    assert!(profiles.len() >= 4);
    for id in ["claude-code", "qwen", "codex", "omp", "aider"] {
        find(&profiles, id);
    }
}

#[test]
fn test_profile_ids_are_unique() {
    let profiles = get_default_profiles();
    let mut ids: Vec<&str> = profiles.iter().map(|p| p.id.as_str()).collect();
    let unique = ids.len();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), unique, "profile ids must be unique");
}

#[test]
fn test_claude_code_profile_matches_its_real_cli_flags() {
    let profiles = get_default_profiles();
    let claude = find(&profiles, "claude-code");

    assert_eq!(claude.name, "Claude Code");
    assert_eq!(claude.command, "claude");

    // `--model <model>`: "Provide an alias for the latest model (e.g. 'fable',
    // 'opus', or 'sonnet')". Aliases, not versioned ids that go stale.
    assert_eq!(claude.model_arg, Some("--model".to_string()));
    assert!(
        claude.models.contains(&"opus".to_string()),
        "{:?}",
        claude.models
    );
    assert!(
        claude.models.contains(&"sonnet".to_string()),
        "{:?}",
        claude.models
    );

    // `--effort <level>`: "(low, medium, high, xhigh, max)".
    assert!(
        !claude.effort_levels.is_empty(),
        "claude exposes a real --effort flag"
    );
    for level in &claude.effort_levels {
        assert_eq!(
            level.args.first().map(String::as_str),
            Some("--effort"),
            "level {:?} must map to the real --effort flag",
            level.label
        );
        assert_eq!(
            level.args.len(),
            2,
            "level {:?} must pass exactly one value",
            level.label
        );
        assert!(
            ["low", "medium", "high", "xhigh", "max"].contains(&level.args[1].as_str()),
            "'{}' is not a documented --effort value",
            level.args[1]
        );
        assert!(
            level.env.is_empty(),
            "claude effort is a flag, it must not fake an env var: {:?}",
            level.env
        );
    }

    // `--session-id <uuid>`, `-r, --resume [value]`, `--fork-session`.
    assert_eq!(claude.session_id_arg, Some("--session-id".to_string()));
    assert_eq!(claude.fork_support, "native");
    assert_eq!(
        claude.resume_fork_args,
        vec![
            "--resume".to_string(),
            "{session_id}".to_string(),
            "--fork-session".to_string()
        ]
    );

    assert_eq!(claude.approval_key, Some("y\n".to_string()));
    assert_eq!(claude.reject_key, Some("n\n".to_string()));
}

#[test]
fn test_claude_code_ask_permission_mode_is_first_and_passes_no_args() {
    let profiles = get_default_profiles();
    let claude = find(&profiles, "claude-code");

    let ask = claude
        .permission_modes
        .first()
        .expect("claude must offer permission modes");
    assert_eq!(ask.id, "ask");
    assert!(
        ask.args.is_empty(),
        "'ask' is the agent default and must add no args, got {:?}",
        ask.args
    );

    // `--permission-mode <mode>` with choices acceptEdits/auto/bypassPermissions/
    // manual/dontAsk/plan. Only modes with documented semantics are surfaced.
    let ids: Vec<&str> = claude
        .permission_modes
        .iter()
        .map(|m| m.id.as_str())
        .collect();
    assert!(ids.contains(&"bypass"), "{ids:?}");
    let bypass = claude
        .permission_modes
        .iter()
        .find(|m| m.id == "bypass")
        .unwrap();
    assert_eq!(
        bypass.args,
        vec![
            "--permission-mode".to_string(),
            "bypassPermissions".to_string()
        ]
    );

    for mode in &claude.permission_modes {
        if mode.id == "ask" {
            continue;
        }
        assert_eq!(
            mode.args.first().map(String::as_str),
            Some("--permission-mode"),
            "mode {:?} must use the real flag",
            mode.id
        );
    }
}

#[test]
fn test_omp_profile_matches_its_real_cli_flags() {
    let profiles = get_default_profiles();
    let omp = find(&profiles, "omp");

    assert_eq!(omp.name, "Oh-My-Pi");
    assert_eq!(omp.command, "omp");

    // `--model=<value>` exists, but omp resolves it by fuzzy match against the
    // providers this machine is authenticated with (`omp models`), so no static
    // alias list is truthful. Empty means "no picker", not "no flag".
    assert_eq!(omp.model_arg, Some("--model".to_string()));
    assert!(
        omp.models.is_empty(),
        "omp's catalogue is credential-dependent and must not be guessed: {:?}",
        omp.models
    );

    // `--thinking=<value>`: "off, minimal, low, medium, high, xhigh, max, auto".
    assert!(!omp.effort_levels.is_empty());
    for level in &omp.effort_levels {
        assert!(
            level.args.iter().any(|a| a.starts_with("--thinking=")),
            "level {:?} must map to the real --thinking flag",
            level.label
        );
        assert!(
            level.env.is_empty(),
            "omp thinking is a flag, it must not fake an env var: {:?}",
            level.env
        );
    }

    // `--approval-mode=<value>`: "(always-ask|write|yolo)".
    let ask = omp.permission_modes.first().expect("omp must offer modes");
    assert_eq!(ask.id, "ask");
    assert!(
        ask.args.is_empty(),
        "'ask' must be omp's default: {:?}",
        ask.args
    );
    let bypass = omp
        .permission_modes
        .iter()
        .find(|m| m.id == "bypass")
        .expect("omp must map the generic bypass id");
    assert_eq!(bypass.args, vec!["--approval-mode=yolo".to_string()]);

    // omp has `-r, --resume=<value>` but no way to assign a session id at start
    // and no fork flag, so it cannot fork a session id we chose.
    assert_eq!(omp.session_id_arg, None);
    assert_eq!(omp.fork_support, "handoff");
    assert!(omp.resume_fork_args.is_empty());

    assert_eq!(omp.approval_key, Some("y\n".to_string()));
    assert_eq!(omp.reject_key, Some("n\n".to_string()));
}

#[test]
fn test_aider_profile_does_not_claim_unverified_capabilities() {
    let profiles = get_default_profiles();
    let aider = find(&profiles, "aider");

    assert_eq!(aider.name, "Aider");
    assert_eq!(aider.command, "aider");

    // aider is not installed on the reference machine; only long-documented
    // flags are claimed, and no model list is invented.
    assert_eq!(aider.model_arg, Some("--model".to_string()));
    assert!(aider.models.is_empty(), "{:?}", aider.models);
    assert!(
        aider.effort_levels.is_empty(),
        "no verified aider effort/thinking flag: {:?}",
        aider.effort_levels
    );
    assert_eq!(aider.session_id_arg, None);
    assert_eq!(aider.fork_support, "handoff");
    assert!(aider.resume_fork_args.is_empty());

    let ask = aider
        .permission_modes
        .first()
        .expect("aider must offer modes");
    assert_eq!(ask.id, "ask");
    assert!(ask.args.is_empty());
    let bypass = aider
        .permission_modes
        .iter()
        .find(|m| m.id == "bypass")
        .expect("aider must map the generic bypass id");
    assert_eq!(bypass.args, vec!["--yes-always".to_string()]);
}

#[test]
fn test_no_profile_lists_an_effort_level_without_a_real_mechanism() {
    for profile in get_default_profiles() {
        for level in &profile.effort_levels {
            assert!(
                !level.args.is_empty() || !level.env.is_empty(),
                "{} effort level '{}' carries neither args nor env, so it cannot do anything",
                profile.id,
                level.label
            );
            assert!(
                !level.label.trim().is_empty(),
                "{} has an effort level with a blank label",
                profile.id
            );
        }

        let mut labels: Vec<&str> = profile
            .effort_levels
            .iter()
            .map(|l| l.label.as_str())
            .collect();
        let count = labels.len();
        labels.sort_unstable();
        labels.dedup();
        assert_eq!(
            labels.len(),
            count,
            "{} repeats an effort label",
            profile.id
        );
    }
}

#[test]
fn test_no_profile_reintroduces_the_max_thinking_tokens_env_hack() {
    // MAX_THINKING_TOKENS expects a token count, not "Low"/"Medium"/"High".
    for profile in get_default_profiles() {
        for level in &profile.effort_levels {
            for (key, value) in &level.env {
                assert_ne!(
                    key, "MAX_THINKING_TOKENS",
                    "{} effort '{}' must not map a label onto MAX_THINKING_TOKENS",
                    profile.id, level.label
                );
                assert!(
                    !value.trim().is_empty(),
                    "{} effort '{}' sets an empty {key}",
                    profile.id,
                    level.label
                );
            }
        }
    }
}

#[test]
fn test_every_profile_that_offers_permission_modes_defaults_to_ask_first() {
    for profile in get_default_profiles() {
        if profile.permission_modes.is_empty() {
            continue;
        }

        let first = &profile.permission_modes[0];
        assert_eq!(first.id, "ask", "{} must list 'ask' first", profile.id);
        assert!(
            first.args.is_empty(),
            "{} 'ask' must pass no extra args, got {:?}",
            profile.id,
            first.args
        );
        assert!(
            !first.label.trim().is_empty(),
            "{} 'ask' needs a label",
            profile.id
        );

        let mut ids: Vec<&str> = profile
            .permission_modes
            .iter()
            .map(|m| m.id.as_str())
            .collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(
            ids.len(),
            count,
            "{} repeats a permission mode id",
            profile.id
        );
    }
}

#[test]
fn test_fork_support_is_declared_honestly() {
    for profile in get_default_profiles() {
        assert!(
            profile.fork_support == "native" || profile.fork_support == "handoff",
            "{} has an unknown fork_support value: {:?}",
            profile.id,
            profile.fork_support
        );

        if profile.fork_support == "native" {
            assert!(
                !profile.resume_fork_args.is_empty(),
                "{} claims native fork but supplies no resume/fork template",
                profile.id
            );
            assert!(
                profile
                    .resume_fork_args
                    .iter()
                    .any(|a| a.contains("{session_id}")),
                "{} native fork template must expand {{session_id}}: {:?}",
                profile.id,
                profile.resume_fork_args
            );
        } else {
            assert!(
                profile.resume_fork_args.is_empty(),
                "{} claims handoff fork but supplies a template: {:?}",
                profile.id,
                profile.resume_fork_args
            );
        }
    }
}

#[test]
fn test_detection_flags_match_system_binaries() {
    let profiles = get_available_agent_profiles();

    for profile in profiles {
        if profile.command.is_empty() {
            assert!(!profile.detected);
            assert!(profile.detected_path.is_none());
        } else {
            let found = agent_desktop_lib::env_resolver::find_binary_in_user_path(&profile.command);
            match found {
                Some(path) => {
                    assert!(
                        profile.detected,
                        "Profile {} should be detected",
                        profile.id
                    );
                    assert_eq!(
                        profile.detected_path,
                        Some(path.to_string_lossy().to_string()),
                        "Profile {} detected_path mismatch",
                        profile.id
                    );
                }
                None => {
                    assert!(
                        !profile.detected,
                        "Profile {} should not be detected",
                        profile.id
                    );
                    assert!(profile.detected_path.is_none());
                }
            }
        }
    }
}

#[test]
fn test_there_is_no_unconfigurable_custom_cli_profile() {
    let profiles = get_default_profiles();

    assert!(profiles
        .iter()
        .all(|p| p.id != "generic" && !p.command.is_empty()));
}

#[test]
fn test_acp_agents_are_driven_over_acp_with_pinned_adapters() {
    let profiles = get_default_profiles();

    let qwen = find(&profiles, "qwen");
    assert_eq!(qwen.name, "Qwen Code");
    assert_eq!(qwen.command, "qwen");
    assert_eq!(qwen.transport, "acp");
    assert_eq!(qwen.acp_program.as_deref(), Some("qwen"));
    assert_eq!(qwen.acp_args, vec!["--acp".to_string()]);

    let claude = find(&profiles, "claude-code");
    assert_eq!(claude.transport, "acp");
    assert_eq!(claude.acp_program.as_deref(), Some("npx"));
    assert!(claude
        .acp_args
        .contains(&"@agentclientprotocol/claude-agent-acp@0.85.1".to_string()));

    let codex = find(&profiles, "codex");
    assert_eq!(codex.command, "codex");
    assert_eq!(codex.transport, "acp");
    assert!(codex
        .acp_args
        .contains(&"@agentclientprotocol/codex-acp@2.1.1".to_string()));
}

#[test]
fn test_npx_adapters_are_pinned_to_exact_versions() {
    for profile in get_default_profiles()
        .iter()
        .filter(|p| p.acp_program.as_deref() == Some("npx"))
    {
        let package = profile
            .acp_args
            .iter()
            .find(|a| a.starts_with('@'))
            .expect("an npx adapter package");
        let version = package.rsplit('@').next().unwrap();
        assert!(
            version.chars().all(|c| c.is_ascii_digit() || c == '.'),
            "{} must pin an exact version, got {}",
            profile.id,
            package
        );
    }
}

#[test]
fn test_agents_without_acp_stay_on_the_terminal() {
    let profiles = get_default_profiles();

    for id in ["omp", "aider"] {
        let profile = find(&profiles, id);
        assert_eq!(profile.transport, "pty", "{id}");
        assert_eq!(profile.acp_program, None, "{id}");
    }
}
