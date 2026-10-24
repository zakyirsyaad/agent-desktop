//! Every integration test in one binary, so tauri, tokio and the rest are
//! linked once instead of once per file. `installer_state_test.rs` stays
//! apart: it sets process-wide installer state that other tests also read.

mod common;

mod acp_jsonrpc_test;
mod acp_manager_test;
mod acp_prompt_blocks_test;
mod acp_session_list_test;
mod acp_session_reopen_test;
mod background_processes_test;
mod branches_test;
mod changes_test;
mod config_test;
mod data_migration_test;
mod diff_stats_test;
mod e2e_integration_test;
mod env_resolver_test;
mod git_info_test;
mod installer_archive_test;
mod installer_cleanup_test;
mod installer_download_test;
mod installer_install_test;
mod installer_layout_test;
mod installer_plan_test;
mod installer_prerequisites_test;
mod installer_runtimes_test;
mod profiles_test;
mod pty_session_test;
mod registry_catalog_test;
mod registry_catalog_view_test;
mod registry_fetch_test;
mod registry_history_test;
mod registry_icons_test;
mod registry_resolve_test;
mod registry_schema_test;
mod store_test;
mod workspace_files_test;
mod workspace_terminal_test;
mod workspaces_test;
mod worktrees_test;
