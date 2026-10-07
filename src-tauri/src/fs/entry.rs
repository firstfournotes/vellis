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
    /// Set only on listed rows that are symbolic links (要件#70 契約1). `kind`,
    /// `size` and `modified` still describe the target (要件#31); this field is
    /// what tells the tree the row was a link. `stat` never sets it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<LinkInfo>,
}

/// What a listing knows about a symbolic link (要件#70 契約1).
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct LinkInfo {
    /// The `readlink` string as stored — relative stays relative, not normalized.
    /// None when it could not be read (local) or was not asked for (ssh).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// The link could not be followed (missing target, loop, permission).
    /// Always false over ssh, which does not follow links in a listing.
    pub broken: bool,
}

/// Kind of a file-system entry.
#[derive(Clone, Copy, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    File,
    Dir,
    Symlink,
}
