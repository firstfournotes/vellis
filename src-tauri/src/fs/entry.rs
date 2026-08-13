use serde::Serialize;

/// A file-system entry returned by `FileProvider::list` and `FileProvider::stat`.
#[derive(Clone, Debug, Serialize)]
pub struct Entry {
    /// Full URI string.
    pub uri: String,
    /// Display name (file or directory name).
    pub name: String,
    /// Entry kind.
    pub kind: FileKind,
    /// File size in bytes (None for directories or when unavailable).
    pub size: Option<u64>,
    /// Last modified time as Unix epoch milliseconds (None when unavailable).
    pub modified: Option<i64>,
}

/// Kind of a file-system entry.
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    File,
    Dir,
    Symlink,
}
