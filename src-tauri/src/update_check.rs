//! New-release notification (requirements.md #14).
//!
//! Asks GitHub for the latest published release, compares its tag against
//! `CARGO_PKG_VERSION` and — only when the remote is strictly newer — tells
//! every window about it.  The app never applies the update: the banner's
//! "ダウンロード" button hands the Releases page to the default browser.
//!
//! The shape follows the house style of `history.rs`: the decisions live in
//! small pure functions (`is_newer`, `should_check`, `channel_allows_check`,
//! `parse_latest_release`) that take everything they need as arguments, and
//! the store takes its file path by injection and never fails a read.  What
//! is left over — the HTTP call, the poller, the emit — is the only part
//! that touches the network, the clock or the `AppHandle`.
//!
//! Everything here is deliberately *fail open* (`docs/update-notification.md`
//! §7): a timeout, an unreachable host, an HTTP error, an unparsable body or
//! a corrupted store degrades to a `warn!` line.  Nothing reaches the UI and
//! nothing can keep the app from starting.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};
use thiserror::Error;

use crate::channel::Channel;

/// Re-check interval: 6 hours, as seconds.
pub const CHECK_INTERVAL_SECS: i64 = 6 * 60 * 60;

/// Filename used inside the app config directory.
pub const LAST_CHECK_FILENAME: &str = "update-check.json";

/// Event delivered to every window when a newer release exists.
pub const UPDATE_AVAILABLE_EVENT: &str = "update_available";

/// The single endpoint this module talks to.  `releases/latest` already
/// excludes drafts and pre-releases on the GitHub side.
///
/// This is the *public* release repository, not the development one: the
/// check runs unauthenticated, and `product-vellis` stays private and so
/// answers 404 to it (`docs/publishing.md` §9).
pub const LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/firstfournotes/vellis/releases/latest";

/// Whole-request budget.  Short on purpose: nothing in the app waits for
/// this, so a hung connection should be abandoned rather than retried late.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// GitHub rejects API requests without a User-Agent.
const USER_AGENT: &str = concat!("Vellis/", env!("CARGO_PKG_VERSION"));

/// Delay before the launch check so the WebView has mounted and registered
/// its `update_available` listener.  Tauri events are not buffered — an emit
/// that lands before the listener exists is simply lost.
const STARTUP_DELAY: Duration = Duration::from_secs(5);

/// How often the poller wakes up to *evaluate* [`should_check`].  This is
/// not the check interval: the decision is made against wall-clock time, so
/// a machine that slept through several intervals checks once on the first
/// tick after it wakes (a 6-hour `sleep` would instead fire 6 hours *of
/// uptime* later, i.e. long after the user is back).
const POLL_TICK: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Error)]
pub enum UpdateCheckError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("release has an empty tag_name")]
    EmptyTagName,
}

// ---------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------

/// `true` only when `remote_tag` is a strictly newer `x.y.z` than `current`.
///
/// A leading `v` on either side is dropped; everything else has to be three
/// all-digit components.  Anything that does not parse — two components, a
/// pre-release suffix, an empty string — is *not* newer, so a tag scheme we
/// do not understand can never produce a notification.
pub fn is_newer(remote_tag: &str, current: &str) -> bool {
    match (parse_version(remote_tag), parse_version(current)) {
        (Some(remote), Some(current)) => remote > current,
        _ => false,
    }
}

/// `major.minor.patch` as numbers, or `None` when the string is not exactly
/// that (after an optional `v`).  Digits only: `u64::from_str` would also
/// accept `+5`, and the components have to compare as numbers — a string
/// compare puts `0.1.10` *below* `0.1.9`.
fn parse_version(raw: &str) -> Option<(u64, u64, u64)> {
    let rest = raw.strip_prefix('v').unwrap_or(raw);
    let mut parts = rest.split('.');
    let (Some(major), Some(minor), Some(patch), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    Some((
        parse_component(major)?,
        parse_component(minor)?,
        parse_component(patch)?,
    ))
}

fn parse_component(s: &str) -> Option<u64> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// Whether a check is due, given the persisted last check (`None` = never)
/// and the current wall-clock time, both in unix seconds.
///
/// Time is an argument rather than a reading so the rule stays testable and
/// so sleep/resume needs no special case: waking up after eight hours is
/// just a `now` that moved a long way.  A clock that went *backwards* has
/// not elapsed anything and waits.
pub fn should_check(last_check_unix: Option<i64>, now_unix: i64) -> bool {
    match last_check_unix {
        None => true,
        Some(last) => now_unix.saturating_sub(last) >= CHECK_INTERVAL_SECS,
    }
}

/// Dev builds never call out.  The check is on by default with no opt-out
/// (`docs/update-notification.md` §6-Q6), so this channel guard is what
/// keeps development and test runs off the network.
pub fn channel_allows_check(channel: Channel) -> bool {
    match channel {
        Channel::Release => true,
        Channel::Dev => false,
    }
}

// ---------------------------------------------------------------------------
// releases/latest
// ---------------------------------------------------------------------------

/// The two fields of a release the notification needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseInfo {
    /// Verbatim tag (`v0.1.22`) — stripping the `v` is [`is_newer`]'s job.
    pub tag_name: String,
    /// Release page, i.e. what the "ダウンロード" button opens.
    pub html_url: String,
}

/// Deserialization view of the response.  Only these two fields are named,
/// so the couple of dozen others GitHub sends (and any it adds later) are
/// ignored rather than fatal.
#[derive(Deserialize)]
struct LatestRelease {
    tag_name: String,
    #[serde(default)]
    html_url: String,
}

/// Read `tag_name` / `html_url` out of a `releases/latest` body.
///
/// Every malformed shape is an `Err`: a missing or empty `tag_name`, a body
/// that is not a JSON object, a truncated response.  Callers log and move
/// on, so a bad response is indistinguishable from no response.
pub fn parse_latest_release(body: &str) -> Result<ReleaseInfo, UpdateCheckError> {
    let release: LatestRelease = serde_json::from_str(body)?;
    if release.tag_name.is_empty() {
        return Err(UpdateCheckError::EmptyTagName);
    }
    Ok(ReleaseInfo {
        tag_name: release.tag_name,
        html_url: release.html_url,
    })
}

/// Fetch and parse the latest release.
///
/// Bounded by [`REQUEST_TIMEOUT`] end to end and sent with a User-Agent
/// (GitHub answers `403` without one).  Nothing is sent beyond the request
/// itself — no identifier, no usage data.
async fn fetch_latest_release() -> Result<ReleaseInfo, UpdateCheckError> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()?;
    let body = client
        .get(LATEST_RELEASE_URL)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    parse_latest_release(&body)
}

// ---------------------------------------------------------------------------
// Last-check store
// ---------------------------------------------------------------------------

/// On-disk shape.  A named object rather than a bare number so a later field
/// (a skipped version, say) does not need a format migration.
#[derive(Serialize, Deserialize)]
struct LastCheckFile {
    last_check_unix: i64,
}

/// Persists the one piece of state the check has: when it last ran.
pub struct LastCheckStore {
    file: PathBuf,
}

impl LastCheckStore {
    /// Bind a store to `file`.  Neither the file nor its parent directory
    /// need to exist — creation is deferred to [`Self::set_last_check`].
    pub fn new(file: &Path) -> Self {
        Self {
            file: file.to_path_buf(),
        }
    }

    /// Last check time in unix seconds, or `None` for "never checked".
    ///
    /// A missing file (first launch) and an unreadable one both read as
    /// never-checked, which [`should_check`] turns into "check now" — the
    /// failure direction that keeps notifications working.
    pub fn last_check(&self) -> Option<i64> {
        let raw = match fs::read_to_string(&self.file) {
            Ok(raw) => raw,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return None,
            Err(e) => {
                tracing::warn!("update check: cannot read {}: {}", self.file.display(), e);
                return None;
            }
        };
        match serde_json::from_str::<LastCheckFile>(&raw) {
            Ok(parsed) => Some(parsed.last_check_unix),
            Err(e) => {
                tracing::warn!(
                    "update check: ignoring unreadable store {}: {}",
                    self.file.display(),
                    e
                );
                None
            }
        }
    }

    /// Record `unix_secs` as the last check, creating the parent directory
    /// on demand.  Atomic write (tmp → rename), as in `history.rs`.
    pub fn set_last_check(&self, unix_secs: i64) -> Result<(), UpdateCheckError> {
        if let Some(parent) = self.file.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        let tmp_path = self.file.with_extension("json.tmp");
        let body = serde_json::to_string(&LastCheckFile {
            last_check_unix: unix_secs,
        })?;
        let mut file = fs::File::create(&tmp_path)?;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp_path, &self.file)?;
        Ok(())
    }
}

/// Default store file: `<app config dir>/update-check.json`, the same
/// app-managed location `history.rs` writes to.
pub fn default_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    match app.path().app_config_dir() {
        Ok(dir) => Some(dir.join(LAST_CHECK_FILENAME)),
        Err(e) => {
            tracing::warn!("update check: no app config dir available: {}", e);
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

/// What a window receives with [`UPDATE_AVAILABLE_EVENT`].  `version` is the
/// bare `x.y.z` so the banner can spell it the way the status bar does
/// (`v{version}`); `url` is the release page.
#[derive(Clone, Debug, Serialize)]
struct UpdateAvailablePayload {
    version: String,
    url: String,
}

/// Start the update-check poller: one check shortly after launch, then a
/// re-evaluation every [`POLL_TICK`] that runs a check whenever six hours
/// have passed.  A single Vellis process owns every window (flock), so this
/// one task covers the whole app.
///
/// Does nothing on the dev channel.
pub fn spawn_poller<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    if !channel_allows_check(crate::features::current_channel()) {
        tracing::info!("update check: skipped (dev channel)");
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_DELAY).await;
        loop {
            check_once(&app).await;
            tokio::time::sleep(POLL_TICK).await;
        }
    });
}

/// One pass: is a check due, and if so does the answer mean a newer release?
async fn check_once<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(path) = default_path(app) else {
        return;
    };
    let store = LastCheckStore::new(&path);
    let now = now_unix();
    if !should_check(store.last_check(), now) {
        return;
    }

    // Stamped before the request, not after: an offline machine should back
    // off for the normal interval rather than retry every tick, and the
    // contract counts time from the last *check*, not the last success.
    if let Err(e) = store.set_last_check(now) {
        tracing::warn!("update check: cannot persist last-check time: {}", e);
    }

    let info = match fetch_latest_release().await {
        Ok(info) => info,
        Err(e) => {
            // Fail open: offline, timed out, rate-limited or malformed all
            // land here and the user sees nothing.
            tracing::warn!("update check: {}", e);
            return;
        }
    };

    let current = env!("CARGO_PKG_VERSION");
    if !is_newer(&info.tag_name, current) {
        tracing::info!(
            "update check: {} is not newer than {}",
            info.tag_name,
            current
        );
        return;
    }

    let payload = UpdateAvailablePayload {
        version: info
            .tag_name
            .strip_prefix('v')
            .unwrap_or(&info.tag_name)
            .to_string(),
        url: info.html_url,
    };
    tracing::info!("update check: {} available", payload.version);
    // `emit` (not `emit_to`) reaches every window, as `watch/hub.rs` does —
    // each one shows and dismisses its own banner.
    if let Err(e) = app.emit(UPDATE_AVAILABLE_EVENT, payload) {
        tracing::warn!(
            "update check: cannot emit {}: {}",
            UPDATE_AVAILABLE_EVENT,
            e
        );
    }
}

/// Wall-clock seconds since the unix epoch (0 if the clock predates it).
fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
