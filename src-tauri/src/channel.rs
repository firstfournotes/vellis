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
//
// 要件87: a third channel, `preview` (開発版), for the signed and
// notarized pre-releases `.github/workflows/dev-release.yml` publishes to
// the development repository. It carries the same feature set as
// `release` and a build name (`build_name`) that tells which of two
// installed previews is newer.

/// Resolved build channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Release,
    /// 開発版 (要件87): a CI build of a `dev/<name>/<n>` tag. Same feature
    /// set as `Release`; never checks for updates on its own.
    Preview,
    Dev,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Release => "release",
            Channel::Preview => "preview",
            Channel::Dev => "dev",
        }
    }
}

/// Derive the channel from CI signals using a **positive-signal** rule
/// (§3.2): `release` iff `commit_tag` matches the anchored release
/// version pattern `^v\d+\.\d+\.\d+$` **and** a CI context variable
/// (`GITLAB_CI` or `CI_PIPELINE_ID`) is present and non-empty.
/// `preview` (要件87) iff, with the same CI context, `commit_tag` matches
/// the anchored development-release pattern
/// `^dev/[a-z0-9][a-z0-9-]*/[1-9][0-9]*$` ([`parse_preview_tag`]).
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
    let ci_present = non_empty(gitlab_ci) || non_empty(pipeline_id);
    if !ci_present {
        return Channel::Dev;
    }
    match commit_tag {
        Some(tag) if is_release_tag(tag) => Channel::Release,
        Some(tag) if parse_preview_tag(tag).is_some() => Channel::Preview,
        _ => Channel::Dev,
    }
}

/// Split a development-release tag `dev/<name>/<n>` into `(name, n)`.
///
/// Anchored, ASCII-only equivalent of `^dev/[a-z0-9][a-z0-9-]*/[1-9][0-9]*$`
/// (hand-rolled for the same reason as [`is_release_tag`]): `name` starts
/// with a lowercase letter or digit and continues with those or `-`; `n`
/// has no leading zero. Anything else — a full-width letter, a sign, a
/// trailing newline, an extra segment — is `None`.
pub fn parse_preview_tag(tag: &str) -> Option<(&str, u32)> {
    let rest = tag.strip_prefix("dev/")?;
    let (name, number) = rest.split_once('/')?;
    let name_ok = name
        .bytes()
        .enumerate()
        .all(|(i, b)| b.is_ascii_lowercase() || b.is_ascii_digit() || (i > 0 && b == b'-'));
    if name.is_empty() || !name_ok {
        return None;
    }
    if !is_all_digits(number) || number.starts_with('0') {
        return None;
    }
    let n = number.parse::<u32>().ok()?;
    Some((name, n))
}

/// The build name shown in About, `--print-build-info` (`buildName`) and
/// the GitHub Release title (要件87 契約2): for a preview,
/// `dev-<name> #<n>(<build_time>)` with full-width brackets (U+FF08 /
/// U+FF09), `build_time` being `VELLIS_BUILD_TIME` as is
/// (`YYYY-MM-DD HH:MM JST`). Release and dev builds have no name: `""`.
pub fn build_name(channel: Channel, commit_tag: Option<&str>, build_time: &str) -> String {
    if channel != Channel::Preview {
        return String::new();
    }
    match commit_tag.and_then(parse_preview_tag) {
        Some((name, n)) => format!("dev-{name} #{n}\u{FF08}{build_time}\u{FF09}"),
        None => String::new(),
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
