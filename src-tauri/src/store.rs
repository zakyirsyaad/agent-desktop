//! On-disk persistence for settings, recent folders, sessions, and transcripts.
//!
//! [`AppStore`] is the single place that knows where state lives and how it is
//! laid out; the rest of the app only ever sees the typed values. Writes go
//! through a temporary file and a rename so an interrupted write cannot leave a
//! half-written `state.json` behind to break the next launch.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Deserializer, Serialize};

/// The schema version written to `state.json`, bumped when the shape changes.
pub const STATE_VERSION: u32 = 1;

/// The state file inside the store root.
pub(crate) const STATE_FILE: &str = "state.json";

/// The scratch file a state write is staged in before it replaces [`STATE_FILE`].
pub(crate) const STATE_TMP_FILE: &str = "state.json.tmp";

/// The directory holding one JSON file of chat messages per session.
const TRANSCRIPTS_DIR: &str = "transcripts";

/// The directory session worktrees are made in.
pub(crate) const WORKTREES_DIR: &str = "worktrees";

/// The status every session is normalized to on load: no agent process
/// survives an app restart, so anything recorded as live is stale.
const STATUS_TERMINATED: &str = "terminated";

/// Longest accepted session id, in characters.
const MAX_SESSION_ID_LEN: usize = 64;

/// Everything the app restores on launch.
///
/// Missing sections default so a file written by an older build still loads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PersistedState {
    /// Schema version of the file, [`STATE_VERSION`] for anything this build writes.
    pub version: u32,
    /// User preferences that outlive a single session.
    pub settings: Settings,
    /// Folders the user opened recently, most significant to the UI first.
    pub recent_folders: Vec<RecentFolder>,
    /// Every session the UI has created, newest last.
    pub sessions: Vec<SessionRecord>,
    /// The modes and config options each ACP agent reported last, by profile
    /// id, so the composer can offer them before a session starts. Opaque to
    /// the backend.
    pub agent_options: serde_json::Map<String, serde_json::Value>,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            settings: Settings::default(),
            recent_folders: Vec::new(),
            sessions: Vec::new(),
            agent_options: serde_json::Map::new(),
        }
    }
}

/// User preferences restored across launches.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// The agent profile the UI preselects, or `None` to let the user choose.
    pub default_agent_id: Option<String>,
    /// Whether the first-run walkthrough has been completed.
    pub onboarding_completed: bool,
    /// `system`, `light` or `dark`; anything else follows the system.
    pub appearance: String,
    /// The agent ids the user uses, or `None` when the list was never set.
    pub enabled_agents: Option<Vec<String>>,
    /// Agent ids the user removed, which are never enabled again automatically.
    pub removed_agents: Vec<String>,
    /// The registry version in use for each agent id.
    pub agent_versions: BTreeMap<String, String>,
}

/// A folder the user opened an agent in.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RecentFolder {
    /// Display name, normally the folder's basename.
    pub name: String,
    /// Absolute path the agent was spawned in.
    pub path: String,
    /// When the folder was last opened, in unix milliseconds.
    pub last_opened_at: i64,
}

/// One agent session as the UI remembers it after a restart.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionRecord {
    /// Session id, also the transcript file name.
    pub id: String,
    /// Title shown in the session list.
    pub name: String,
    /// The agent profile this session was spawned from.
    pub profile_id: String,
    /// Absolute working directory the agent ran in.
    pub cwd: String,
    /// One of `running`, `idle`, `waiting_approval`, or `terminated`.
    pub status: String,
    /// Creation time in unix milliseconds.
    pub created_at: i64,
    /// When the session ended in unix milliseconds, if it ever did.
    pub ended_at: Option<i64>,
    /// The agent's exit code, if the process exited.
    pub exit_code: Option<i64>,
    /// The model the session was configured with.
    pub model: Option<String>,
    /// The reasoning effort level, when the agent supports one.
    pub effort: Option<String>,
    /// The permission mode the session ran under.
    pub permission_mode: Option<String>,
    /// The session this one was forked from, if any.
    pub forked_from: Option<String>,
    /// The agent's own session identifier, when it reported one.
    pub agent_session_id: Option<String>,
    /// How the app talks to the agent: `acp` or `pty`. Missing on sessions
    /// saved before ACP existed, which ran in a terminal.
    pub transport: Option<String>,
    /// The session id the agent assigned over ACP.
    pub acp_session_id: Option<String>,
    /// The git worktree the session runs in, when it was given one.
    #[serde(deserialize_with = "lenient_worktree")]
    pub worktree: Option<SessionWorktreeRecord>,
    /// Shown in the sidebar's Pinned section.
    #[serde(deserialize_with = "lenient_bool")]
    pub pinned: bool,
    /// When the session was archived: hidden from the session list until unarchived.
    #[serde(deserialize_with = "lenient_time")]
    pub archived_at: Option<i64>,
    /// The user renamed the session, so the agent's own titles no longer replace its name.
    #[serde(deserialize_with = "lenient_bool")]
    pub named_by_user: bool,
    /// The agent finished while the user was looking at another session.
    #[serde(deserialize_with = "lenient_bool")]
    pub has_unread: bool,
}

/// A session's worktree: the workspace it was made from, its root and branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWorktreeRecord {
    pub repo_path: String,
    pub path: String,
    pub branch: String,
}

/// A repository over the app's state directory.
///
/// Constructed once during setup and shared with the commands through Tauri's
/// managed state; every method is `&self` so concurrent commands are fine.
pub struct AppStore {
    root: PathBuf,
    /// Canonical workspace folders (recent folders and session folders),
    /// loaded on first use and kept current by `save_state` and
    /// `remember_workspace`, so the Files panel never re-reads the state file.
    known_workspaces: Mutex<Option<HashSet<PathBuf>>>,
    /// The worktrees folder of the pre-rename data dir, whose worktrees saved
    /// sessions still use in place and may need to remove.
    legacy_worktrees_root: Option<PathBuf>,
}

/// A saved worktree, or none when it is malformed: a bad entry must not make
/// the whole state file unreadable, which would lose every saved session.
fn lenient_worktree<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<SessionWorktreeRecord>, D::Error> {
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| serde_json::from_value(value).ok()))
}

/// A flag, or false when it is not a boolean; like a bad worktree, a bad
/// flag must not make the whole state file unreadable.
fn lenient_bool<'de, D: Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    Ok(serde_json::Value::deserialize(deserializer)?
        .as_bool()
        .unwrap_or(false))
}

/// A time in unix milliseconds, or none when it is not a whole number.
fn lenient_time<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<i64>, D::Error> {
    Ok(serde_json::Value::deserialize(deserializer)?.as_i64())
}

/// The canonical folders a state refers to, deduplicated: recent folders,
/// session folders, and the folders saved worktrees were made from, so a
/// worktree can still be cleaned up after its source left the recents.
fn workspaces_in(state: &PersistedState) -> HashSet<PathBuf> {
    state
        .recent_folders
        .iter()
        .map(|f| f.path.as_str())
        .chain(state.sessions.iter().map(|s| s.cwd.as_str()))
        .chain(
            state
                .sessions
                .iter()
                .filter_map(|s| s.worktree.as_ref().map(|w| w.repo_path.as_str())),
        )
        .collect::<HashSet<_>>()
        .into_iter()
        .filter_map(|path| Path::new(path).canonicalize().ok())
        .collect()
}

impl AppStore {
    /// Creates a store rooted at `root`. The directory itself is created on the
    /// first write, so a read-only launch never touches the filesystem.
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            known_workspaces: Mutex::new(None),
            legacy_worktrees_root: None,
        }
    }

    /// Also accepts worktrees under `root` when removing a session's worktree.
    pub fn with_legacy_worktrees_root(self, root: PathBuf) -> Self {
        Self {
            legacy_worktrees_root: Some(root),
            ..self
        }
    }

    /// Where session worktrees are made.
    pub fn worktrees_root(&self) -> PathBuf {
        self.root.join(WORKTREES_DIR)
    }

    /// Every folder a saved session's worktree may live in: [`Self::worktrees_root`]
    /// first, then the legacy one, if any.
    pub fn worktree_roots(&self) -> Vec<PathBuf> {
        std::iter::once(self.worktrees_root())
            .chain(self.legacy_worktrees_root.clone())
            .collect()
    }

    /// Whether `canonical_root` is one of the user's workspaces.
    pub fn is_known_workspace(&self, canonical_root: &Path) -> Result<bool, String> {
        let mut known = self
            .known_workspaces
            .lock()
            .map_err(|_| "Workspace lock poisoned".to_string())?;
        if known.is_none() {
            *known = Some(workspaces_in(&self.load_state()?));
        }
        Ok(known
            .as_ref()
            .is_some_and(|set| set.contains(canonical_root)))
    }

    /// Records a folder the user just opened, before its debounced state save lands.
    pub fn remember_workspace(&self, path: &str) -> Result<(), String> {
        let canonical = Path::new(path)
            .canonicalize()
            .map_err(|e| format!("Folder {path:?} is not accessible: {e}"))?;
        if !canonical.is_dir() {
            return Err(format!("{path:?} is not a folder"));
        }
        let mut known = self
            .known_workspaces
            .lock()
            .map_err(|_| "Workspace lock poisoned".to_string())?;
        if known.is_none() {
            *known = Some(workspaces_in(&self.load_state()?));
        }
        if let Some(set) = known.as_mut() {
            set.insert(canonical);
        }
        Ok(())
    }

    /// Loads the persisted state, or the default when nothing has been saved yet.
    ///
    /// A file that exists but cannot be parsed is moved aside to
    /// `state.json.corrupt-<unix millis>` and the default is returned, so one bad
    /// write cannot block every later launch and the bytes stay available for
    /// debugging. Sessions that were still live are normalized to `terminated`
    /// because the agent processes behind them are gone.
    pub fn load_state(&self) -> Result<PersistedState, String> {
        let path = self.root.join(STATE_FILE);

        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(PersistedState::default()),
            Err(e) => return Err(format!("Failed to read {}: {}", path.display(), e)),
        };

        let state: PersistedState = match serde_json::from_str(&raw) {
            Ok(state) => state,
            Err(e) => {
                self.quarantine_state(&path, &e)?;
                return Ok(PersistedState::default());
            }
        };

        Ok(normalize_sessions(state))
    }

    /// Writes the state as pretty JSON, replacing any previous file atomically.
    pub fn save_state(&self, state: &PersistedState) -> Result<(), String> {
        self.ensure_dir(&self.root)?;

        let json = serde_json::to_string_pretty(state)
            .map_err(|e| format!("Failed to serialize app state: {}", e))?;

        atomic_write(
            &self.root.join(STATE_FILE),
            &self.root.join(STATE_TMP_FILE),
            json.as_bytes(),
        )?;
        // Folders remembered this run stay known even if the save dropped them
        // from the recents; the set only grows until the next launch.
        let saved = workspaces_in(state);
        if let Ok(mut known) = self.known_workspaces.lock() {
            known.get_or_insert_with(HashSet::new).extend(saved);
        }
        Ok(())
    }

    /// Loads a session's transcript, or an empty vec when it has none yet.
    ///
    /// The messages are opaque JSON produced by the frontend, so the store never
    /// interprets them.
    pub fn load_transcript(&self, session_id: &str) -> Result<Vec<serde_json::Value>, String> {
        validate_session_id(session_id)?;
        let path = self.transcript_path(session_id);

        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("Failed to read transcript '{}': {}", session_id, e)),
        };

        serde_json::from_str(&raw)
            .map_err(|e| format!("Failed to parse transcript '{}': {}", session_id, e))
    }

    /// Writes a session's transcript, replacing any previous copy atomically.
    pub fn save_transcript(
        &self,
        session_id: &str,
        messages: &[serde_json::Value],
    ) -> Result<(), String> {
        validate_session_id(session_id)?;

        let dir = self.transcripts_dir();
        self.ensure_dir(&dir)?;

        // Compact: transcripts are rewritten often while an agent streams.
        let json = serde_json::to_string(messages)
            .map_err(|e| format!("Failed to serialize transcript '{}': {}", session_id, e))?;

        atomic_write(
            &self.transcript_path(session_id),
            &dir.join(format!("{}.json.tmp", session_id)),
            json.as_bytes(),
        )
    }

    /// Deletes a session's transcript. A file that is already gone is success.
    pub fn delete_transcript(&self, session_id: &str) -> Result<(), String> {
        validate_session_id(session_id)?;
        let path = self.transcript_path(session_id);

        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!(
                "Failed to delete transcript '{}': {}",
                session_id, e
            )),
        }
    }

    /// Directory holding every transcript file.
    fn transcripts_dir(&self) -> PathBuf {
        self.root.join(TRANSCRIPTS_DIR)
    }

    /// Path of the transcript file for `session_id`.
    ///
    /// Callers must have passed [`validate_session_id`] first, since the id
    /// becomes a file name.
    fn transcript_path(&self, session_id: &str) -> PathBuf {
        self.transcripts_dir().join(format!("{}.json", session_id))
    }

    /// Creates `dir` (and its parents) with an error that names the directory.
    fn ensure_dir(&self, dir: &Path) -> Result<(), String> {
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create {}: {}", dir.display(), e))
    }

    /// Moves an unparseable state file aside, keeping the bytes for inspection.
    fn quarantine_state(&self, path: &Path, parse_error: &serde_json::Error) -> Result<(), String> {
        let target = path.with_file_name(format!("{}.corrupt-{}", STATE_FILE, unix_millis_now()));

        fs::rename(path, &target).map_err(|e| {
            format!(
                "Failed to move the unreadable state file {} aside after '{}': {}",
                path.display(),
                parse_error,
                e
            )
        })
    }
}

/// Rejects session ids that could escape the transcripts directory.
///
/// The id is supplied by the renderer and becomes part of a path, so only a
/// short `[A-Za-z0-9_-]` token is accepted. That rules out `../state`, `a/b`,
/// and absolute paths before any filesystem call is made.
fn validate_session_id(session_id: &str) -> Result<(), String> {
    let valid = !session_id.is_empty()
        && session_id.chars().count() <= MAX_SESSION_ID_LEN
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');

    if valid {
        Ok(())
    } else {
        Err(format!("Invalid session id '{}'", session_id))
    }
}

/// Writes `contents` to `tmp` then renames it over `path`.
///
/// The rename is the only visible step, so a reader sees either the old file or
/// the complete new one, never a partial write.
pub(crate) fn atomic_write(path: &Path, tmp: &Path, contents: &[u8]) -> Result<(), String> {
    fs::write(tmp, contents).map_err(|e| format!("Failed to write {}: {}", tmp.display(), e))?;
    fs::rename(tmp, path).map_err(|e| format!("Failed to replace {}: {}", path.display(), e))
}

/// Marks every non-terminated session as terminated, leaving `ended_at` alone.
fn normalize_sessions(mut state: PersistedState) -> PersistedState {
    for session in &mut state.sessions {
        if session.status != STATUS_TERMINATED {
            session.status = STATUS_TERMINATED.to_string();
        }
    }
    state
}

/// Current unix time in milliseconds, or `0` if the clock predates the epoch.
fn unix_millis_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}
