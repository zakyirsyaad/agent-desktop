use agent_desktop_lib::env_resolver::{find_binary_in_user_path, resolve_user_env};
use std::path::PathBuf;

#[test]
fn test_resolve_user_env_contains_essential_paths() {
    let env_vars = resolve_user_env().expect("Failed to resolve user shell environment");

    // Must resolve PATH
    assert!(
        env_vars.contains_key("PATH"),
        "Environment must contain PATH variable"
    );

    let path_val = env_vars.get("PATH").unwrap();
    // In macOS, /usr/bin is essential
    assert!(
        path_val.contains("/usr/bin"),
        "PATH should contain /usr/bin, got: {}",
        path_val
    );

    // If running on an Apple Silicon machine where homebrew exists, check opt homebrew
    if std::path::Path::new("/opt/homebrew/bin").exists() {
        assert!(
            path_val.contains("/opt/homebrew/bin"),
            "PATH should contain /opt/homebrew/bin on Apple Silicon Mac when it exists"
        );
    }
}

#[test]
fn test_find_binary_in_user_path_sh() {
    let sh_path = find_binary_in_user_path("sh");
    assert!(sh_path.is_some(), "Should find 'sh' binary in user PATH");

    let sh_path = sh_path.unwrap();
    assert!(sh_path.is_file(), "'sh' should be a file");
    assert_eq!(
        sh_path,
        PathBuf::from("/bin/sh"),
        "Expected /bin/sh on macOS/Unix"
    );
}

#[test]
fn test_find_binary_in_user_path_nonexistent() {
    let nonexistent = find_binary_in_user_path("non_existent_binary_xyz_12345");
    assert!(
        nonexistent.is_none(),
        "Should return None for nonexistent binary"
    );
}
