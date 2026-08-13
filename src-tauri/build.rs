use std::process::Command;

// Channel derivation is shared verbatim with the library (which `mod`s the
// same file for unit tests). build scripts cannot depend on the crate they
// build, so it is `include!`d rather than imported. std-only by contract.
include!("src/channel.rs");

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|s| !s.is_empty())
}

fn main() {
    // Channel (feature-flags.md §3.2): positive-signal — anchored release
    // tag ∧ CI context var. `git dirty` is deliberately NOT an input.
    let channel = derive_channel(
        env_opt("CI_COMMIT_TAG").as_deref(),
        env_opt("GITLAB_CI").as_deref(),
        env_opt("CI_PIPELINE_ID").as_deref(),
    );
    println!("cargo:rustc-env=VELLIS_CHANNEL={}", channel.as_str());

    let sha = git_short_sha().unwrap_or_else(|| "unknown".into());
    let dirty = git_is_dirty();
    let sha_marker = if dirty {
        format!("{}-dirty", sha)
    } else {
        sha
    };

    // Format chosen to remain readable when wrapped by macOS About dialog
    // as `<short_version> (<version>)` — using inner parens here would
    // produce nested `( ... ( ... ) )`.
    let build_number = match std::env::var("CI_PIPELINE_ID") {
        Ok(id) if !id.is_empty() => format!("{} {}", id, sha_marker),
        _ => format!("local {}", sha_marker),
    };

    let jst = chrono::FixedOffset::east_opt(9 * 3600).expect("valid offset");
    let now = chrono::Utc::now().with_timezone(&jst);
    let build_time = now.format("%Y-%m-%d %H:%M JST").to_string();

    println!("cargo:rustc-env=VELLIS_BUILD_NUMBER={}", build_number);
    println!("cargo:rustc-env=VELLIS_BUILD_TIME={}", build_time);

    // Re-run when ANY channel input changes (R2-B / impl NEW-A): omitting
    // CI_COMMIT_TAG or GITLAB_CI would let a cache-reusing runner bake a
    // stale channel into a signed release.
    println!("cargo:rerun-if-env-changed=CI_COMMIT_TAG");
    println!("cargo:rerun-if-env-changed=GITLAB_CI");
    println!("cargo:rerun-if-env-changed=CI_PIPELINE_ID");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    println!("cargo:rerun-if-changed=../.git/index");
    println!("cargo:rerun-if-changed=src/channel.rs");

    tauri_build::build()
}

fn git_short_sha() -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn git_is_dirty() -> bool {
    Command::new("git")
        .args(["status", "--porcelain"])
        .output()
        .ok()
        .map(|out| !out.stdout.is_empty())
        .unwrap_or(false)
}
