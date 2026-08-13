//! IPC client — short-lived connection from CLI to the Main Process.

use std::path::Path;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::time::{timeout, Duration};

use super::protocol::{Request, Response};

/// Timeout for the initial connection probe.
const PROBE_TIMEOUT: Duration = Duration::from_millis(100);

/// Timeout for a full send-receive cycle.
const SEND_TIMEOUT: Duration = Duration::from_millis(500);

pub struct IpcClient;

impl IpcClient {
    /// Check whether a Main Process is listening on the given socket.
    ///
    /// Returns `true` if a connection can be established within 100ms.
    pub async fn probe(socket_path: &Path) -> bool {
        timeout(PROBE_TIMEOUT, UnixStream::connect(socket_path))
            .await
            .map(|r| r.is_ok())
            .unwrap_or(false)
    }

    /// Send a `Request` to the Main Process and wait for a `Response`.
    ///
    /// Returns an error if the connection or the response times out (500ms).
    pub async fn send(
        socket_path: &Path,
        request: &Request,
    ) -> Result<Response, IpcClientError> {
        let stream = timeout(PROBE_TIMEOUT, UnixStream::connect(socket_path))
            .await
            .map_err(|_| IpcClientError::ConnectTimeout)?
            .map_err(IpcClientError::Io)?;

        let (reader, mut writer) = stream.into_split();

        // Write the request as a single JSON line.
        let mut json = serde_json::to_string(request).map_err(IpcClientError::Serialize)?;
        json.push('\n');
        writer
            .write_all(json.as_bytes())
            .await
            .map_err(IpcClientError::Io)?;
        writer.flush().await.map_err(IpcClientError::Io)?;

        // Read the response (single JSON line).
        let mut buf_reader = BufReader::new(reader);
        let mut line = String::new();
        timeout(SEND_TIMEOUT, buf_reader.read_line(&mut line))
            .await
            .map_err(|_| IpcClientError::ResponseTimeout)?
            .map_err(IpcClientError::Io)?;

        let response: Response =
            serde_json::from_str(line.trim()).map_err(IpcClientError::Deserialize)?;
        Ok(response)
    }
}

/// Errors that can occur during IPC client operations.
#[derive(Debug, thiserror::Error)]
pub enum IpcClientError {
    #[error("connection timed out")]
    ConnectTimeout,

    #[error("response timed out")]
    ResponseTimeout,

    #[error("I/O error: {0}")]
    Io(std::io::Error),

    #[error("serialization error: {0}")]
    Serialize(serde_json::Error),

    #[error("deserialization error: {0}")]
    Deserialize(serde_json::Error),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[tokio::test]
    async fn probe_returns_false_when_no_server() {
        let path = PathBuf::from("/tmp/vellis-test-nonexistent.sock");
        assert!(!IpcClient::probe(&path).await);
    }

    #[tokio::test]
    async fn send_fails_when_no_server() {
        let path = PathBuf::from("/tmp/vellis-test-nonexistent.sock");
        let result = IpcClient::send(&path, &Request::Ping).await;
        assert!(result.is_err());
    }
}
