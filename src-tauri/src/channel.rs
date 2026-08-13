// Build-channel derivation. **std-only** so it can be `include!`d by
// `build.rs` (which cannot depend on the crate it builds) *and* compiled
// as a normal `mod` for unit tests. Regular `//` comments (not `//!`):
// `include!` pastes this at item position where inner doc comments are
// rejected (E0753).
//
// Spec: `docs/feature-flags.md` §3.2 (BLOCKER-2 / R2-B / R2-H).
//
// `channel` is **not** itself a security boundary (R2-H): the
// load-bearing gate that keeps in-development code out of a signed
// release is the `dev-features` *compile-time* exclusion. The channel
// guard is an independent second layer.

/// Resolved build channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Release,
    Dev,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Release => "release",
            Channel::Dev => "dev",
        }
    }
}

/// Derive the channel from CI signals using a **positive-signal** rule
/// (§3.2): `release` iff `commit_tag` matches the anchored release
/// version pattern `^v\d+\.\d+\.\d+$` **and** a CI context variable
/// (`GITLAB_CI` or `CI_PIPELINE_ID`) is present and non-empty.
///
/// Everything else — local builds, a locally-spoofed `CI_COMMIT_TAG`
/// without CI context, manual CI, branch builds — resolves to `dev`.
/// `git dirty` is intentionally **not** an input (BLOCKER-2: the prior
/// `git status --porcelain` discriminator was fail-open and demoted a
/// legitimate signed release to `dev`).
pub fn derive_channel(
    commit_tag: Option<&str>,
    gitlab_ci: Option<&str>,
    pipeline_id: Option<&str>,
) -> Channel {
    let tag_ok = commit_tag.map(is_release_tag).unwrap_or(false);
    let ci_present = non_empty(gitlab_ci) || non_empty(pipeline_id);
    if tag_ok && ci_present {
        Channel::Release
    } else {
        Channel::Dev
    }
}

fn non_empty(v: Option<&str>) -> bool {
    v.map(|s| !s.is_empty()).unwrap_or(false)
}

/// Anchored equivalent of the CI `workflow.rules` regex
/// `^v\d+\.\d+\.\d+$`, hand-rolled so this file stays std-only and
/// `include!`-able by `build.rs` (no `regex` dependency).
fn is_release_tag(tag: &str) -> bool {
    let Some(rest) = tag.strip_prefix('v') else {
        return false;
    };
    let mut parts = rest.split('.');
    let (Some(major), Some(minor), Some(patch), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    is_all_digits(major) && is_all_digits(minor) && is_all_digits(patch)
}

fn is_all_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_requires_tag_and_ci() {
        assert_eq!(
            derive_channel(Some("v0.1.19"), Some("true"), None),
            Channel::Release
        );
        assert_eq!(
            derive_channel(Some("v0.1.19"), None, Some("2536924082")),
            Channel::Release
        );
        assert_eq!(
            derive_channel(Some("v12.30.400"), Some("true"), None),
            Channel::Release
        );
    }

    #[test]
    fn tag_without_ci_is_dev_local_spoof() {
        // `export CI_COMMIT_TAG=v1.2.3` locally must NOT yield release.
        assert_eq!(derive_channel(Some("v1.2.3"), None, None), Channel::Dev);
        assert_eq!(
            derive_channel(Some("v1.2.3"), Some(""), Some("")),
            Channel::Dev
        );
    }

    #[test]
    fn ci_without_release_tag_is_dev() {
        assert_eq!(
            derive_channel(None, Some("true"), Some("1")),
            Channel::Dev
        );
        assert_eq!(
            derive_channel(Some(""), Some("true"), None),
            Channel::Dev
        );
    }

    #[test]
    fn non_semver_tags_are_dev() {
        for t in [
            "v1.2",
            "v1.2.3.4",
            "1.2.3",
            "v1.2.x",
            "vx.y.z",
            "v1.2.3-rc1",
            "release-1.2.3",
            "v1.2.3 ",
            "v1..3",
            "v",
        ] {
            assert_eq!(
                derive_channel(Some(t), Some("true"), None),
                Channel::Dev,
                "tag {t:?} must resolve to Dev"
            );
        }
    }

    #[test]
    fn is_release_tag_unit() {
        assert!(is_release_tag("v0.0.0"));
        assert!(is_release_tag("v1.2.3"));
        assert!(!is_release_tag("v1.2.3-dirty"));
        assert!(!is_release_tag(""));
        assert!(!is_release_tag("v1.2"));
    }

    #[test]
    fn channel_as_str() {
        assert_eq!(Channel::Release.as_str(), "release");
        assert_eq!(Channel::Dev.as_str(), "dev");
    }
}
