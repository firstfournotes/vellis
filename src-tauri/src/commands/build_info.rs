//! `get_build_info` command — exposes compile-time build metadata to the
//! frontend (version, build number, build time, build name).
//!
//! Build number / time / name are baked at compile time by `build.rs` via
//! the `VELLIS_BUILD_NUMBER`, `VELLIS_BUILD_TIME` and `VELLIS_BUILD_NAME`
//! env vars, so calling this command is a constant-time lookup. `channel` / `flags` are resolved in
//! Rust (feature-flags.md §3.5) — the frontend never re-evaluates them.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::features;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub version: &'static str,
    pub build_number: &'static str,
    pub build_time: &'static str,
    /// The preview build's name, `dev-<name> #<n>(YYYY-MM-DD HH:MM JST)`
    /// (要件87 契約2); `""` on release and dev builds.
    pub build_name: &'static str,
    /// `"release"` | `"preview"` | `"dev"` — single source of truth for the
    /// frontend.
    pub channel: &'static str,
    /// Resolved flag booleans. On `release`, `kind=dev` entries are
    /// omitted (§3.5 payload minimization); registry metadata
    /// (owner/removal/…) never crosses IPC.
    pub flags: BTreeMap<&'static str, bool>,
}

#[tauri::command]
pub fn get_build_info() -> BuildInfo {
    BuildInfo {
        version: env!("CARGO_PKG_VERSION"),
        build_number: env!("VELLIS_BUILD_NUMBER"),
        build_time: env!("VELLIS_BUILD_TIME"),
        build_name: env!("VELLIS_BUILD_NAME"),
        channel: features::current_channel().as_str(),
        flags: features::flags_map(),
    }
}
