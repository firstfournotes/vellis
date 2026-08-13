use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::errors::UriError;

/// Parsed URI with scheme, optional authority, and path.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Uri {
    pub scheme: String,
    pub authority: Option<Authority>,
    pub path: PathBuf,
    pub raw: String,
}

/// Authority component: `user@host:port`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Authority {
    pub user: Option<String>,
    pub host: String,
    pub port: Option<u16>,
}

impl Uri {
    /// Parse a string into a `Uri`.
    ///
    /// Accepted formats:
    /// - `file:///absolute/path`
    /// - `ssh://[user@]host[:port]/path`
    /// - Absolute path (`/foo/bar`)
    /// - Relative path (`README.md`, `./docs`) — canonicalized to `file://` + absolute path
    pub fn parse(s: &str) -> Result<Self, UriError> {
        let s = s.trim();
        if s.is_empty() {
            return Err(UriError::Invalid("empty URI".into()));
        }

        if let Some(rest) = s.strip_prefix("file://") {
            // file:///absolute/path
            let path = PathBuf::from(rest);
            if !path.is_absolute() {
                return Err(UriError::Invalid(format!(
                    "file:// URI must have an absolute path: {}",
                    s
                )));
            }
            Ok(Self {
                scheme: "file".into(),
                authority: None,
                path,
                raw: s.into(),
            })
        } else if let Some(rest) = s.strip_prefix("ssh://") {
            parse_ssh(rest, s)
        } else if s.contains("://") {
            // Unknown scheme
            let scheme = s.split("://").next().unwrap_or("");
            Err(UriError::Invalid(format!("unsupported scheme: {}", scheme)))
        } else {
            // Absolute or relative path — treat as file://
            let path = PathBuf::from(s);
            let abs = if path.is_absolute() {
                path
            } else {
                std::env::current_dir()
                    .map_err(|e| UriError::Canonicalize(e.to_string()))?
                    .join(&path)
            };
            let canonical = std::fs::canonicalize(&abs).map_err(|e| {
                UriError::Canonicalize(format!("{}: {}", abs.display(), e))
            })?;
            let raw = format!("file://{}", canonical.display());
            Ok(Self {
                scheme: "file".into(),
                authority: None,
                path: canonical,
                raw,
            })
        }
    }

    /// Create a new URI with a different path, keeping scheme and authority.
    pub fn with_path(&self, new_path: impl AsRef<Path>) -> Self {
        let path = new_path.as_ref().to_path_buf();
        let raw = match &self.authority {
            Some(auth) => format!("{}://{}{}", self.scheme, auth.to_string(), path.display()),
            None => format!("{}://{}", self.scheme, path.display()),
        };
        Self {
            scheme: self.scheme.clone(),
            authority: self.authority.clone(),
            path,
            raw,
        }
    }

    /// Return the canonical string form of this URI (the raw field).
    pub fn canonical(&self) -> String {
        self.raw.clone()
    }

    /// Return the parent URI (path's parent directory).
    pub fn parent(&self) -> Option<Self> {
        self.path.parent().map(|p| self.with_path(p))
    }

    /// Return the path as a string slice.
    pub fn path_str(&self) -> &str {
        self.path.to_str().unwrap_or("")
    }
}

impl std::fmt::Display for Uri {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.raw)
    }
}

impl std::fmt::Display for Authority {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(user) = &self.user {
            write!(f, "{}@", user)?;
        }
        write!(f, "{}", self.host)?;
        if let Some(port) = self.port {
            write!(f, ":{}", port)?;
        }
        Ok(())
    }
}

/// Parse the authority + path portion of an `ssh://` URI.
fn parse_ssh(rest: &str, original: &str) -> Result<Uri, UriError> {
    // rest = [user@]host[:port]/path
    // Find the first '/' that separates host from path
    let slash_pos = rest
        .find('/')
        .ok_or_else(|| UriError::Invalid(format!("ssh:// URI requires a path: {}", original)))?;

    let authority_str = &rest[..slash_pos];
    let path_str = &rest[slash_pos..]; // includes leading '/'

    // Parse authority: [user@]host[:port]
    let (user, host_port) = if let Some(at) = authority_str.rfind('@') {
        (Some(authority_str[..at].to_string()), &authority_str[at + 1..])
    } else {
        (None, authority_str)
    };

    let (host, port) = if let Some(colon) = host_port.rfind(':') {
        let port_str = &host_port[colon + 1..];
        match port_str.parse::<u16>() {
            Ok(p) => (host_port[..colon].to_string(), Some(p)),
            Err(_) => {
                return Err(UriError::Invalid(format!(
                    "invalid port in URI: {}",
                    original
                )));
            }
        }
    } else {
        (host_port.to_string(), None)
    };

    if host.is_empty() {
        return Err(UriError::Invalid(format!(
            "empty host in URI: {}",
            original
        )));
    }

    Ok(Uri {
        scheme: "ssh".into(),
        authority: Some(Authority { user, host, port }),
        path: PathBuf::from(path_str),
        raw: original.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_file_uri_absolute() {
        let uri = Uri::parse("file:///tmp/test.md").unwrap();
        assert_eq!(uri.scheme, "file");
        assert_eq!(uri.path, PathBuf::from("/tmp/test.md"));
        assert!(uri.authority.is_none());
        assert_eq!(uri.raw, "file:///tmp/test.md");
    }

    #[test]
    fn parse_file_uri_rejects_relative() {
        let result = Uri::parse("file://relative/path");
        assert!(result.is_err());
    }

    #[test]
    fn parse_ssh_uri_full() {
        let uri = Uri::parse("ssh://alice@host.example.com:2222/home/alice/notes").unwrap();
        assert_eq!(uri.scheme, "ssh");
        let auth = uri.authority.as_ref().unwrap();
        assert_eq!(auth.user.as_deref(), Some("alice"));
        assert_eq!(auth.host, "host.example.com");
        assert_eq!(auth.port, Some(2222));
        assert_eq!(uri.path, PathBuf::from("/home/alice/notes"));
    }

    #[test]
    fn parse_ssh_uri_no_user_no_port() {
        let uri = Uri::parse("ssh://myhost/data/docs").unwrap();
        assert_eq!(uri.scheme, "ssh");
        let auth = uri.authority.as_ref().unwrap();
        assert!(auth.user.is_none());
        assert_eq!(auth.host, "myhost");
        assert!(auth.port.is_none());
        assert_eq!(uri.path, PathBuf::from("/data/docs"));
    }

    #[test]
    fn parse_ssh_uri_no_path_is_error() {
        assert!(Uri::parse("ssh://host").is_err());
    }

    #[test]
    fn parse_absolute_path() {
        let uri = Uri::parse("/tmp").unwrap();
        assert_eq!(uri.scheme, "file");
        assert!(uri.path.is_absolute());
    }

    #[test]
    fn parse_relative_path_canonicalizes() {
        // "." should resolve to the current working directory
        let uri = Uri::parse(".").unwrap();
        assert_eq!(uri.scheme, "file");
        assert!(uri.path.is_absolute());
        assert!(uri.raw.starts_with("file://"));
    }

    #[test]
    fn parse_empty_is_error() {
        assert!(Uri::parse("").is_err());
    }

    #[test]
    fn parse_unsupported_scheme() {
        assert!(Uri::parse("ftp://example.com/file").is_err());
    }

    #[test]
    fn with_path_preserves_scheme_and_authority() {
        let uri = Uri::parse("ssh://alice@host:22/old/path").unwrap();
        let new_uri = uri.with_path("/new/path");
        assert_eq!(new_uri.scheme, "ssh");
        assert_eq!(new_uri.authority, uri.authority);
        assert_eq!(new_uri.path, PathBuf::from("/new/path"));
        assert!(new_uri.raw.contains("/new/path"));
    }

    #[test]
    fn parent_returns_parent_directory() {
        let uri = Uri::parse("file:///foo/bar/baz.md").unwrap();
        let parent = uri.parent().unwrap();
        assert_eq!(parent.path, PathBuf::from("/foo/bar"));
    }

    #[test]
    fn path_str_works() {
        let uri = Uri::parse("file:///tmp/test.md").unwrap();
        assert_eq!(uri.path_str(), "/tmp/test.md");
    }

    #[test]
    fn display_trait() {
        let uri = Uri::parse("file:///tmp/test.md").unwrap();
        assert_eq!(format!("{}", uri), "file:///tmp/test.md");
    }
}
