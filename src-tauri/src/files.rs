//! Read-only browsing of a workspace folder for the Files panel.
//!
//! The webview sends a workspace root plus a path relative to it. The root must
//! be one of the user's workspaces as the app state records them, and every
//! path is canonicalized and must stay inside the canonical root, so `..`
//! segments and symlinks pointing elsewhere cannot list or open files outside
//! the workspace.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::store::AppStore;

#[cfg(target_os = "macos")]
use std::process::Command;

/// Most entries returned for one directory, after sorting.
pub const MAX_ENTRIES: usize = 2000;

/// One child of a listed directory, as the Files panel shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    /// Path from the workspace root, `/`-separated, without a leading slash.
    pub relative_path: String,
    pub is_dir: bool,
}

/// Canonicalizes `root`, which must be an absolute path to an existing directory.
pub fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(root);
    if !candidate.is_absolute() {
        return Err(format!("Workspace root {root:?} is not absolute"));
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("Workspace root {root:?} is not accessible: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("Workspace root {root:?} is not a directory"));
    }
    Ok(canonical)
}

/// Resolves `relative` under `root` and returns `(canonical_root, canonical_target)`.
///
/// Canonicalizing the target resolves `..` and every symlink along the way, so
/// the containment check below sees where the path really points.
pub fn resolve_inside_root(root: &str, relative: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = canonical_root(root)?;
    let target = root
        .join(relative)
        .canonicalize()
        .map_err(|e| format!("Path {relative:?} is not accessible: {e}"))?;
    if !target.starts_with(&root) {
        return Err(format!("Path {relative:?} is outside the workspace"));
    }
    Ok((root, target))
}

/// Lists one directory of the workspace: folders first, then files, by name.
pub fn list_entries(root: &str, relative: &str) -> Result<Vec<DirEntryInfo>, String> {
    let (root, dir) = resolve_inside_root(root, relative)?;
    if !dir.is_dir() {
        return Err(format!("Path {relative:?} is not a directory"));
    }
    let read_dir = std::fs::read_dir(&dir).map_err(|e| format!("Cannot read {relative:?}: {e}"))?;

    let mut entries: Vec<DirEntryInfo> = read_dir
        .filter_map(Result::ok)
        .map(|entry| describe_entry(&root, &dir, &entry))
        .collect();
    entries.sort_by(compare_entries);
    entries.truncate(MAX_ENTRIES);
    Ok(entries)
}

fn describe_entry(root: &Path, dir: &Path, entry: &std::fs::DirEntry) -> DirEntryInfo {
    let name = entry.file_name().to_string_lossy().into_owned();
    // `Path::is_dir` follows symlinks, so a linked folder still gets a chevron;
    // expanding one that points outside the root is rejected by the listing.
    let is_dir = entry.path().is_dir();
    let relative_dir = dir.strip_prefix(root).unwrap_or(Path::new(""));
    DirEntryInfo {
        relative_path: to_slash_path(&relative_dir.join(&name)),
        name,
        is_dir,
    }
}

fn to_slash_path(path: &Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn compare_entries(a: &DirEntryInfo, b: &DirEntryInfo) -> std::cmp::Ordering {
    b.is_dir
        .cmp(&a.is_dir)
        .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        .then_with(|| a.name.cmp(&b.name))
}

/// Accepts `root` only when it is one of the user's workspaces (compared
/// canonically), so a caller cannot widen the browsable area to any folder.
pub fn ensure_known_workspace(
    root: &str,
    is_known: impl FnOnce(&Path) -> Result<bool, String>,
) -> Result<(), String> {
    let root = canonical_root(root)?;
    if is_known(&root)? {
        Ok(())
    } else {
        Err(format!("{} is not one of your workspaces", root.display()))
    }
}

/// Records a folder the user just opened as a workspace. Synchronous on
/// purpose: it runs before any async listing the webview sends after it.
#[tauri::command]
pub fn remember_workspace(store: State<'_, AppStore>, path: String) -> Result<(), String> {
    store.remember_workspace(&path)
}

/// Lists the children of `relative` inside the workspace `root`.
#[tauri::command(async)]
pub fn list_directory(
    store: State<'_, AppStore>,
    root: String,
    relative: String,
) -> Result<Vec<DirEntryInfo>, String> {
    ensure_known_workspace(&root, |r| store.is_known_workspace(r))?;
    list_entries(&root, &relative)
}

/// Opens a workspace file with its default application.
#[tauri::command(async)]
pub fn open_path(store: State<'_, AppStore>, root: String, relative: String) -> Result<(), String> {
    ensure_known_workspace(&root, |r| store.is_known_workspace(r))?;
    let (_, target) = resolve_inside_root(&root, &relative)?;
    open_with_default_app(&target)
}

#[cfg(target_os = "macos")]
fn open_with_default_app(path: &Path) -> Result<(), String> {
    let status = Command::new("open")
        .arg(path)
        .status()
        .map_err(|e| format!("Failed to run `open {}`: {}", path.display(), e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("`open {}` exited with {status}", path.display()))
    }
}

#[cfg(not(target_os = "macos"))]
fn open_with_default_app(_path: &Path) -> Result<(), String> {
    Err("not supported".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A temp workspace removed when the test ends, even on panic.
    struct TempWorkspace {
        path: PathBuf,
    }

    impl TempWorkspace {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock is before the unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "agent-desktop-files-{}-{}-{}",
                tag,
                std::process::id(),
                nanos
            ));
            fs::create_dir_all(&path).expect("create temp workspace");
            Self { path }
        }

        fn root(&self) -> &str {
            self.path.to_str().expect("utf-8 temp path")
        }

        fn mkdir(&self, relative: &str) {
            fs::create_dir_all(self.path.join(relative)).expect("create dir");
        }

        fn touch(&self, relative: &str) {
            fs::write(self.path.join(relative), b"").expect("create file");
        }
    }

    impl Drop for TempWorkspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn names(entries: &[DirEntryInfo]) -> Vec<&str> {
        entries.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn lists_folders_first_then_files_alphabetically_including_hidden_entries() {
        let ws = TempWorkspace::new("order");
        ws.mkdir("src");
        ws.mkdir(".claude");
        ws.mkdir("Docs");
        ws.touch("zeta.txt");
        ws.touch("README.md");
        ws.touch(".gitignore");
        ws.touch("alpha.rs");

        let entries = list_entries(ws.root(), "").expect("list root");

        assert_eq!(
            names(&entries),
            vec![
                ".claude",
                "Docs",
                "src",
                ".gitignore",
                "alpha.rs",
                "README.md",
                "zeta.txt"
            ]
        );
        assert!(entries[..3].iter().all(|e| e.is_dir));
        assert!(entries[3..].iter().all(|e| !e.is_dir));
    }

    #[test]
    fn reports_paths_relative_to_the_root_for_nested_folders() {
        let ws = TempWorkspace::new("nested");
        ws.mkdir("src/components");
        ws.touch("src/main.ts");

        let entries = list_entries(ws.root(), "src").expect("list src");

        assert_eq!(
            entries,
            vec![
                DirEntryInfo {
                    name: "components".to_string(),
                    relative_path: "src/components".to_string(),
                    is_dir: true,
                },
                DirEntryInfo {
                    name: "main.ts".to_string(),
                    relative_path: "src/main.ts".to_string(),
                    is_dir: false,
                },
            ]
        );
    }

    #[test]
    fn caps_a_directory_at_max_entries_after_sorting() {
        let ws = TempWorkspace::new("cap");
        for index in 0..=MAX_ENTRIES {
            ws.touch(&format!("file-{index:05}.txt"));
        }
        ws.mkdir("zz-folder");

        let entries = list_entries(ws.root(), "").expect("list root");

        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(entries[0].name, "zz-folder", "folders sort before the cap");
    }

    #[test]
    fn rejects_a_relative_path_that_climbs_out_of_the_root() {
        let ws = TempWorkspace::new("dotdot");
        ws.mkdir("inner");

        let err = list_entries(&format!("{}/inner", ws.root()), "..").expect_err("must reject");

        assert!(err.contains("outside"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_an_absolute_relative_path_outside_the_root() {
        let ws = TempWorkspace::new("absolute");

        assert!(list_entries(ws.root(), "/").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlink_that_points_outside_the_root() {
        let ws = TempWorkspace::new("symlink");
        let outside = TempWorkspace::new("symlink-target");
        outside.touch("secret.txt");
        std::os::unix::fs::symlink(&outside.path, ws.path.join("escape")).expect("create symlink");

        let err = list_entries(ws.root(), "escape").expect_err("must reject");
        assert!(err.contains("outside"), "unexpected error: {err}");

        let err = resolve_inside_root(ws.root(), "escape/secret.txt").expect_err("must reject");
        assert!(err.contains("outside"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_a_missing_root() {
        let ws = TempWorkspace::new("missing");
        let missing = ws.path.join("no-such-folder");

        assert!(list_entries(missing.to_str().expect("utf-8"), "").is_err());
    }

    #[test]
    fn accepts_only_a_root_that_is_a_known_workspace() {
        let ws = TempWorkspace::new("known");
        ws.mkdir("inner");
        let known = canonical_root(ws.root()).expect("canonical root");
        let is_known = |r: &Path| Ok(r == known);

        assert!(ensure_known_workspace(ws.root(), is_known).is_ok());
        // Another spelling of the same folder is the same workspace.
        assert!(ensure_known_workspace(&format!("{}/inner/..", ws.root()), is_known).is_ok());
        let err = ensure_known_workspace("/", is_known).expect_err("must reject");
        assert!(
            err.contains("not one of your workspaces"),
            "unexpected error: {err}"
        );
        assert!(ensure_known_workspace(&format!("{}/inner", ws.root()), is_known).is_err());
    }

    #[test]
    fn rejects_a_relative_root() {
        assert!(canonical_root("relative/folder").is_err());
        assert!(canonical_root("").is_err());
    }

    #[test]
    fn rejects_a_root_that_is_a_file() {
        let ws = TempWorkspace::new("file-root");
        ws.touch("file.txt");

        assert!(canonical_root(ws.path.join("file.txt").to_str().expect("utf-8")).is_err());
    }

    #[test]
    fn resolves_a_file_inside_the_root() {
        let ws = TempWorkspace::new("resolve");
        ws.mkdir("src");
        ws.touch("src/lib.rs");

        let (root, target) = resolve_inside_root(ws.root(), "src/lib.rs").expect("inside root");

        assert_eq!(target, root.join("src").join("lib.rs"));
    }

    #[test]
    fn serializes_entries_in_camel_case() {
        let entry = DirEntryInfo {
            name: "a".to_string(),
            relative_path: "dir/a".to_string(),
            is_dir: false,
        };

        let json = serde_json::to_value(&entry).expect("serialize");

        assert_eq!(
            json,
            serde_json::json!({ "name": "a", "relativePath": "dir/a", "isDir": false })
        );
    }
}
