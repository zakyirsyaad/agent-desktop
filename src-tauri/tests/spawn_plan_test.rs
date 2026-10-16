use agent_desktop_lib::profiles::{AgentProfile, EffortLevel, PermissionModeOption};
use agent_desktop_lib::spawn_plan::{build_spawn_plan, SpawnOptions};

fn strs(values: &[&str]) -> Vec<String> {
    values.iter().map(|&s| s.to_string()).collect()
}

fn effort(label: &str, args: &[&str], env: &[(&str, &str)]) -> EffortLevel {
    EffortLevel {
        label: label.to_string(),
        args: strs(args),
        env: env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
    }
}

fn mode(id: &str, label: &str, args: &[&str]) -> PermissionModeOption {
    PermissionModeOption {
        id: id.to_string(),
        label: label.to_string(),
        args: strs(args),
    }
}

fn no_options() -> SpawnOptions {
    SpawnOptions {
        model: None,
        effort: None,
        permission_mode: None,
        agent_session_id: None,
        fork_from_agent_session_id: None,
    }
}

/// A profile that supports every capability `build_spawn_plan` can express.
fn full_profile() -> AgentProfile {
    AgentProfile::new("claude-code", "Claude Code", "claude")
        .with_models(&["opus", "sonnet"])
        .with_model_arg("--model")
        .with_effort_levels(vec![
            effort("Low", &["--effort", "low"], &[]),
            effort("High", &["--effort", "high"], &[("SOME_ENV", "1")]),
        ])
        .with_permission_modes(vec![
            mode("ask", "Ask", &[]),
            mode("bypass", "Bypass", &["--permission-mode", "bypassPermissions"]),
        ])
        .with_session_id_arg("--session-id")
        .with_native_fork(&["--resume", "{session_id}", "--fork-session"])
}

/// A profile with a real command but no optional capabilities at all.
fn bare_profile() -> AgentProfile {
    AgentProfile::new("generic", "Custom CLI", "/bin/echo")
}

const VALID_SESSION_ID: &str = "123e4567-e89b-12d3-a456-426614174000";

#[test]
fn plan_with_no_options_runs_profile_command_without_extra_args() {
    let plan = build_spawn_plan(&bare_profile(), &no_options()).expect("bare profile must plan");

    assert_eq!(plan.command, "/bin/echo");
    assert!(plan.args.is_empty(), "unexpected args: {:?}", plan.args);
    assert!(plan.env.is_empty(), "unexpected env: {:?}", plan.env);
}

#[test]
fn plan_prefers_detected_path_over_bare_command_name() {
    let mut profile = full_profile();
    profile.detected = true;
    profile.detected_path = Some("/opt/homebrew/bin/claude".to_string());

    let plan = build_spawn_plan(&profile, &no_options()).expect("detected profile must plan");

    assert_eq!(plan.command, "/opt/homebrew/bin/claude");
}

#[test]
fn plan_falls_back_to_command_when_detection_found_no_path() {
    let mut profile = full_profile();
    profile.detected = false;
    profile.detected_path = None;

    let plan = build_spawn_plan(&profile, &no_options()).expect("profile must plan");

    assert_eq!(plan.command, "claude");
}

#[test]
fn plan_places_listed_model_after_model_arg() {
    let options = SpawnOptions {
        model: Some("sonnet".to_string()),
        ..no_options()
    };

    let plan = build_spawn_plan(&full_profile(), &options).expect("listed model must be accepted");

    assert_eq!(plan.args, strs(&["--model", "sonnet"]));
}

#[test]
fn plan_rejects_model_not_listed_by_profile() {
    let options = SpawnOptions {
        model: Some("gpt-4o".to_string()),
        ..no_options()
    };

    let err = build_spawn_plan(&full_profile(), &options)
        .expect_err("an unlisted model must be rejected");

    assert!(
        err.contains("gpt-4o"),
        "error should name the rejected model: {err}"
    );
}

#[test]
fn plan_rejects_model_when_profile_has_no_model_arg() {
    let profile = AgentProfile::new("x", "X", "x").with_models(&["opus"]);
    let options = SpawnOptions {
        model: Some("opus".to_string()),
        ..no_options()
    };

    let err =
        build_spawn_plan(&profile, &options).expect_err("model without model_arg must be rejected");

    assert!(
        err.to_lowercase().contains("model"),
        "error should mention models: {err}"
    );
}

#[test]
fn plan_rejects_model_when_profile_lists_none() {
    let profile = AgentProfile::new("omp", "Oh-My-Pi", "omp").with_model_arg("--model");
    let options = SpawnOptions {
        model: Some("opus".to_string()),
        ..no_options()
    };

    let err = build_spawn_plan(&profile, &options)
        .expect_err("a profile with no verified models must reject every model");

    assert!(
        err.to_lowercase().contains("model"),
        "error should mention models: {err}"
    );
}

#[test]
fn plan_rejects_blank_model() {
    let options = SpawnOptions {
        model: Some("   ".to_string()),
        ..no_options()
    };

    let err = build_spawn_plan(&full_profile(), &options).expect_err("blank model must be rejected");

    assert!(!err.is_empty());
}

#[test]
fn plan_adds_effort_args_and_env() {
    let options = SpawnOptions {
        effort: Some("High".to_string()),
        ..no_options()
    };

    let plan = build_spawn_plan(&full_profile(), &options).expect("listed effort must be accepted");

    assert_eq!(plan.args, strs(&["--effort", "high"]));
    assert_eq!(plan.env, vec![("SOME_ENV".to_string(), "1".to_string())]);
}

#[test]
fn plan_rejects_effort_label_not_listed_by_profile() {
    let options = SpawnOptions {
        effort: Some("Medium".to_string()),
        ..no_options()
    };

    let err = build_spawn_plan(&full_profile(), &options)
        .expect_err("an unlisted effort label must be rejected");

    assert!(
        err.contains("Medium"),
        "error should name the rejected effort: {err}"
    );
}

#[test]
fn plan_rejects_effort_when_profile_has_no_effort_levels() {
    let profile = AgentProfile::new("aider", "Aider", "aider");
    let options = SpawnOptions {
        effort: Some("High".to_string()),
        ..no_options()
    };

    let err = build_spawn_plan(&profile, &options)
        .expect_err("effort without a real mechanism must be rejected");

    assert!(
        err.to_lowercase().contains("effort"),
        "error should mention effort: {err}"
    );
}

#[test]
fn ask_permission_mode_passes_no_extra_args() {
    let options = SpawnOptions {
        permission_mode: Some("ask".to_string()),
        ..no_options()
    };

    let plan = build_spawn_plan(&full_profile(), &options).expect("ask must be accepted");

    assert!(plan.args.is_empty(), "'ask' must be the CLI default: {:?}", plan.args);
}

#[test]
fn plan_adds_permission_mode_args() {
    let options = SpawnOptions {
        permission_mode: Some("bypass".to_string()),
        ..no_options()
    };

    let plan = build_spawn_plan(&full_profile(), &options).expect("listed mode must be accepted");

    assert_eq!(
        plan.args,
        strs(&["--permission-mode", "bypassPermissions"])
    );
}

#[test]
fn plan_rejects_permission_mode_not_listed_by_profile() {
    let options = SpawnOptions {
        permission_mode: Some("yolo".to_string()),
        ..no_options()
    };

    let err = build_spawn_plan(&full_profile(), &options)
        .expect_err("an unlisted permission mode must be rejected");

    assert!(
        err.contains("yolo"),
        "error should name the rejected mode: {err}"
    );
}

#[test]
fn plan_rejects_permission_mode_when_profile_has_no_modes() {
    let profile = AgentProfile::new("generic", "Custom CLI", "");
    let options = SpawnOptions {
        permission_mode: Some("ask".to_string()),
        ..no_options()
    };

    let err = build_spawn_plan(&profile, &options)
        .expect_err("permission mode without options must be rejected");

    assert!(
        err.to_lowercase().contains("permission"),
        "error should mention permission modes: {err}"
    );
}

#[test]
fn plan_adds_session_id_after_session_id_arg() {
    let options = SpawnOptions {
        agent_session_id: Some(VALID_SESSION_ID.to_string()),
        ..no_options()
    };

    let plan = build_spawn_plan(&full_profile(), &options).expect("session id must be accepted");

    assert_eq!(plan.args, strs(&["--session-id", VALID_SESSION_ID]));
}

#[test]
fn plan_rejects_session_id_when_profile_cannot_assign_one() {
    let profile = AgentProfile::new("omp", "Oh-My-Pi", "omp");
    let options = SpawnOptions {
        agent_session_id: Some(VALID_SESSION_ID.to_string()),
        ..no_options()
    };

    let err = build_spawn_plan(&profile, &options)
        .expect_err("agents without a session id flag must reject it");

    assert!(
        err.to_lowercase().contains("session"),
        "error should mention session id support: {err}"
    );
}

#[test]
fn plan_rejects_session_id_that_is_not_uuid_like() {
    let profile = full_profile();
    // One past the 64-char ceiling enforced by `validate_session_id`.
    let too_long = "a".repeat(65);

    for bad in [
        "abc",
        "not a uuid at all",
        "--dangerously-skip-permissions",
        "$(rm -rf /)",
        "a; rm -rf /",
        too_long.as_str(),
    ] {
        let options = SpawnOptions {
            agent_session_id: Some(bad.to_string()),
            ..no_options()
        };

        let err = build_spawn_plan(&profile, &options)
            .err()
            .unwrap_or_else(|| panic!("session id '{bad}' must be rejected"));
        assert!(
            err.to_lowercase().contains("session"),
            "error for '{bad}' should mention the session id: {err}"
        );
    }
}

#[test]
fn plan_rejects_blank_session_id() {
    let options = SpawnOptions {
        agent_session_id: Some("   ".to_string()),
        ..no_options()
    };

    let err = build_spawn_plan(&full_profile(), &options)
        .expect_err("a blank session id must be rejected");

    assert!(!err.is_empty(), "error must explain the rejection");
}

#[test]
fn plan_expands_resume_fork_template_for_native_fork_agents() {
    let options = SpawnOptions {
        fork_from_agent_session_id: Some(VALID_SESSION_ID.to_string()),
        ..no_options()
    };

    let plan = build_spawn_plan(&full_profile(), &options).expect("native fork must be accepted");

    assert_eq!(
        plan.args,
        strs(&["--resume", VALID_SESSION_ID, "--fork-session"])
    );
}

#[test]
fn plan_rejects_fork_for_handoff_agents() {
    let profile = AgentProfile::new("omp", "Oh-My-Pi", "omp")
        .with_session_id_arg("--session-id")
        .with_fork_support("handoff");
    let options = SpawnOptions {
        fork_from_agent_session_id: Some(VALID_SESSION_ID.to_string()),
        ..no_options()
    };

    let err = build_spawn_plan(&profile, &options)
        .expect_err("handoff agents cannot fork a session id");

    assert!(
        err.to_lowercase().contains("fork"),
        "error should mention forking: {err}"
    );
}

#[test]
fn plan_rejects_fork_when_native_support_has_no_template() {
    // A mis-declared profile must fail closed rather than spawn a bare resume.
    let profile = AgentProfile::new("x", "X", "x").with_fork_support("native");
    let options = SpawnOptions {
        fork_from_agent_session_id: Some(VALID_SESSION_ID.to_string()),
        ..no_options()
    };

    let err = build_spawn_plan(&profile, &options)
        .expect_err("native fork without a template must be rejected");

    assert!(
        err.to_lowercase().contains("fork"),
        "error should mention forking: {err}"
    );
}

#[test]
fn plan_rejects_non_uuid_fork_source_session_id() {
    let options = SpawnOptions {
        fork_from_agent_session_id: Some("not a uuid".to_string()),
        ..no_options()
    };

    let err = build_spawn_plan(&full_profile(), &options)
        .expect_err("a non-UUID fork source must be rejected");

    assert!(
        err.to_lowercase().contains("session"),
        "error should mention the session id: {err}"
    );
}

#[test]
fn plan_combines_every_option_in_a_deterministic_order() {
    let options = SpawnOptions {
        model: Some("opus".to_string()),
        effort: Some("High".to_string()),
        permission_mode: Some("bypass".to_string()),
        agent_session_id: Some(VALID_SESSION_ID.to_string()),
        fork_from_agent_session_id: None,
    };

    let plan = build_spawn_plan(&full_profile(), &options).expect("all options must be accepted");

    assert_eq!(
        plan.args,
        strs(&[
            "--model",
            "opus",
            "--effort",
            "high",
            "--permission-mode",
            "bypassPermissions",
            "--session-id",
            VALID_SESSION_ID,
        ])
    );
    assert_eq!(plan.env, vec![("SOME_ENV".to_string(), "1".to_string())]);
}

#[test]
fn plan_accumulates_env_from_every_selected_effort_level() {
    let profile = AgentProfile::new("x", "X", "x").with_effort_levels(vec![effort(
        "High",
        &["--think"],
        &[("A", "1"), ("B", "2")],
    )]);
    let options = SpawnOptions {
        effort: Some("High".to_string()),
        ..no_options()
    };

    let plan = build_spawn_plan(&profile, &options).expect("effort must be accepted");

    assert_eq!(
        plan.env,
        vec![("A".to_string(), "1".to_string()), ("B".to_string(), "2".to_string())]
    );
}

#[test]
fn options_deserialize_from_camel_case_json() {
    let json = serde_json::json!({
        "model": "sonnet",
        "effort": "High",
        "permissionMode": "bypass",
        "agentSessionId": VALID_SESSION_ID,
        "forkFromAgentSessionId": VALID_SESSION_ID,
    });

    let options: SpawnOptions =
        serde_json::from_value(json).expect("camelCase payload from JS must deserialize");

    assert_eq!(options.model.as_deref(), Some("sonnet"));
    assert_eq!(options.effort.as_deref(), Some("High"));
    assert_eq!(options.permission_mode.as_deref(), Some("bypass"));
    assert_eq!(options.agent_session_id.as_deref(), Some(VALID_SESSION_ID));
    assert_eq!(
        options.fork_from_agent_session_id.as_deref(),
        Some(VALID_SESSION_ID)
    );
}

#[test]
fn options_deserialize_when_every_field_is_absent() {
    let options: SpawnOptions =
        serde_json::from_value(serde_json::json!({})).expect("all fields must be optional");

    assert_eq!(options, no_options());
}
