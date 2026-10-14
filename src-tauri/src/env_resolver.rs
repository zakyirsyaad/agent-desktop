use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// Resolves the user's authentic login shell environment variables.
///
/// On macOS and Unix systems, GUI applications launched from Finder / Dock do not
/// inherit the user's login shell `$PATH` and environment (such as Homebrew, Cargo, NVM, etc.).
/// This function launches the user's login shell with `$SHELL -l -c "env"` to read the authentic
/// environment map.
pub fn resolve_user_env() -> Result<HashMap<String, String>, String> {
    #[cfg(unix)]
    {
        let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

        let output = Command::new(&shell)
            .args(["-l", "-c", "env"])
            .output()
            .map_err(|e| format!("Failed to execute login shell {}: {}", shell, e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "Login shell exited with status {}: {}",
                output.status, stderr
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut map = HashMap::new();

        for line in stdout.lines() {
            if let Some((k, v)) = line.split_once('=') {
                if !k.is_empty() {
                    map.insert(k.to_string(), v.to_string());
                }
            }
        }

        Ok(map)
    }

    #[cfg(not(unix))]
    {
        Ok(env::vars().collect())
    }
}

/// Checks whether a given path is an executable file.
fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        if let Ok(metadata) = path.metadata() {
            let permissions = metadata.permissions();
            // Check if executable by owner, group, or others
            return permissions.mode() & 0o111 != 0;
        }
        false
    }

    #[cfg(not(unix))]
    {
        true
    }
}

/// Finds a binary inside a given PATH string.
pub fn find_binary_in_path_str(binary_name: &str, path_var: &str) -> Option<PathBuf> {
    for dir in path_var.split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = PathBuf::from(dir).join(binary_name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Finds a binary in the resolved user PATH.
///
/// Falls back to the current process PATH if resolving the user shell environment fails.
pub fn find_binary_in_user_path(binary_name: &str) -> Option<PathBuf> {
    let path_var = match resolve_user_env() {
        Ok(env_map) => env_map.get("PATH").cloned(),
        Err(_) => None,
    }
    .or_else(|| env::var("PATH").ok())?;

    find_binary_in_path_str(binary_name, &path_var)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_executable() {
        let sh = PathBuf::from("/bin/sh");
        assert!(is_executable(&sh));

        let nonexistent = PathBuf::from("/nonexistent/file/path");
        assert!(!is_executable(&nonexistent));
    }
}
