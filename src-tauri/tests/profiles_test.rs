use agent_desktop_lib::profiles::get_available_agent_profiles;

#[test]
fn test_get_available_agent_profiles_contains_defaults() {
    let profiles = get_available_agent_profiles();

    // Must return at least claude-code, omp, aider, and generic
    assert!(profiles.len() >= 4);

    let claude = profiles.iter().find(|p| p.id == "claude-code");
    assert!(claude.is_some(), "claude-code profile must exist");
    let claude = claude.unwrap();
    assert_eq!(claude.name, "Claude Code");
    assert_eq!(claude.command, "claude");
    assert_eq!(claude.model_arg, Some("--model".to_string()));
    assert_eq!(claude.effort_env, Some("MAX_THINKING_TOKENS".to_string()));
    assert!(claude.models.contains(&"claude-opus-5-5".to_string()));
    assert!(claude.models.contains(&"claude-sonnet-5-5".to_string()));
    assert!(claude.models.contains(&"claude-haiku-4-5".to_string()));
    assert_eq!(claude.effort_levels, vec!["Low", "Medium", "High"]);
    assert_eq!(claude.approval_key, Some("y\n".to_string()));
    assert_eq!(claude.reject_key, Some("n\n".to_string()));

    let omp = profiles.iter().find(|p| p.id == "omp");
    assert!(omp.is_some(), "omp profile must exist");
    let omp = omp.unwrap();
    assert_eq!(omp.name, "Oh-My-Pi");
    assert_eq!(omp.command, "omp");
    assert!(omp.models.contains(&"gemini-3.8-flash-tiered".to_string()));
    assert!(omp.models.contains(&"gemini-3.8-pro".to_string()));
    assert_eq!(omp.approval_key, Some("y\n".to_string()));
    assert_eq!(omp.reject_key, Some("n\n".to_string()));

    let aider = profiles.iter().find(|p| p.id == "aider");
    assert!(aider.is_some(), "aider profile must exist");
    let aider = aider.unwrap();
    assert_eq!(aider.name, "Aider");
    assert_eq!(aider.command, "aider");
    assert!(aider.models.contains(&"claude-3-7-sonnet".to_string()));
    assert!(aider.models.contains(&"gpt-4o".to_string()));
    assert!(aider.models.contains(&"deepseek-r1".to_string()));

    let generic = profiles.iter().find(|p| p.id == "generic");
    assert!(generic.is_some(), "generic profile must exist");
    let generic = generic.unwrap();
    assert_eq!(generic.name, "Custom CLI");
    assert_eq!(generic.command, "");
    assert_eq!(generic.detected, false);
    assert_eq!(generic.detected_path, None);
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
