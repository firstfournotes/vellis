use thiserror::Error;

/// Top-level application error.
#[derive(Debug, Error)]
pub enum VellisError {
    #[error(transparent)]
    Fs(#[from] FsError),

    #[error("IPC error: {0}")]
    Ipc(String),

    #[error(transparent)]
    Uri(#[from] UriError),

    #[error("internal error: {0}")]
    Internal(String),
}

/// File-system layer errors.
#[derive(Debug, Error)]
pub enum FsError {
    #[error("not found: {0}")]
    NotFound(String),

    #[error("permission denied: {0}")]
    PermissionDenied(String),

    #[error("file too large: {0}")]
    FileTooLarge(String),

    #[error("invalid UTF-8")]
    InvalidUtf8,

    #[error("unsupported scheme: {0}")]
    UnsupportedScheme(String),

    /// The provider handles this scheme but cannot perform the requested
    /// operation (要件#48 契約①: `SshProvider::write_text`). Distinct from
    /// `UnsupportedScheme`, which means "wrong provider for this URI".
    #[error("unsupported operation: {0}")]
    Unsupported(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

/// URI parsing errors.
#[derive(Debug, Error)]
pub enum UriError {
    #[error("invalid URI: {0}")]
    Invalid(String),

    #[error("path canonicalization failed: {0}")]
    Canonicalize(String),
}
