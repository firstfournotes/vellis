//! SSH / SFTP file provider (Phase 2 P2.1 — minimal read-only).
//!
//! Scope of this module
//! ====================
//! - Connect to `ssh://user@host:port/...` URIs. The URI authority is
//!   resolved through `ssh -G <host>` so that `~/.ssh/config` Host /
//!   Match / Include directives apply (anything `ssh <host>` understands
//!   works for `ssh://<host>/...` URIs). URI explicit fields take
//!   precedence over the resolved values.
//! - Authenticate via **ssh-agent only** (SSH_AUTH_SOCK). The
//!   `IdentityAgent` ssh_config directive is intentionally *not*
//!   honoured in this milestone — its handling is deferred until we
//!   have a robust fallback path between configured agents.
//! - Verify the server key against `~/.ssh/known_hosts`:
//!     * Known host + matching key → accept silently.
//!     * Known host + different key → reject hard (possible MITM).
//!     * Unknown host → trust-on-first-use (TOFU): accept, learn the key,
//!       and emit a warn-level log entry. This matches OpenSSH's default
//!       `StrictHostKeyChecking=accept-new` behaviour.
//! - SFTP-backed `list` / `stat` / `read_bytes`.
//! - Keep one SSH + SFTP connection per `user@host:port` in a
//!   `ConnectionPool` (`super::ssh_pool`). Before a kept connection is handed
//!   out its SSH transport is checked, and a closed one (sleep, network
//!   switch, server-side idle cut) is dropped and opened again. An SFTP
//!   operation that fails with a disconnection error drops the connection it
//!   used, opens a fresh one and runs once more — only once, so an
//!   unreachable host fails fast (要件#5 追補a / backlog 261).
//!
//! Authentication tries every identity ssh-agent offers; if none of those
//! succeeds, falls back to **unencrypted** `IdentityFile` keys read directly
//! from disk (the same files `ssh -G` reports for the host). Encrypted keys
//! are skipped — to use one, load it into the agent (`ssh-add`).
//!
//! `watch()` polls the remote path every two seconds and emits Modify /
//! Remove events when size or mtime changes — the closest equivalent to
//! notify's local FS events given that SFTP has no push notification. Each
//! round takes its connection from the pool afresh rather than holding one,
//! so a dropped connection is opened again by the next round. A round that
//! hits a disconnection emits nothing and keeps the last size / mtime; only
//! an error the server answered (the file is gone) emits Remove.
//!
//! Out of scope (tracked in follow-ups)
//! -----------------------------------
//! - Idle timeout for pooled connections, and concurrent transfers on one
//!   host.
//! - Passphrase prompt for encrypted IdentityFile keys.
//! - `IdentityAgent` ssh_config directive.
//! - `StrictHostKeyChecking=yes|ask` honouring (we default to TOFU).

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use std::future::Future;

use async_trait::async_trait;
use russh::client::{Config as ClientConfig, Handle, Handler};
use russh::keys::agent::client::AgentClient;
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use tracing::warn;

use crate::errors::FsError;

use super::entry::{Entry, FileKind, LinkInfo};
use super::provider::{FileProvider, WatchEvent, WatchEventKind, WatchHandle};
use super::ssh_pool::{ConnectionPool, OpError, PooledConnection};
use super::uri::{Authority, Uri};

/// Monotonic id assigned to every SshProvider watch handle for diagnostics.
static SSH_WATCH_ID: AtomicU64 = AtomicU64::new(1);

/// How often the poll-based watcher re-stats a remote file. SFTP has no
/// inotify-equivalent; the trade-off is latency vs. server load. Two
/// seconds matches the responsiveness expectation for a Markdown viewer
/// while staying well under the per-second SFTP request rate of any
/// reasonable server.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Server-key handler that consults `~/.ssh/known_hosts`.
///
/// - Known host + matching key → accept.
/// - Known host + different key → reject (possible MITM).
/// - Unknown host → TOFU: accept, write the key, warn.
struct KnownHostsVerifier {
    host: String,
    port: u16,
}

impl Handler for KnownHostsVerifier {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        let host = self.host.clone();
        let port = self.port;
        let key = server_public_key.clone();
        let fingerprint = server_public_key.fingerprint(Default::default()).to_string();

        async move {
            // Look up every key recorded for this host:port. We use
            // `known_host_keys` (rather than the boolean `check_known_hosts`)
            // because it lets us distinguish "host not in the file at all"
            // from "host is in the file but the keys don't match" — those
            // need opposite handling.
            let recorded = tokio::task::spawn_blocking({
                let host = host.clone();
                move || russh::keys::known_hosts::known_host_keys(&host, port)
            })
            .await
            .map_err(|e| russh::Error::from(std::io::Error::other(e.to_string())))?;

            let recorded = recorded.unwrap_or_default();

            if recorded.is_empty() {
                // No entries yet for this host — Trust On First Use.
                let learn_host = host.clone();
                let learn_key = key.clone();
                let learn_result = tokio::task::spawn_blocking(move || {
                    russh::keys::known_hosts::learn_known_hosts(
                        &learn_host,
                        port,
                        &learn_key,
                    )
                })
                .await
                .map_err(|e| russh::Error::from(std::io::Error::other(e.to_string())))?;

                match learn_result {
                    Ok(()) => warn!(
                        %host, port, %fingerprint,
                        "added new server key to ~/.ssh/known_hosts (first-time connection)"
                    ),
                    Err(e) => warn!(
                        %host, port, %fingerprint,
                        error = %e,
                        "failed to record server key in ~/.ssh/known_hosts; continuing without persisting it"
                    ),
                }
                return Ok(true);
            }

            // The host is already recorded. Accept iff the presented key
            // matches one of those entries; otherwise refuse — this is the
            // MITM defence. The user can investigate via `ssh-keygen -R
            // <host>` if they intentionally rotated the server key.
            let matches = recorded.iter().any(|(_line, recorded_key)| {
                *recorded_key == key
            });

            if matches {
                Ok(true)
            } else {
                warn!(
                    %host, port, %fingerprint,
                    "server key does not match ~/.ssh/known_hosts — refusing connection (possible MITM)"
                );
                Ok(false)
            }
        }
    }
}

/// Minimal per-authority SSH session state kept alive inside the provider.
///
/// The `russh::client::Handle` is held so that the underlying TCP connection
/// does not get dropped while the `SftpSession` is in use.
struct Session {
    /// The underlying SSH connection. Dropping ends the SFTP channel.
    handle: Handle<KnownHostsVerifier>,
    /// SFTP session reused for every operation on this authority.
    sftp: SftpSession,
}

/// The pool's liveness check: the SSH transport's background task has ended
/// (EOF, reset, disconnect), so nothing sent on this session can arrive.
impl PooledConnection for Session {
    fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }
}

/// SSH / SFTP `FileProvider`.
pub struct SshProvider {
    /// Sessions keyed by `user@host:port`. One session per authority.
    /// Shared with the poll watchers, which take a session every round.
    pool: Arc<ConnectionPool<Session>>,
}

impl SshProvider {
    pub fn new() -> Self {
        Self {
            pool: Arc::new(ConnectionPool::new()),
        }
    }

    /// Open a new SSH + SFTP session to `authority`, authenticating via
    /// ssh-agent.
    async fn open(authority: &Authority) -> Result<Session, FsError> {
        // Defer ssh_config resolution to OpenSSH itself via `ssh -G`. URI
        // explicit fields (port / user) win unconditionally; the alias is
        // only used to look up the underlying hostname when the URI host
        // is not directly resolvable.
        let resolved = ssh_g(&authority.host);

        let host = resolved
            .as_ref()
            .and_then(|c| c.hostname.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| authority.host.clone());
        let port = authority
            .port
            .or_else(|| resolved.as_ref().and_then(|c| c.port))
            .unwrap_or(22);
        let user = authority
            .user
            .clone()
            .or_else(|| resolved.as_ref().and_then(|c| c.user.clone()))
            .or_else(current_username)
            .ok_or_else(|| {
                FsError::PermissionDenied(format!("no user for ssh://{}", host))
            })?;

        let config = Arc::new(ClientConfig::default());
        let handler = KnownHostsVerifier {
            host: host.clone(),
            port,
        };
        let mut handle = russh::client::connect(config, (host.as_str(), port), handler)
            .await
            .map_err(ssh_to_fs)?;

        // Try ssh-agent first, then IdentityFile keys from ~/.ssh/config.
        let mut authenticated =
            try_agent_auth(&mut handle, &user).await?;

        let identity_files = resolved
            .as_ref()
            .map(|c| c.identity_files.clone())
            .unwrap_or_default();
        let mut encrypted_skipped = 0usize;
        if !authenticated {
            authenticated =
                try_identity_files(&mut handle, &user, &identity_files, &mut encrypted_skipped)
                    .await?;
        }

        if !authenticated {
            let mut hint = String::new();
            if encrypted_skipped > 0 {
                hint = format!(
                    " ({} encrypted IdentityFile{} skipped — load with `ssh-add`)",
                    encrypted_skipped,
                    if encrypted_skipped == 1 { "" } else { "s" }
                );
            }
            return Err(FsError::PermissionDenied(format!(
                "no key accepted by {}@{}{}",
                user, host, hint
            )));
        }

        // Open an SFTP subsystem on a new channel.
        let channel = handle.channel_open_session().await.map_err(ssh_to_fs)?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(ssh_to_fs)?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(sftp_to_fs)?;

        Ok(Session { handle, sftp })
    }

    /// Convert an SFTP `FileAttributes` + name into an `Entry`.
    fn attrs_to_entry(
        &self,
        parent_uri: &Uri,
        name: &str,
        attrs: &FileAttributes,
    ) -> Entry {
        let kind = match attrs.file_type() {
            FileType::Dir => FileKind::Dir,
            FileType::Symlink => FileKind::Symlink,
            _ => FileKind::File,
        };
        let entry_path = parent_uri.path.join(name);
        let entry_uri = parent_uri.with_path(&entry_path);
        let modified = attrs
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);
        let size = match kind {
            FileKind::File => attrs.size,
            _ => None,
        };
        Entry {
            uri: entry_uri.raw,
            name: name.to_string(),
            kind,
            size,
            modified,
            link: None,
        }
    }
}

impl Default for SshProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl FileProvider for SshProvider {
    fn scheme(&self) -> &'static str {
        "ssh"
    }

    /// SSH roots stay read-only in this first cut (要件#48 契約①).
    ///
    /// SFTP could write, but the guarantees the local path gives — an atomic
    /// tmp+rename on one filesystem, and a `SnapshotManager` copy taken under
    /// `<root>/.vellis/` before the write — have no equivalent here yet, and a
    /// save that can half-succeed over a dropped connection is worse than no
    /// save at all. Refused without touching the network, so no connection is
    /// attempted and no error is ambiguous.
    ///
    /// Stated explicitly rather than inherited from the trait default: whether
    /// a provider writes is part of its contract, not something to read by
    /// absence. The frontend refuses earlier still (`canEnterEdit` keeps `ssh://`
    /// documents out of edit mode), so this is the backstop.
    async fn write_text(&self, uri: &str, _content: &str) -> Result<(), FsError> {
        Err(FsError::Unsupported(format!(
            "writing to SSH roots is unsupported: {uri}"
        )))
    }

    async fn list(&self, uri: &Uri) -> Result<Vec<Entry>, FsError> {
        let authority = uri
            .authority
            .as_ref()
            .ok_or_else(|| FsError::NotFound(uri.raw.clone()))?;
        let dir = path_to_string(&uri.path)?;
        let dir = dir.as_str();
        let key = authority.to_string();

        let entries_iter = self
            .pool
            .run(&key, || Self::open(authority), |session| async move {
                session.sftp.read_dir(dir).await.map_err(classify_sftp_error)
            })
            .await?;
        let mut out: Vec<Entry> = Vec::new();
        for entry in entries_iter {
            let name = entry.file_name();
            // Hidden names are listed; the exclude settings hide them (要件#65 契約2).
            if name == "." || name == ".." {
                continue;
            }
            let attrs = entry.metadata();
            let kind = match attrs.file_type() {
                FileType::Dir => FileKind::Dir,
                FileType::Symlink => FileKind::Symlink,
                // Every regular file is listed, regardless of extension.
                FileType::File => FileKind::File,
                _ => continue,
            };
            let entry_path = uri.path.join(&name);
            let entry_uri = uri.with_path(&entry_path);
            let modified = attrs
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64);
            let size = if kind == FileKind::File { attrs.size } else { None };
            // The listing's attributes are lstat-like, so a link shows up as
            // Symlink whatever it points at. Mark it without extra round trips:
            // target and reachability stay unknown over ssh (要件#70 判断 (f)).
            let link = (kind == FileKind::Symlink).then_some(LinkInfo {
                target: None,
                broken: false,
            });
            out.push(Entry {
                uri: entry_uri.raw,
                name,
                kind,
                size,
                modified,
                link,
            });
        }
        // Directories first, then alphabetical — matches LocalProvider order.
        out.sort_by(|a, b| {
            let dir_ord = |k: &FileKind| if *k == FileKind::Dir { 0 } else { 1 };
            dir_ord(&a.kind)
                .cmp(&dir_ord(&b.kind))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    }

    async fn stat(&self, uri: &Uri) -> Result<Entry, FsError> {
        let authority = uri
            .authority
            .as_ref()
            .ok_or_else(|| FsError::NotFound(uri.raw.clone()))?;
        let path = path_to_string(&uri.path)?;
        let path = path.as_str();
        let key = authority.to_string();

        let attrs = self
            .pool
            .run(&key, || Self::open(authority), |session| async move {
                session.sftp.metadata(path).await.map_err(classify_sftp_error)
            })
            .await?;
        let parent = uri.parent().unwrap_or_else(|| uri.clone());
        let name = uri
            .path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        Ok(self.attrs_to_entry(&parent, &name, &attrs))
    }

    async fn read_bytes(&self, uri: &Uri) -> Result<Vec<u8>, FsError> {
        let authority = uri
            .authority
            .as_ref()
            .ok_or_else(|| FsError::NotFound(uri.raw.clone()))?;
        let path = path_to_string(&uri.path)?;
        let path = path.as_str();
        let key = authority.to_string();

        // The whole open + read is one operation: a connection that drops
        // mid-read is retried from the open on a fresh connection.
        let buf = self
            .pool
            .run(&key, || Self::open(authority), |session| async move {
                let mut file = session
                    .sftp
                    .open_with_flags(path, OpenFlags::READ)
                    .await
                    .map_err(classify_sftp_error)?;
                let mut buf = Vec::new();
                file.read_to_end(&mut buf).await.map_err(classify_io_error)?;
                Ok(buf)
            })
            .await?;
        Ok(buf)
    }

    /// Poll the remote path every `POLL_INTERVAL` and emit `Modify` /
    /// `Remove` events when the size or mtime changes. Dropping the
    /// returned `WatchHandle` ends the polling task.
    ///
    /// No connection is taken here: the polling task takes one from the
    /// pool every round, so a host that is unreachable right now is picked
    /// up from the first round it answers.
    async fn watch(
        &self,
        uri: &Uri,
        tx: mpsc::Sender<WatchEvent>,
    ) -> Result<WatchHandle, FsError> {
        let authority = uri
            .authority
            .as_ref()
            .ok_or_else(|| FsError::NotFound(uri.raw.clone()))?;
        let path = path_to_string(&uri.path)?;
        let uri_raw = uri.raw.clone();

        // `oneshot::Sender` doubles as a "stop" signal: when the
        // WatchHandle is dropped, this Sender drops too, the receiver
        // gets a closed-channel error in the select!, and the task
        // terminates.
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();

        tokio::spawn(poll_loop(
            self.pool.clone(),
            authority.clone(),
            path,
            uri_raw,
            tx,
            stop_rx,
        ));

        let id = SSH_WATCH_ID.fetch_add(1, Ordering::Relaxed);
        tracing::debug!(id, host = %authority.host, "started ssh poll watch");
        Ok(WatchHandle::new(id, stop_tx))
    }
}

/// Size and mtime of a watched remote file, as one poll round sees it.
pub type PollSnapshot = (Option<u64>, Option<SystemTime>);

/// Decide one poll round (要件#5 追補a 契約5): given the last snapshot and
/// this round's stat outcome, return the event to send (if any) and the
/// snapshot to remember.
///
/// - A snapshot that differs from the last one → `Modify`. The first one, or
///   an unchanged one, sends nothing.
/// - An error the server answered (`OpError::Failed` — the file is gone) →
///   `Remove`, once per disappearance: the snapshot is forgotten, so further
///   failures stay silent until the file reappears.
/// - A disconnection (including a connection that could not be reopened) →
///   nothing, and the last snapshot is kept so a change made while the
///   connection was down shows up as `Modify` once it is back.
pub fn poll_step(
    prev: Option<PollSnapshot>,
    outcome: Result<PollSnapshot, OpError>,
) -> (Option<WatchEventKind>, Option<PollSnapshot>) {
    match outcome {
        Ok(snapshot) => {
            let event = match prev {
                Some(prev) if prev != snapshot => Some(WatchEventKind::Modify),
                _ => None,
            };
            (event, Some(snapshot))
        }
        Err(e) if e.is_disconnected() => (None, prev),
        Err(_) => (prev.map(|_| WatchEventKind::Remove), None),
    }
}

/// Polling task body. Every `POLL_INTERVAL` takes the session for
/// `authority` from `pool` (reopening a dropped one), re-stats `path` and
/// forwards whatever `poll_step` decides to `tx`. Exits cleanly when
/// `stop_rx` errors (paired Sender dropped) or when the event channel is
/// closed.
async fn poll_loop(
    pool: Arc<ConnectionPool<Session>>,
    authority: Authority,
    path: String,
    uri_raw: String,
    tx: mpsc::Sender<WatchEvent>,
    mut stop_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let key = authority.to_string();
    let path = path.as_str();
    let mut last: Option<PollSnapshot> = None;
    loop {
        tokio::select! {
            _ = &mut stop_rx => {
                tracing::debug!("ssh poll watch stopped");
                return;
            }
            _ = tokio::time::sleep(POLL_INTERVAL) => {}
        }

        let outcome = pool
            .run(&key, || SshProvider::open(&authority), |session| async move {
                let attrs = session.sftp.metadata(path).await.map_err(classify_sftp_error)?;
                Ok((attrs.size, attrs.modified().ok()))
            })
            .await;
        let (event, next) = poll_step(last, outcome);
        last = next;
        if let Some(kind) = event {
            if tx
                .send(WatchEvent {
                    kind,
                    uri: uri_raw.clone(),
                })
                .await
                .is_err()
            {
                return;
            }
        }
    }
}

fn path_to_string(path: &PathBuf) -> Result<String, FsError> {
    path.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| FsError::NotFound(format!("non-UTF-8 path: {}", path.display())))
}

fn current_username() -> Option<String> {
    std::env::var("USER").ok().or_else(|| std::env::var("LOGNAME").ok())
}

/// Subset of `ssh -G <alias>` output that we currently consume.
struct SshConfigResolution {
    hostname: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    identity_files: Vec<PathBuf>,
}

/// Invoke `ssh -G <alias>` and parse the keys we care about. Returns
/// `None` when `ssh` is not on PATH or the command fails — the caller
/// will then treat the URI host as a literal hostname.
///
/// The `IdentityAgent` directive is intentionally *not* parsed: when set,
/// it can redirect the agent connection to a socket that lives outside
/// `$SSH_AUTH_SOCK`, and that socket may have no identities loaded even
/// though the user's interactive shell agent does. We instead always use
/// `$SSH_AUTH_SOCK` for now and tackle `IdentityAgent` with a proper
/// fallback path in a separate milestone.
fn ssh_g(alias: &str) -> Option<SshConfigResolution> {
    let output = std::process::Command::new("ssh")
        .arg("-G")
        .arg(alias)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = std::str::from_utf8(&output.stdout).ok()?;

    let mut hostname = None;
    let mut user = None;
    let mut port = None;
    let mut identity_files: Vec<PathBuf> = Vec::new();
    for line in text.lines() {
        let mut it = line.splitn(2, char::is_whitespace);
        let (Some(key), Some(val)) = (it.next(), it.next()) else {
            continue;
        };
        let val = val.trim().to_string();
        if val.is_empty() {
            continue;
        }
        match key {
            "hostname" => hostname = Some(val),
            "user" => user = Some(val),
            "port" => port = val.parse::<u16>().ok(),
            "identityfile" => {
                if let Some(p) = expand_home(&val) {
                    identity_files.push(p);
                }
            }
            _ => {}
        }
    }

    Some(SshConfigResolution {
        hostname,
        user,
        port,
        identity_files,
    })
}

/// Expand a leading `~` against `$HOME`. Returns `None` if `$HOME` is unset
/// and the path needs expansion. Bare `~` becomes `$HOME`.
fn expand_home(path: &str) -> Option<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let home_var = || std::env::var_os("HOME").or_else(|| dirs::home_dir().map(Into::into));
    if trimmed == "~" {
        return home_var().map(PathBuf::from);
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        let home = home_var()?;
        return Some(PathBuf::from(home).join(rest));
    }
    Some(PathBuf::from(trimmed))
}

/// Hash algorithms tried in order. Modern OpenSSH servers reject SHA-1
/// (`ssh-rsa`) by default, so we offer rsa-sha2-512 and rsa-sha2-256 first
/// for RSA keys; for ed25519/ECDSA the hash arg is ignored.
const HASH_ALGS: &[Option<HashAlg>] =
    &[Some(HashAlg::Sha512), Some(HashAlg::Sha256), None];

/// Try every identity advertised by ssh-agent. Returns `Ok(true)` on first
/// success. Missing or empty agent → `Ok(false)` (caller can still try
/// IdentityFile fallback).
async fn try_agent_auth(
    handle: &mut Handle<KnownHostsVerifier>,
    user: &str,
) -> Result<bool, FsError> {
    let mut agent = match AgentClient::connect_env().await {
        Ok(a) => a,
        Err(_) => return Ok(false),
    };
    let identities = match agent.request_identities().await {
        Ok(v) => v,
        Err(_) => return Ok(false),
    };
    for key in identities {
        for &hash_alg in HASH_ALGS {
            let auth = handle
                .authenticate_publickey_with(user, key.clone(), hash_alg, &mut agent)
                .await
                .map_err(|e| {
                    FsError::PermissionDenied(format!("ssh-agent auth: {}", e))
                })?;
            if auth.success() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Try every IdentityFile (in order) read directly from disk. Encrypted
/// keys are skipped — the caller is told via `encrypted_skipped` so it can
/// nudge the user toward `ssh-add`.
async fn try_identity_files(
    handle: &mut Handle<KnownHostsVerifier>,
    user: &str,
    files: &[PathBuf],
    encrypted_skipped: &mut usize,
) -> Result<bool, FsError> {
    for path in files {
        let contents = match tokio::fs::read_to_string(path).await {
            Ok(s) => s,
            Err(_) => continue, // file missing or unreadable
        };
        let key = match PrivateKey::from_openssh(&contents) {
            Ok(k) => k,
            Err(_) => continue, // not an OpenSSH-format private key
        };
        if key.is_encrypted() {
            *encrypted_skipped += 1;
            warn!(
                path = %path.display(),
                "skipping encrypted IdentityFile — load it with `ssh-add` or use an unencrypted key"
            );
            continue;
        }
        let arc = Arc::new(key);
        for &hash_alg in HASH_ALGS {
            let pk = PrivateKeyWithHashAlg::new(arc.clone(), hash_alg);
            let auth = handle
                .authenticate_publickey(user, pk)
                .await
                .map_err(|e| {
                    FsError::PermissionDenied(format!(
                        "identity file {} auth: {}",
                        path.display(),
                        e
                    ))
                })?;
            if auth.success() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn ssh_to_fs(e: russh::Error) -> FsError {
    match e {
        russh::Error::IO(io) => FsError::Io(io),
        other => FsError::PermissionDenied(format!("ssh: {}", other)),
    }
}

/// Sort an SFTP error into a disconnection (retried once on a fresh
/// connection) or a failure to return as is (要件#5 追補a 契約3). The
/// `FsError` inside is the `sftp_to_fs` mapping either way, so messages are
/// unchanged.
///
/// - Disconnection: `UnexpectedBehavior` (`session closed`, `recv none
///   message`, a failed send / receive on the channel), `Timeout`, `IO`.
/// - Not a disconnection: `Status` (the server answered — not found,
///   permission denied, failure), `Limited`, `UnexpectedPacket`.
pub fn classify_sftp_error(e: russh_sftp::client::error::Error) -> OpError {
    use russh_sftp::client::error::Error;
    match &e {
        Error::UnexpectedBehavior(_) | Error::Timeout | Error::IO(_) => {
            OpError::Disconnected(sftp_to_fs(e))
        }
        Error::Status(_) | Error::Limited(_) | Error::UnexpectedPacket => {
            OpError::Failed(sftp_to_fs(e))
        }
    }
}

/// An I/O error while reading an opened remote file (`read_to_end`) means the
/// channel broke mid-transfer: a disconnection.
pub fn classify_io_error(e: std::io::Error) -> OpError {
    OpError::Disconnected(FsError::Io(e))
}

fn sftp_to_fs(e: russh_sftp::client::error::Error) -> FsError {
    use russh_sftp::protocol::StatusCode;
    match &e {
        russh_sftp::client::error::Error::Status(status) => match status.status_code {
            StatusCode::NoSuchFile => FsError::NotFound(status.error_message.clone()),
            // SFTP servers vary in what status they return for a missing
            // path: OpenSSH on Linux uses `NoSuchFile`, but several
            // implementations (notably macOS sftp-server in some
            // configurations) return the generic `Failure` code with the
            // human message "Failure". For a read-only viewer the safe
            // mapping is NotFound — the caller (asset handler, set_root,
            // open_document) all have a 404-like recovery path, while the
            // alternative `Io` mapping leaks an "I/O error: Failure:
            // Failure" message into the webview console.
            StatusCode::Failure => FsError::NotFound(status.error_message.clone()),
            StatusCode::PermissionDenied => FsError::PermissionDenied(status.error_message.clone()),
            _ => FsError::Io(std::io::Error::other(status.error_message.clone())),
        },
        _ => FsError::Io(std::io::Error::other(e.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scheme_is_ssh() {
        let p = SshProvider::new();
        assert_eq!(p.scheme(), "ssh");
    }

    #[test]
    fn current_username_non_empty_when_logged_in() {
        // On the runner at least one of USER / LOGNAME is typically set.
        if std::env::var("USER").is_ok() || std::env::var("LOGNAME").is_ok() {
            let name = current_username();
            assert!(name.is_some());
            assert!(!name.unwrap().is_empty());
        }
    }
}
