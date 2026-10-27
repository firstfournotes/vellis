//! IPC server — Unix Domain Socket listener run by the Main Process.

use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::mpsc;
use tracing;

use super::protocol::{Request, Response};

/// A handle to the running IPC server.
///
/// Dropping this handle signals the accept loop to shut down and cleans up the
/// socket file.
pub struct IpcServer {
    /// Sender that, when dropped, causes the accept loop to terminate.
    _shutdown_tx: mpsc::Sender<()>,
    /// Path to the socket file (cleaned up on drop).
    socket_path: PathBuf,
}

impl Drop for IpcServer {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

/// Channel message representing a dispatched IPC request.
#[derive(Debug)]
pub struct IpcCommand {
    pub request: Request,
    pub responder: tokio::sync::oneshot::Sender<Response>,
}

impl IpcServer {
    /// Start the IPC server on the given Unix socket path.
    ///
    /// Returns the server handle and a receiver for incoming commands.
    /// The caller is responsible for processing `IpcCommand`s and sending
    /// responses through the oneshot channel.
    pub fn start(
        socket_path: &Path,
    ) -> Result<(Self, mpsc::Receiver<IpcCommand>), std::io::Error> {
        // Remove stale socket if it exists.
        let _ = std::fs::remove_file(socket_path);

        let listener = UnixListener::bind(socket_path)?;
        let (shutdown_tx, mut shutdown_rx) = mpsc::channel::<()>(1);
        let (cmd_tx, cmd_rx) = mpsc::channel::<IpcCommand>(32);

        let socket_path_owned = socket_path.to_path_buf();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    accept_result = listener.accept() => {
                        match accept_result {
                            Ok((stream, _addr)) => {
                                let cmd_tx = cmd_tx.clone();
                                tokio::spawn(async move {
                                    if let Err(e) = handle_connection(stream, cmd_tx).await {
                                        tracing::warn!("IPC connection error: {}", e);
                                    }
                                });
                            }
                            Err(e) => {
                                tracing::error!("IPC accept error: {}", e);
                                break;
                            }
                        }
                    }
                    _ = shutdown_rx.recv() => {
                        // Shutdown signal received (sender dropped or explicit send).
                        break;
                    }
                }
            }
            tracing::debug!("IPC server accept loop terminated");
            // Drop the listener explicitly.
            drop(listener);
            // Clean up the socket file.
            let _ = std::fs::remove_file(&socket_path_owned);
        });

        Ok((
            IpcServer {
                _shutdown_tx: shutdown_tx,
                socket_path: socket_path.to_path_buf(),
            },
            cmd_rx,
        ))
    }
}

/// Handle a single IPC connection: read one JSON Lines request, dispatch it,
/// and write the response.
async fn handle_connection(
    stream: tokio::net::UnixStream,
    cmd_tx: mpsc::Sender<IpcCommand>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (reader, mut writer) = stream.into_split();
    let mut buf_reader = BufReader::new(reader);
    let mut line = String::new();

    let n = buf_reader.read_line(&mut line).await?;
    if n == 0 {
        return Ok(()); // Client disconnected without sending.
    }

    let request: Request = serde_json::from_str(line.trim())?;

    // Special-case Ping: respond immediately without dispatching.
    if matches!(request, Request::Ping) {
        let resp = serde_json::to_string(&Response::Ok)?;
        writer.write_all(resp.as_bytes()).await?;
        writer.write_all(b"\n").await?;
        writer.flush().await?;
        return Ok(());
    }

    let (resp_tx, resp_rx) = tokio::sync::oneshot::channel();
    cmd_tx
        .send(IpcCommand {
            request,
            responder: resp_tx,
        })
        .await
        .map_err(|_| "command channel closed")?;

    let response = resp_rx.await.unwrap_or(Response::Error {
        code: "INTERNAL".into(),
        message: "command handler dropped".into(),
    });

    let resp_json = serde_json::to_string(&response)?;
    writer.write_all(resp_json.as_bytes()).await?;
    writer.write_all(b"\n").await?;
    writer.flush().await?;

    Ok(())
}

/// Byte length of `sockaddr_un.sun_path` (104 on macOS, 108 on Linux). A socket
/// path must be shorter than this to be bound or connected to.
fn sun_path_len() -> usize {
    // SAFETY: `sockaddr_un` is plain old data; all zeros is a valid value.
    let addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    std::mem::size_of_val(&addr.sun_path)
}

/// FNV-1a 64bit (offset basis 0xcbf29ce484222325, prime 0x100000001b3).
/// Written out rather than taken from std's hashers, whose output may change
/// between Rust versions: the CLI and the Main Process must agree on it.
fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// The socket path for `runtime_dir` (`XDG_RUNTIME_DIR`) and `uid`
/// (要件#3 追補e 契約1・backlog 336).
///
/// - No `runtime_dir`: `/tmp/vellis-<uid>.sock`.
/// - `<runtime_dir>/vellis.sock` shorter than `sun_path`: that path.
/// - Otherwise it can be neither bound nor connected to (the Main Process
///   would run without IPC), so fall back to `/tmp/vellis-<uid>-<h>.sock`,
///   `<h>` being the FNV-1a 64bit of the `runtime_dir` bytes in 16 lowercase
///   hex digits: the same dir gives the CLI and the Main Process the same
///   path, different dirs get different paths. `/tmp` is where the socket
///   lives without `XDG_RUNTIME_DIR`; `$TMPDIR` is shorter but may differ
///   between a terminal and an app started from Finder.
pub fn socket_path_for(runtime_dir: Option<&Path>, uid: u32) -> PathBuf {
    let Some(dir) = runtime_dir else {
        return PathBuf::from(format!("/tmp/vellis-{uid}.sock"));
    };
    let in_dir = dir.join("vellis.sock");
    if in_dir.as_os_str().as_bytes().len() < sun_path_len() {
        return in_dir;
    }
    let h = fnv1a_64(dir.as_os_str().as_bytes());
    PathBuf::from(format!("/tmp/vellis-{uid}-{h:016x}.sock"))
}

/// Compute the default socket path for the current platform.
pub fn default_socket_path() -> PathBuf {
    // `var`, not `var_os`: a non-UTF-8 `XDG_RUNTIME_DIR` stays ignored as
    // before and as in `default_lock_path`, so the socket and the lock agree.
    let runtime_dir = std::env::var("XDG_RUNTIME_DIR").ok();
    let uid = unsafe { libc::getuid() };
    socket_path_for(runtime_dir.as_deref().map(Path::new), uid)
}

/// Compute the default lock file path for the current platform.
pub fn default_lock_path() -> PathBuf {
    if let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") {
        PathBuf::from(runtime_dir).join("vellis.lock")
    } else {
        let uid = unsafe { libc::getuid() };
        PathBuf::from(format!("/tmp/vellis-{}.lock", uid))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::client::IpcClient;
    use crate::ipc::protocol::{Request, Response};

    #[tokio::test]
    async fn server_responds_to_ping() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("test.sock");

        let (_server, _cmd_rx) = IpcServer::start(&sock).unwrap();

        // Give the server a moment to bind.
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        // Probe should succeed.
        assert!(IpcClient::probe(&sock).await);

        // Ping should get Ok.
        let resp = IpcClient::send(&sock, &Request::Ping).await.unwrap();
        assert_eq!(resp, Response::Ok);
    }

    #[tokio::test]
    async fn server_dispatches_open_path() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("test.sock");

        let (_server, mut cmd_rx) = IpcServer::start(&sock).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        // Spawn a handler that responds to commands.
        tokio::spawn(async move {
            while let Some(cmd) = cmd_rx.recv().await {
                let _ = cmd.responder.send(Response::Ok);
            }
        });

        let req = Request::OpenPath {
            uri: "file:///tmp/test.md".into(),
            new_window: false,
        };
        let resp = IpcClient::send(&sock, &req).await.unwrap();
        assert_eq!(resp, Response::Ok);
    }

    #[tokio::test]
    async fn server_dispatches_switch_root() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("test.sock");

        let (_server, mut cmd_rx) = IpcServer::start(&sock).unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        tokio::spawn(async move {
            while let Some(cmd) = cmd_rx.recv().await {
                let _ = cmd.responder.send(Response::Ok);
            }
        });

        let req = Request::SwitchRoot {
            uri: "file:///home/user/docs".into(),
        };
        let resp = IpcClient::send(&sock, &req).await.unwrap();
        assert_eq!(resp, Response::Ok);
    }

    #[tokio::test]
    async fn socket_cleaned_up_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("cleanup.sock");

        {
            let (_server, _cmd_rx) = IpcServer::start(&sock).unwrap();
            assert!(sock.exists());
        }
        // After dropping the server, the socket file should be removed.
        // Give a moment for the cleanup.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!sock.exists());
    }

    #[test]
    fn default_socket_path_is_valid() {
        let path = default_socket_path();
        assert!(path.to_str().unwrap().contains("vellis"));
    }

    #[test]
    fn default_lock_path_is_valid() {
        let path = default_lock_path();
        assert!(path.to_str().unwrap().contains("vellis"));
    }
}
