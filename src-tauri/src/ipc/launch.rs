//! Launch election — decide whether this CLI process becomes the Main Process
//! or hands its request to one (要件#3 追補b・backlog 310).
//!
//! Without this, several `vellis <path>` started at once with no running
//! instance each became a standalone app and wrote the same history files.
//! Now a process becomes the Main Process only by taking the single-instance
//! lock *before* Tauri starts; the others wait for the socket of the one that
//! took it and deliver their request there.

use std::path::Path;
use std::time::{Duration, Instant};

use super::client::{IpcClient, IpcClientError};
use super::lock::FileLock;
use super::protocol::{Request, Response};

/// How long a launch waits for a starting Main Process to open its socket
/// (契約4).
pub const STARTUP_WAIT: Duration = Duration::from_secs(10);

/// How long a launch waits for the Main Process to answer a delivered
/// request (追補c 契約1). A Main that has just started may not run its event
/// loop yet, so this is much longer than `IpcClient::send`'s 500ms.
pub const STARTUP_RESPONSE_WAIT: Duration = Duration::from_secs(10);

/// Interval between attempts while waiting for the socket or the lock.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// What a launch ended up as.
pub enum Launch {
    /// This process took the single-instance lock and must become the Main
    /// Process, keeping the lock for its whole life (契約1・3).
    Main(FileLock),
    /// The request was handed to the running Main Process (契約2).
    Delivered(Response),
}

/// Why a launch could neither become the Main Process nor deliver.
#[derive(Debug, thiserror::Error)]
pub enum LaunchError {
    /// Another process holds the lock but no socket answered within `wait`.
    #[error("another Vellis is starting but did not answer in time")]
    Timeout,
    /// The socket answered the probe but sending the request failed.
    #[error("IPC error: {0}")]
    Ipc(IpcClientError),
    /// The lock file could not be opened or locked.
    #[error("cannot take the single-instance lock: {0}")]
    Lock(std::io::Error),
}

/// Become the Main Process or deliver `request` to it.
///
/// Repeats, every [`POLL_INTERVAL`] until `wait` has passed:
/// 1. If a Main Process answers on `socket_path`, send `request` and return
///    [`Launch::Delivered`] (the lock is never touched).
/// 2. Otherwise try the lock at `lock_path`; if it is taken here, return
///    [`Launch::Main`] with it. A stale socket left by a finished Main is
///    replaced by `IpcServer::start`.
/// 3. Otherwise another process is starting: wait and try again.
pub async fn launch(
    socket_path: &Path,
    lock_path: &Path,
    request: &Request,
    wait: Duration,
) -> Result<Launch, LaunchError> {
    let deadline = Instant::now() + wait;
    loop {
        if IpcClient::probe(socket_path).await {
            return IpcClient::send_with_timeout(socket_path, request, STARTUP_RESPONSE_WAIT)
                .await
                .map(Launch::Delivered)
                .map_err(LaunchError::Ipc);
        }

        if let Some(lock) = FileLock::try_acquire(lock_path).map_err(LaunchError::Lock)? {
            return Ok(Launch::Main(lock));
        }

        let now = Instant::now();
        if now >= deadline {
            return Err(LaunchError::Timeout);
        }
        tokio::time::sleep(POLL_INTERVAL.min(deadline - now)).await;
    }
}
