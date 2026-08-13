//! Feature-flag registry and resolver.
//!
//! Single always-compiled declarative table (§3.7-5 — no `#[cfg]`-split
//! parallel lists) plus a pure resolver. The resolver encodes the
//! `is_enabled` invariants from `docs/feature-flags.md` §3.4:
//!
//! - Compile-time `dev-features` is the **outermost, uncircumventable
//!   hard-AND**: a `kind=dev` flag is `false` whenever `dev-features`
//!   is not compiled in, regardless of channel / env.
//! - **release branch**: `cfg ∧ default_release` (a `dev` flag is
//!   always `false`; `ops` may be killed).
//! - **dev branch**: `cfg ∧ channel==dev ∧ (default_dev ∨
//!   flag ∈ VELLIS_FLAGS)`.
//! - `VELLIS_FLAGS` enables **only `kind=dev`** flags and **only on the
//!   `dev` channel**.
//! - ops override is **`kind=ops` only** and **kill-direction only**
//!   (can force OFF, never resurrect a compile-excluded / channel-gated
//!   flag).
//!
//! `channel` is not itself a security boundary (R2-H); the load-bearing
//! gate is the `dev-features` compile exclusion.

use std::collections::BTreeMap;

use crate::channel::Channel;

/// Positive sentinel compiled **only** under `dev-features` (R2-A). The
/// CI post-build smoke asserts this symbol is **absent** from a signed
/// release artifact (`nm`), which is a definite check rather than a
/// vague "no dev symbols" heuristic.
#[cfg(feature = "dev-features")]
#[no_mangle]
#[used]
pub static VELLIS_DEV_FEATURES_PRESENT: u8 = 1;

/// `true` iff this binary was compiled with the `dev-features` feature.
/// This is the outermost hard-AND term of `is_enabled`.
pub const DEV_FEATURES_COMPILED: bool = cfg!(feature = "dev-features");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlagKind {
    /// In-development, structurally excluded from production.
    Dev,
    /// Shipped feature with an operational kill-switch.
    Ops,
    /// Future A/B (v1 non-target; reserved).
    Experiment,
}

/// One row of the declarative registry. Stable `name` is the join key
/// for both Rust `is_enabled("…")` and frontend `{#if flags.X}`.
#[derive(Debug, Clone, Copy)]
pub struct FlagSpec {
    pub name: &'static str,
    pub kind: FlagKind,
    pub default_dev: bool,
    pub default_release: bool,
    pub owner: &'static str,
    /// GitLab issue link (e.g. `#43`), or `permanent` for an `ops`
    /// kill-switch intentionally kept forever (§6-4).
    pub removal: &'static str,
    pub description: &'static str,
}

/// The single source of truth. Empty in v1 — the mechanism ships with no
/// in-development features registered yet; entries are added per
/// `docs/feature-flags.md` §3.7 lifecycle.
pub const REGISTRY: &[FlagSpec] = &[];

/// Channel baked at compile time by `build.rs`. `option_env!` + default
/// to `Dev` keeps this fail-safe if the env was somehow not injected.
pub fn current_channel() -> Channel {
    match option_env!("VELLIS_CHANNEL") {
        Some("release") => Channel::Release,
        _ => Channel::Dev,
    }
}

fn lookup(name: &str) -> Option<&'static FlagSpec> {
    REGISTRY.iter().find(|f| f.name == name)
}

/// Pure resolver — fully unit-testable, no env/IO. All `is_enabled`
/// invariants (§3.4) live here so they can be exhaustively tested.
fn resolve(
    spec: &FlagSpec,
    channel: Channel,
    dev_features_compiled: bool,
    vellis_flags: &[&str],
    ops_killed: bool,
) -> bool {
    // Outermost hard-AND: a Dev flag without dev-features compiled can
    // never be enabled, by any channel / env path.
    if matches!(spec.kind, FlagKind::Dev) && !dev_features_compiled {
        return false;
    }

    let base = match channel {
        Channel::Release => match spec.kind {
            FlagKind::Dev => false,
            FlagKind::Ops | FlagKind::Experiment => spec.default_release,
        },
        Channel::Dev => match spec.kind {
            // VELLIS_FLAGS is consulted ONLY here: kind=dev ∧ channel=dev.
            FlagKind::Dev => spec.default_dev || vellis_flags.contains(&spec.name),
            FlagKind::Ops | FlagKind::Experiment => spec.default_dev,
        },
    };

    // ops override: kind=ops only, kill-direction only (narrowing).
    if matches!(spec.kind, FlagKind::Ops) && ops_killed {
        return false;
    }

    base
}

fn parse_list(raw: &str) -> Vec<&str> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect()
}

/// Runtime entry point. Unknown flag → `false` (fail-safe).
pub fn is_enabled(name: &str) -> bool {
    let Some(spec) = lookup(name) else {
        return false;
    };
    let vellis_flags_raw = std::env::var("VELLIS_FLAGS").unwrap_or_default();
    let vellis_flags = parse_list(&vellis_flags_raw);
    // ops kill input (env path; concrete config-file path is a later
    // impl detail per §6-3). Bool-only, robust-parsed, invalid ignored.
    let ops_kill_raw = std::env::var("VELLIS_DISABLE").unwrap_or_default();
    let ops_killed = parse_list(&ops_kill_raw).contains(&name);
    resolve(
        spec,
        current_channel(),
        DEV_FEATURES_COMPILED,
        &vellis_flags,
        ops_killed,
    )
}

/// Flag map for `get_build_info`. On the `release` channel, `kind=dev`
/// entries are **omitted** from the payload (§3.5 payload minimization
/// — they are always `false` and would only leak unreleased names to
/// the WebView). Registry metadata (owner/removal/…) never crosses IPC.
pub fn flags_map() -> BTreeMap<&'static str, bool> {
    let channel = current_channel();
    REGISTRY
        .iter()
        .filter(|spec| {
            !(channel == Channel::Release && matches!(spec.kind, FlagKind::Dev))
        })
        .map(|spec| (spec.name, is_enabled(spec.name)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEV_DEFAULT_OFF: FlagSpec = FlagSpec {
        name: "editor_inline",
        kind: FlagKind::Dev,
        default_dev: false,
        default_release: false,
        owner: "t",
        removal: "#100",
        description: "test",
    };
    const DEV_DEFAULT_ON: FlagSpec = FlagSpec {
        name: "bridge_tcp_fallback",
        kind: FlagKind::Dev,
        default_dev: true,
        default_release: false,
        owner: "t",
        removal: "#101",
        description: "test",
    };
    const OPS_FLAG: FlagSpec = FlagSpec {
        name: "telemetry_upload",
        kind: FlagKind::Ops,
        default_dev: true,
        default_release: true,
        owner: "t",
        removal: "permanent",
        description: "test",
    };

    #[test]
    fn dev_flag_never_enabled_without_dev_features_compiled() {
        // Outermost hard-AND: even on dev channel, even if in VELLIS_FLAGS.
        assert!(!resolve(
            &DEV_DEFAULT_ON,
            Channel::Dev,
            false,
            &["bridge_tcp_fallback"],
            false
        ));
    }

    #[test]
    fn dev_flag_false_on_release_channel() {
        assert!(!resolve(&DEV_DEFAULT_ON, Channel::Release, true, &[], false));
        // VELLIS_FLAGS cannot resurrect it on release.
        assert!(!resolve(
            &DEV_DEFAULT_ON,
            Channel::Release,
            true,
            &["bridge_tcp_fallback"],
            false
        ));
    }

    #[test]
    fn dev_flag_opt_in_on_dev_channel() {
        // default_dev=false → off unless opted in via VELLIS_FLAGS.
        assert!(!resolve(&DEV_DEFAULT_OFF, Channel::Dev, true, &[], false));
        assert!(resolve(
            &DEV_DEFAULT_OFF,
            Channel::Dev,
            true,
            &["editor_inline"],
            false
        ));
        // default_dev=true → on by default.
        assert!(resolve(&DEV_DEFAULT_ON, Channel::Dev, true, &[], false));
    }

    #[test]
    fn ops_kill_only_narrows_and_only_ops_kind() {
        // ops enabled by default_release, killable on release.
        assert!(resolve(&OPS_FLAG, Channel::Release, true, &[], false));
        assert!(!resolve(&OPS_FLAG, Channel::Release, true, &[], true));
        // ops kill flag must not force a dev flag on/off path open.
        assert!(!resolve(&DEV_DEFAULT_OFF, Channel::Release, true, &[], true));
    }

    #[test]
    fn vellis_flags_ignored_for_ops_kind() {
        // Listing an ops flag in VELLIS_FLAGS must not force it ON beyond
        // its declared default (it is not a general per-flag ON switch).
        let ops_off = FlagSpec {
            default_dev: false,
            default_release: false,
            ..OPS_FLAG
        };
        assert!(!resolve(
            &ops_off,
            Channel::Dev,
            true,
            &["telemetry_upload"],
            false
        ));
    }

    #[test]
    fn unknown_flag_is_false() {
        assert!(!is_enabled("does_not_exist"));
    }

    #[test]
    fn v1_registry_is_empty() {
        assert!(REGISTRY.is_empty());
        assert!(flags_map().is_empty());
    }
}
