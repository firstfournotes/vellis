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
//!
//! The pool is generic over the connection type so the policy can be tested
//! with fakes; `ssh.rs` plugs in its `Session`.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use tokio::sync::Mutex;

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

/// One connection per key, shared by every caller.
///
/// The lock is only held to look up / swap entries — never while a
/// connection is being opened (an SSH open resolves `ssh -G`, connects and
/// authenticates), so a slow host does not stall operations on other hosts.
pub struct ConnectionPool<C> {
    conns: Mutex<HashMap<String, Arc<C>>>,
}

impl<C: PooledConnection> ConnectionPool<C> {
    pub fn new() -> Self {
        Self {
            conns: Mutex::new(HashMap::new()),
        }
    }

    /// Hand out the connection kept for `key`, opening one with `open` when
    /// there is none or the kept one has closed (the closed one is dropped
    /// from the pool first). An `open` failure is returned as is and nothing
    /// is kept.
    ///
    /// If another caller kept a live connection for `key` while this one was
    /// opening, that connection wins and the one opened here is dropped.
    pub async fn get<F, Fut>(&self, key: &str, open: F) -> Result<Arc<C>, FsError>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = Result<C, FsError>>,
    {
        {
            let mut conns = self.conns.lock().await;
            if let Some(conn) = conns.get(key) {
                if !conn.is_closed() {
                    return Ok(conn.clone());
                }
                conns.remove(key);
            }
        }

        let opened = Arc::new(open().await?);
        let mut conns = self.conns.lock().await;
        if let Some(conn) = conns.get(key) {
            if !conn.is_closed() {
                return Ok(conn.clone());
            }
        }
        conns.insert(key.to_string(), opened.clone());
        Ok(opened)
    }

    /// Drop the connection kept for `key`, but only if it is `used` itself.
    /// A connection another caller has already put in its place stays.
    /// Returns whether anything was dropped.
    pub async fn discard(&self, key: &str, used: &Arc<C>) -> bool {
        let mut conns = self.conns.lock().await;
        match conns.get(key) {
            Some(kept) if Arc::ptr_eq(kept, used) => {
                conns.remove(key);
                true
            }
            _ => false,
        }
    }

    /// The connection currently kept for `key`, without checking liveness or
    /// opening anything. For tests and diagnostics.
    pub async fn cached(&self, key: &str) -> Option<Arc<C>> {
        self.conns.lock().await.get(key).cloned()
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
