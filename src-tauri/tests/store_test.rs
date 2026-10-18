use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;

use zorvo_lib::store::{
    AppStore, PersistedState, RecentFolder, SessionRecord, SessionWorktreeRecord, Settings,
    STATE_VERSION,
};

/// Builds a root path that is unique to this process and this call, so tests
/// running in parallel (or a leftover directory from a killed run) cannot
/// collide.
fn unique_temp_root(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before the unix epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "zorvo-store-{}-{}-{}",
        tag,
        std::process::id(),
        nanos
    ))
}

/// Recursively collects every file under `root`, sorted, for assertions about
/// what a call did or did not write.
fn files_under(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];

    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else {
                found.push(path);
            }
        }
    }

    found.sort();
    found
}

fn session(id: &str, status: &str) -> SessionRecord {
    SessionRecord {
        id: id.to_string(),
        name: format!("Session {}", id),
        profile_id: "claude".to_string(),
        cwd: "/tmp/project".to_string(),
        status: status.to_string(),
        created_at: 1_700_000_000_000,
        ended_at: None,
        exit_code: None,
        model: Some("sonnet".to_string()),
        effort: None,
        permission_mode: Some("default".to_string()),
        forked_from: None,
        agent_session_id: None,
        transport: None,
        acp_session_id: None,
        worktree: None,
        pinned: false,
        archived_at: None,
        named_by_user: false,
        has_unread: false,
    }
}

fn populated_state() -> PersistedState {
    PersistedState {
        version: STATE_VERSION,
        settings: Settings {
            default_agent_id: Some("claude".to_string()),
            onboarding_completed: true,
        },
        recent_folders: vec![RecentFolder {
            name: "agent-desktop".to_string(),
            path: "/Users/dev/developer/agent-desktop".to_string(),
            last_opened_at: 1_700_000_000_123,
        }],
        sessions: vec![session("s-1", "terminated")],
        ..PersistedState::default()
    }
}

#[test]
fn missing_state_file_loads_the_default_state() {
    let root = unique_temp_root("missing-state");
    let store = AppStore::new(root.clone());

    assert!(!root.exists(), "test precondition: root must not exist");

    let state = store
        .load_state()
        .expect("a missing state file is not an error");

    assert_eq!(state.version, STATE_VERSION);
    assert_eq!(state, PersistedState::default());
    assert!(!root.join("state.json").exists(), "load must not write");

    fs::remove_dir_all(&root).ok();
}

#[test]
fn save_then_load_round_trips_settings_recent_folder_and_session() {
    let root = unique_temp_root("round-trip");
    let store = AppStore::new(root.clone());
    let state = populated_state();

    store.save_state(&state).expect("save state");
    let loaded = store.load_state().expect("load state");

    assert_eq!(loaded, state);
    assert_eq!(
        loaded.settings.default_agent_id.as_deref(),
        Some("claude"),
        "settings must survive the round trip"
    );
    assert!(loaded.settings.onboarding_completed);
    assert_eq!(loaded.recent_folders.len(), 1);
    assert_eq!(loaded.recent_folders[0].last_opened_at, 1_700_000_000_123);
    assert_eq!(loaded.sessions.len(), 1);
    assert_eq!(loaded.sessions[0].id, "s-1");

    fs::remove_dir_all(&root).expect("remove temp root");
}

#[test]
fn state_is_written_as_camel_case_json_for_the_typescript_side() {
    let root = unique_temp_root("camel-case");
    let store = AppStore::new(root.clone());

    store.save_state(&populated_state()).expect("save state");
    let raw = fs::read_to_string(root.join("state.json")).expect("read state.json");

    for key in [
        "\"defaultAgentId\"",
        "\"onboardingCompleted\"",
        "\"recentFolders\"",
        "\"lastOpenedAt\"",
        "\"profileId\"",
        "\"createdAt\"",
        "\"exitCode\"",
        "\"permissionMode\"",
        "\"forkedFrom\"",
        "\"agentSessionId\"",
        "\"endedAt\"",
    ] {
        assert!(raw.contains(key), "state.json is missing the key {}", key);
    }
    for snake_key in [
        "\"default_agent_id\"",
        "\"recent_folders\"",
        "\"last_opened_at\"",
        "\"profile_id\"",
    ] {
        assert!(
            !raw.contains(snake_key),
            "state.json must not use the snake_case key {}",
            snake_key
        );
    }

    fs::remove_dir_all(&root).expect("remove temp root");
}

#[test]
fn a_session_saved_as_running_loads_back_as_terminated() {
    let root = unique_temp_root("normalize-status");
    let store = AppStore::new(root.clone());
    let mut running = session("s-live", "running");
    running.ended_at = None;
    let mut finished = session("s-done", "terminated");
    finished.ended_at = Some(1_700_000_009_999);
    finished.exit_code = Some(0);

    store
        .save_state(&PersistedState {
            version: STATE_VERSION,
            settings: Settings::default(),
            recent_folders: Vec::new(),
            sessions: vec![running, finished],
            ..PersistedState::default()
        })
        .expect("save state");

    // Normalization happens on load, not on save: no agent process survives a
    // restart, but the file still records what the UI last knew.
    let raw = fs::read_to_string(root.join("state.json")).expect("read state.json");
    assert!(
        raw.contains("\"running\""),
        "save must not rewrite the status"
    );

    let loaded = store.load_state().expect("load state");

    assert_eq!(loaded.sessions[0].status, "terminated");
    assert_eq!(
        loaded.sessions[0].ended_at, None,
        "normalizing the status must not invent an ended_at"
    );
    assert_eq!(loaded.sessions[1].status, "terminated");
    assert_eq!(loaded.sessions[1].ended_at, Some(1_700_000_009_999));
    assert_eq!(loaded.sessions[1].exit_code, Some(0));

    fs::remove_dir_all(&root).expect("remove temp root");
}

#[test]
fn an_invalid_state_file_is_moved_aside_and_the_default_is_returned() {
    let root = unique_temp_root("corrupt-state");
    fs::create_dir_all(&root).expect("create temp root");
    let corrupt = "{ this is not json";
    fs::write(root.join("state.json"), corrupt).expect("write corrupt state.json");
    let store = AppStore::new(root.clone());

    let state = store
        .load_state()
        .expect("a corrupt state file must not fail the load");

    assert_eq!(state, PersistedState::default());
    assert_eq!(state.version, STATE_VERSION);
    assert!(
        !root.join("state.json").exists(),
        "the unreadable file must be moved out of the way, not left to fail every launch"
    );

    let moved_aside: Vec<PathBuf> = fs::read_dir(&root)
        .expect("read temp root")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("state.json.corrupt-"))
        })
        .collect();

    assert_eq!(
        moved_aside.len(),
        1,
        "expected exactly one state.json.corrupt-* file, found {:?}",
        moved_aside
    );
    assert_eq!(
        fs::read_to_string(&moved_aside[0]).expect("read the quarantined file"),
        corrupt,
        "the original bytes must be preserved for debugging"
    );

    fs::remove_dir_all(&root).expect("remove temp root");
}

#[test]
fn a_state_file_missing_optional_sections_still_loads() {
    let root = unique_temp_root("partial-state");
    fs::create_dir_all(&root).expect("create temp root");
    fs::write(root.join("state.json"), r#"{"version":1,"sessions":[]}"#)
        .expect("write partial state.json");
    let store = AppStore::new(root.clone());

    let state = store
        .load_state()
        .expect("load a state file written by an older build");

    assert_eq!(state.version, 1);
    assert_eq!(state.settings, Settings::default());
    assert_eq!(state.settings.default_agent_id, None);
    assert!(!state.settings.onboarding_completed);
    assert_eq!(state.recent_folders, Vec::new());
    assert_eq!(state.sessions, Vec::new());

    fs::remove_dir_all(&root).expect("remove temp root");
}

#[test]
fn transcripts_round_trip_and_delete_idempotently() {
    let root = unique_temp_root("transcripts");
    let store = AppStore::new(root.clone());
    let messages = vec![
        json!({ "role": "user", "content": "fix the parser" }),
        json!({ "role": "assistant", "content": ["looking into it"] }),
    ];

    store
        .save_transcript("s-1", &messages)
        .expect("save transcript");
    assert_eq!(
        store.load_transcript("s-1").expect("load transcript"),
        messages
    );
    assert!(
        root.join("transcripts").join("s-1.json").exists(),
        "the transcript must live under transcripts/ named after the session"
    );

    assert_eq!(
        store
            .load_transcript("never-saved")
            .expect("load a missing transcript"),
        Vec::<serde_json::Value>::new(),
        "a missing transcript is an empty conversation, not an error"
    );

    store.delete_transcript("s-1").expect("delete transcript");
    assert!(!root.join("transcripts").join("s-1.json").exists());
    store
        .delete_transcript("s-1")
        .expect("deleting an already-deleted transcript is not an error");

    fs::remove_dir_all(&root).expect("remove temp root");
}

#[test]
fn transcript_calls_reject_session_ids_that_would_escape_the_transcripts_dir() {
    let root = unique_temp_root("traversal");
    let store = AppStore::new(root.clone());
    let messages = vec![json!({ "role": "user", "content": "hi" })];
    let long_id = "a".repeat(65);

    let rejected = [
        ("../state", "path traversal out of transcripts/"),
        ("a/b", "nested path"),
        ("", "empty id"),
        (long_id.as_str(), "id longer than 64 chars"),
    ];

    for (id, why) in rejected {
        let loaded = store.load_transcript(id);
        assert!(loaded.is_err(), "load_transcript accepted {} ({})", id, why);
        assert!(
            loaded.unwrap_err().contains("Invalid session id"),
            "load_transcript('{}') must report an invalid session id",
            id
        );

        let saved = store.save_transcript(id, &messages);
        assert!(saved.is_err(), "save_transcript accepted {} ({})", id, why);
        assert!(
            saved.unwrap_err().contains("Invalid session id"),
            "save_transcript('{}') must report an invalid session id",
            id
        );

        let deleted = store.delete_transcript(id);
        assert!(
            deleted.is_err(),
            "delete_transcript accepted {} ({})",
            id,
            why
        );
        assert!(
            deleted.unwrap_err().contains("Invalid session id"),
            "delete_transcript('{}') must report an invalid session id",
            id
        );
    }

    // The 64-char boundary itself is legal, so the check is a length limit and
    // not a blanket rejection.
    let max_id = "a".repeat(64);
    store
        .save_transcript(&max_id, &messages)
        .expect("a 64-char id is within the allowed range");

    let transcripts = root.join("transcripts");
    assert!(
        !root.join("state.json").exists(),
        "a rejected id must not reach root/state.json"
    );
    for file in files_under(&root) {
        assert!(
            file.starts_with(&transcripts),
            "a rejected session id wrote outside transcripts/: {:?}",
            file
        );
    }
    assert_eq!(
        files_under(&transcripts),
        vec![transcripts.join(format!("{}.json", max_id))],
        "only the legal 64-char transcript may exist"
    );

    fs::remove_dir_all(&root).expect("remove temp root");
}

#[test]
fn acp_sessions_keep_their_transport_and_agent_session_id() {
    let root = unique_temp_root("acp-session");
    let store = AppStore::new(root.clone());
    // Shaped like what the frontend saves for a Qwen Code session.
    let record: SessionRecord = serde_json::from_value(json!({
        "id": "s-acp",
        "name": "Session #4",
        "profileId": "qwen",
        "cwd": "/tmp/project",
        "status": "terminated",
        "createdAt": 1_700_000_000_000_i64,
        "transport": "acp",
        "acpSessionId": "qwen-session-123"
    }))
    .expect("deserialize session");
    let state = PersistedState {
        sessions: vec![record],
        ..populated_state()
    };

    store.save_state(&state).expect("save state");
    let loaded = store.load_state().expect("load state");
    let saved = serde_json::to_value(&loaded.sessions[0]).expect("serialize session");

    assert_eq!(saved["transport"], "acp");
    assert_eq!(saved["acpSessionId"], "qwen-session-123");

    fs::remove_dir_all(&root).expect("remove temp root");
}

#[test]
fn keeps_the_options_each_acp_agent_reported_last() {
    let root = unique_temp_root("agent-options");
    let store = AppStore::new(root.clone());
    let mut state = populated_state();
    let options = json!({ "qwen": { "modes": { "currentModeId": "yolo", "availableModes": [] }, "configOptions": [] } });
    state.agent_options = options.as_object().cloned().expect("object");

    store.save_state(&state).expect("save state");
    let loaded = store.load_state().expect("load state");

    assert_eq!(
        loaded.agent_options["qwen"]["modes"]["currentModeId"],
        "yolo"
    );
    fs::remove_dir_all(&root).expect("remove temp root");
}

#[test]
fn knows_saved_and_just_remembered_workspaces_without_rereading_the_file() {
    let root = unique_temp_root("known-workspaces");
    let store = AppStore::new(root.join("state"));
    let saved = root.join("saved-folder");
    let opened = root.join("opened-folder");
    fs::create_dir_all(&saved).unwrap();
    fs::create_dir_all(&opened).unwrap();
    let state = PersistedState {
        recent_folders: vec![RecentFolder {
            name: "saved-folder".to_string(),
            path: saved.to_string_lossy().to_string(),
            last_opened_at: 1,
        }],
        ..PersistedState::default()
    };
    store.save_state(&state).expect("save state");

    // A folder the user just opened is known before its state save lands.
    store
        .remember_workspace(&opened.to_string_lossy())
        .expect("remember");

    assert!(store
        .is_known_workspace(&saved.canonicalize().unwrap())
        .unwrap());
    assert!(store
        .is_known_workspace(&opened.canonicalize().unwrap())
        .unwrap());
    assert!(!store.is_known_workspace(Path::new("/")).unwrap());
    assert!(store.remember_workspace("/definitely/not/here").is_err());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn keeps_a_sessions_worktree_through_a_save() {
    let root = unique_temp_root("worktree");
    let store = AppStore::new(root.clone());
    let mut state = populated_state();
    state.sessions[0].worktree = Some(SessionWorktreeRecord {
        repo_path: "/Users/dev/developer/agent-desktop".to_string(),
        path: "/data/worktrees/agent-desktop/fix-login".to_string(),
        branch: "agent/fix-login".to_string(),
    });

    store.save_state(&state).expect("save state");
    let raw = fs::read_to_string(root.join("state.json")).expect("read state file");
    let loaded = store.load_state().expect("load state");

    assert_eq!(loaded, state);
    assert!(
        raw.contains("\"repoPath\""),
        "the worktree is saved in the UI's camelCase: {raw}"
    );
    fs::remove_dir_all(&root).ok();
}

#[test]
fn drops_a_malformed_worktree_but_keeps_the_saved_sessions() {
    let root = unique_temp_root("bad-worktree");
    fs::create_dir_all(&root).expect("create root");
    fs::write(
        root.join("state.json"),
        r#"{"version":1,"settings":{"defaultAgentId":"claude","onboardingCompleted":true},
            "recentFolders":[],
            "sessions":[{"id":"s-1","name":"Fix login","profileId":"claude","cwd":"/tmp/project",
                         "status":"terminated","createdAt":1,"worktree":{"path":3}}]}"#,
    )
    .expect("write state file");
    let store = AppStore::new(root.clone());

    let state = store.load_state().expect("load state");

    assert_eq!(
        state.sessions.len(),
        1,
        "the session survives its bad worktree"
    );
    assert_eq!(state.sessions[0].worktree, None);
    assert!(state.settings.onboarding_completed);
    fs::remove_dir_all(&root).ok();
}

#[test]
fn knows_the_folder_a_saved_worktree_was_made_from() {
    let root = unique_temp_root("worktree-source");
    let source = root.join("my-app");
    fs::create_dir_all(&source).expect("create source folder");
    let store = AppStore::new(root.join("data"));
    let mut state = PersistedState {
        sessions: vec![session("s-1", "terminated")],
        ..PersistedState::default()
    };
    state.sessions[0].worktree = Some(SessionWorktreeRecord {
        repo_path: source.to_string_lossy().to_string(),
        path: root
            .join("data/worktrees/my-app/fix")
            .to_string_lossy()
            .to_string(),
        branch: "agent/fix".to_string(),
    });
    store.save_state(&state).expect("save state");

    let fresh = AppStore::new(root.join("data"));

    assert!(fresh
        .is_known_workspace(&source.canonicalize().expect("canonical source"))
        .expect("check workspace"));
    fs::remove_dir_all(&root).ok();
}

#[test]
fn keeps_a_sessions_pin_archive_and_user_given_name() {
    let root = unique_temp_root("organize");
    let store = AppStore::new(root.clone());
    let mut state = populated_state();
    state.sessions[0].pinned = true;
    state.sessions[0].archived_at = Some(1_700_000_000_999);
    state.sessions[0].named_by_user = true;
    state.sessions[0].has_unread = true;

    store.save_state(&state).expect("save state");
    let raw = fs::read_to_string(root.join("state.json")).expect("read state file");
    let loaded = store.load_state().expect("load state");

    assert_eq!(loaded, state);
    for key in [
        "\"pinned\"",
        "\"archivedAt\"",
        "\"namedByUser\"",
        "\"hasUnread\"",
    ] {
        assert!(raw.contains(key), "state.json is missing {key}: {raw}");
    }
    fs::remove_dir_all(&root).ok();
}

#[test]
fn drops_malformed_organizing_fields_but_keeps_the_saved_sessions() {
    let root = unique_temp_root("bad-organize");
    fs::create_dir_all(&root).expect("create root");
    fs::write(
        root.join("state.json"),
        r#"{"version":1,"settings":{"defaultAgentId":null,"onboardingCompleted":true},"recentFolders":[],
            "sessions":[{"id":"s-1","name":"Fix login","profileId":"claude","cwd":"/tmp/project",
                         "status":"terminated","createdAt":1,
                         "pinned":"yes","archivedAt":"2026-10-17","namedByUser":1,"hasUnread":"no"}]}"#,
    )
    .expect("write state file");
    let store = AppStore::new(root.clone());

    let state = store.load_state().expect("load state");

    assert_eq!(
        state.sessions.len(),
        1,
        "the session survives its bad fields"
    );
    assert!(!state.sessions[0].pinned);
    assert_eq!(state.sessions[0].archived_at, None);
    assert!(!state.sessions[0].named_by_user);
    assert!(!state.sessions[0].has_unread);
    fs::remove_dir_all(&root).ok();
}
