//! Per-host connection pool for the SSH provider (要件#5 追補a / backlog 261).
//!
//! `SshProvider` keeps one connection per `user@host:port`. A kept connection
//! can die underneath us — the Mac sleeps, the network switches, the server
//! cuts an idle session — and until this pool existed the provider handed the
//! dead connection out for the rest of the app's life. The pool closes that
//! gap two ways:
//!
//! - **Liveness check before handing out** (`get`): a kept connection whose
//!   transport has closed is dropped and opened again.
//! - **One retry on a disconnection** (`run`): an operation that fails with
//!   `OpError::Disconnected` drops the connection it used, opens a fresh one
//!   and runs once more. Never more than once, so an unreachable host fails
//!   fast instead of looping.
//! - **One open per host at a time** (`get`, 要件#5 追補c / Issue #628):
//!   callers that need a key while it is being opened wait for that open and
//!   share its connection or its failure, so a dropped host is not
//!   authenticated against once per open file and folder.
//!
//! The pool is generic over the connection type so the policy can be tested
//! with fakes; `ssh.rs` plugs in its `Session`.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};

use tokio::sync::watch;

use crate::errors::FsError;

/// A connection the pool can keep. `is_closed` reports whether the
/// underlying transport has gone away (for SSH: `Handle::is_closed()`).
pub trait PooledConnection: Send + Sync + 'static {
    fn is_closed(&self) -> bool;
}

/// How an operation on a pooled connection failed.
///
/// - `Disconnected`: the connection is gone (or could not be opened at all).
///   `run` retries this once on a fresh connection, and the poll watcher
///   keeps its last state instead of reporting the file as removed.
/// - `Failed`: anything else — typically an error the server answered (not
///   found, permission denied). Returned as is, without a retry.
///
/// Either way the inner `FsError` is what the caller sees.
#[derive(Debug)]
pub enum OpError {
    Disconnected(FsError),
    Failed(FsError),
}

impl OpError {
    pub fn is_disconnected(&self) -> bool {
        matches!(self, OpError::Disconnected(_))
    }

    pub fn into_fs(self) -> FsError {
        match self {
            OpError::Disconnected(e) | OpError::Failed(e) => e,
        }
    }
}

impl From<OpError> for FsError {
    fn from(e: OpError) -> Self {
        e.into_fs()
    }
}

/// What the pool holds for one key: a kept connection, or an open in
/// progress whose outcome every caller that arrives meanwhile waits for
/// (要件#5 追補c 契約2).
enum Slot<C> {
    Ready(Arc<C>),
    Opening {
        /// Tells this open apart from a later one for the same key, so an
        /// abandoned open only clears its own slot.
        id: u64,
        /// `None` until the open finishes; then the connection, or the
        /// failure every waiter receives a copy of.
        outcome: watch::Receiver<Option<OpenOutcome<C>>>,
    },
}

type OpenOutcome<C> = Result<Arc<C>, Arc<FsError>>;

/// One connection per key, shared by every caller.
///
/// The lock is only held to look up / swap entries — never while a
/// connection is being opened (an SSH open resolves `ssh -G`, connects and
/// authenticates), so a slow host does not stall operations on other hosts.
/// Callers that ask for a key while it is being opened wait for that open
/// instead of starting their own, so a host that dropped every watcher's
/// connection at once is opened again once, not once per watcher
/// (要件#5 追補c 契約2).
pub struct ConnectionPool<C> {
    slots: StdMutex<HashMap<String, Slot<C>>>,
    next_open_id: AtomicU64,
}

impl<C: PooledConnection> ConnectionPool<C> {
    pub fn new() -> Self {
        Self {
            slots: StdMutex::new(HashMap::new()),
            next_open_id: AtomicU64::new(1),
        }
    }

    fn slots(&self) -> MutexGuard<'_, HashMap<String, Slot<C>>> {
        lock_slots(&self.slots)
    }

    /// Hand out the connection kept for `key`, opening one with `open` when
    /// there is none or the kept one has closed (the closed one is dropped
    /// from the pool first). An `open` failure is returned as is and nothing
    /// is kept, so the next caller opens afresh.
    ///
    /// Only one `open` runs per key at a time (要件#5 追補c 契約2): a caller
    /// that arrives while another one is opening `key` does not call `open`
    /// but waits for that open and receives the same connection, or a copy
    /// of the same failure. Other keys never wait on it. If the opening
    /// caller is cancelled before it finishes, its waiters start over.
    pub async fn get<F, Fut>(&self, key: &str, open: F) -> Result<Arc<C>, FsError>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = Result<C, FsError>>,
    {
        loop {
            // Decide under the lock; wait or open after it is released.
            let found = {
                let mut slots = self.slots();
                match slots.get(key) {
                    Some(Slot::Ready(conn)) if !conn.is_closed() => return Ok(conn.clone()),
                    Some(Slot::Opening { outcome, .. }) => Err(outcome.clone()),
                    // Nothing kept, or the kept connection has closed.
                    _ => {
                        let id = self.next_open_id.fetch_add(1, Ordering::Relaxed);
                        let (tx, rx) = watch::channel(None);
                        slots.insert(key.to_string(), Slot::Opening { id, outcome: rx });
                        Ok((id, tx))
                    }
                }
            };
            let (id, tx) = match found {
                Ok(opener) => opener,
                Err(mut outcome) => match Self::wait_for_open(&mut outcome).await {
                    Some(result) => return result,
                    // The opener was cancelled before it finished: look again.
                    None => continue,
                },
            };

            // Clears the `Opening` slot if this future is dropped mid-open,
            // so the key does not stay "being opened" forever.
            let _abandoned = AbandonedOpen {
                slots: &self.slots,
                key,
                id,
            };
            let result = open().await.map(Arc::new);
            {
                let mut slots = self.slots();
                match &result {
                    Ok(conn) => {
                        slots.insert(key.to_string(), Slot::Ready(conn.clone()));
                    }
                    Err(_) => {
                        slots.remove(key);
                    }
                }
            }
            let shared = match &result {
                Ok(conn) => Ok(conn.clone()),
                Err(e) => Err(Arc::new(copy_fs_error(e))),
            };
            // No receiver left just means nobody was waiting.
            let _ = tx.send(Some(shared));
            return result;
        }
    }

    /// Wait for the open another caller is running. `None` when that caller
    /// went away without finishing.
    async fn wait_for_open(
        outcome: &mut watch::Receiver<Option<OpenOutcome<C>>>,
    ) -> Option<Result<Arc<C>, FsError>> {
        let done = outcome.wait_for(Option::is_some).await.ok()?;
        match done.as_ref()? {
            Ok(conn) => Some(Ok(conn.clone())),
            Err(e) => Some(Err(copy_fs_error(e))),
        }
    }

    /// Drop the connection kept for `key`, but only if it is `used` itself.
    /// A connection another caller has already put in its place stays.
    /// Returns whether anything was dropped.
    pub async fn discard(&self, key: &str, used: &Arc<C>) -> bool {
        let mut slots = self.slots();
        match slots.get(key) {
            Some(Slot::Ready(kept)) if Arc::ptr_eq(kept, used) => {
                slots.remove(key);
                true
            }
            _ => false,
        }
    }

    /// The connection currently kept for `key`, without checking liveness or
    /// opening anything (`None` while it is still being opened). For tests
    /// and diagnostics.
    pub async fn cached(&self, key: &str) -> Option<Arc<C>> {
        match self.slots().get(key) {
            Some(Slot::Ready(conn)) => Some(conn.clone()),
            _ => None,
        }
    }

    /// Run `op` on the connection for `key` (see `get`). If `op` reports a
    /// disconnection, drop that connection, open a fresh one and run `op`
    /// once more; the second result is returned whatever it is. A connection
    /// that cannot be opened (first time or on the retry) comes back as
    /// `OpError::Disconnected` carrying the reason. `OpError::Failed` is
    /// returned without a retry and the connection is kept.
    pub async fn run<T, F, Fut, Op, OpFut>(&self, key: &str, open: F, op: Op) -> Result<T, OpError>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = Result<C, FsError>>,
        Op: Fn(Arc<C>) -> OpFut,
        OpFut: Future<Output = Result<T, OpError>>,
    {
        let conn = self.get(key, &open).await.map_err(OpError::Disconnected)?;
        match op(conn.clone()).await {
            Err(e) if e.is_disconnected() => {
                tracing::debug!(key, error = %e.into_fs(), "pooled connection lost; reopening once");
                self.discard(key, &conn).await;
                drop(conn);
                let conn = self.get(key, &open).await.map_err(OpError::Disconnected)?;
                op(conn).await
            }
            other => other,
        }
    }
}

impl<C: PooledConnection> Default for ConnectionPool<C> {
    fn default() -> Self {
        Self::new()
    }
}

/// Drop guard for an open in progress: when the opening future is dropped
/// before it finishes, removes that open's `Opening` slot (and only that
/// one), which also wakes its waiters so they start over. A finished open
/// has already replaced or removed its slot, so this does nothing then.
struct AbandonedOpen<'a, C> {
    slots: &'a StdMutex<HashMap<String, Slot<C>>>,
    key: &'a str,
    id: u64,
}

impl<C> Drop for AbandonedOpen<'_, C> {
    fn drop(&mut self) {
        let mut slots = lock_slots(self.slots);
        if matches!(slots.get(self.key), Some(Slot::Opening { id, .. }) if *id == self.id) {
            slots.remove(self.key);
        }
    }
}

fn lock_slots<C>(
    slots: &StdMutex<HashMap<String, Slot<C>>>,
) -> MutexGuard<'_, HashMap<String, Slot<C>>> {
    // A panic while the lock was held cannot leave a half-written entry
    // (every critical section is a single insert / remove), so a poisoned
    // lock is still safe to use.
    slots.lock().unwrap_or_else(|e| e.into_inner())
}

/// A copy of `e` for every caller that waited on one failed open.
/// `FsError` is not `Clone` (its `Io` variant holds an `io::Error`), so the
/// `Io` case is rebuilt from the kind and the message; the text the caller
/// sees is the same (要件#5 追補c 答え2).
fn copy_fs_error(e: &FsError) -> FsError {
    match e {
        FsError::NotFound(s) => FsError::NotFound(s.clone()),
        FsError::PermissionDenied(s) => FsError::PermissionDenied(s.clone()),
        FsError::FileTooLarge(s) => FsError::FileTooLarge(s.clone()),
        FsError::InvalidUtf8 => FsError::InvalidUtf8,
        FsError::UnsupportedScheme(s) => FsError::UnsupportedScheme(s.clone()),
        FsError::Unsupported(s) => FsError::Unsupported(s.clone()),
        FsError::Io(io) => FsError::Io(std::io::Error::new(io.kind(), io.to_string())),
    }
}
