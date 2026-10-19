//! Agent Client Protocol (ACP) client.
//!
//! Agents that speak ACP (Qwen Code natively, Claude Code and Codex through
//! their official adapters) are driven over stdin/stdout with structured
//! JSON-RPC instead of scraping a terminal UI.

pub mod commands;
pub mod connection;
pub mod jsonrpc;
pub mod manager;
pub mod probe;
pub mod prompt_blocks;
