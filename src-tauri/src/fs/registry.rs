use std::collections::HashMap;
use std::sync::Arc;

use crate::errors::FsError;

use super::local::LocalProvider;
use super::provider::FileProvider;
use super::uri::Uri;

/// Registry that maps URI schemes to `FileProvider` implementations.
pub struct FileProviderRegistry {
    providers: HashMap<&'static str, Arc<dyn FileProvider>>,
}

impl FileProviderRegistry {
    /// Create a new registry with providers pre-registered for every scheme
    /// the current build supports:
    ///
    /// - `"file"` — always, backed by `LocalProvider`.
    /// - `"ssh"` — when the `provider-ssh` cargo feature is enabled (default).
    pub fn new() -> Self {
        let mut providers: HashMap<&'static str, Arc<dyn FileProvider>> = HashMap::new();
        providers.insert("file", Arc::new(LocalProvider::new()));
        #[cfg(feature = "provider-ssh")]
        {
            use super::ssh::SshProvider;
            providers.insert("ssh", Arc::new(SshProvider::new()));
        }
        Self { providers }
    }

    /// Register a provider for its scheme. Overwrites any previous provider for that scheme.
    pub fn register(&mut self, provider: Arc<dyn FileProvider>) {
        self.providers.insert(provider.scheme(), provider);
    }

    /// Resolve a URI to its matching `FileProvider`.
    ///
    /// Returns `Err(FsError::UnsupportedScheme)` if no provider is registered for the URI's scheme.
    pub fn resolve(&self, uri: &Uri) -> Result<Arc<dyn FileProvider>, FsError> {
        self.providers
            .get(uri.scheme.as_str())
            .cloned()
            .ok_or_else(|| FsError::UnsupportedScheme(uri.scheme.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_has_local_provider() {
        let registry = FileProviderRegistry::new();
        let uri = Uri {
            scheme: "file".into(),
            authority: None,
            path: "/tmp".into(),
            raw: "file:///tmp".into(),
        };
        let provider = registry.resolve(&uri).unwrap();
        assert_eq!(provider.scheme(), "file");
    }

    #[test]
    fn resolve_unsupported_scheme() {
        let registry = FileProviderRegistry::new();
        let uri = Uri {
            scheme: "ftp".into(),
            authority: None,
            path: "/tmp".into(),
            raw: "ftp:///tmp".into(),
        };
        let result = registry.resolve(&uri);
        assert!(matches!(result, Err(FsError::UnsupportedScheme(_))));
    }

    #[cfg(feature = "provider-ssh")]
    #[test]
    fn new_has_ssh_provider_when_feature_enabled() {
        let registry = FileProviderRegistry::new();
        let uri = Uri {
            scheme: "ssh".into(),
            authority: None,
            path: "/home/alice/notes".into(),
            raw: "ssh://alice@host/home/alice/notes".into(),
        };
        let provider = registry.resolve(&uri).unwrap();
        assert_eq!(provider.scheme(), "ssh");
    }
}
