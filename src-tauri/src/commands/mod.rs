pub mod annotation;
pub mod app;
pub mod asset;
pub mod build_info;
pub mod document;
pub mod history;
pub mod list;
pub mod root;
#[cfg(feature = "webdriver")]
pub mod test_helpers;
pub mod window;

use std::sync::{Arc, Mutex as StdMutex};

use tokio::sync::Mutex;

use crate::annotation::AnnotationStore;
use crate::fs::registry::FileProviderRegistry;
use crate::watch::hub::DocumentCoordinator;
use crate::window::manager::WindowManager;

/// Shared application state managed by Tauri.
#[derive(Clone)]
pub struct AppState {
    pub fs_registry: Arc<FileProviderRegistry>,
    pub coordinator: Arc<DocumentCoordinator<tauri::Wry>>,
    pub window_manager: Arc<Mutex<WindowManager<tauri::Wry>>>,
    /// Per-root `AnnotationStore` cache.  Lazily populated by
    /// annotation Tauri commands; canonical absolute root path is the
    /// key (`docs/ai-collab.md` Phase 4.1).
    pub annotation_stores:
        Arc<StdMutex<std::collections::HashMap<std::path::PathBuf, Arc<AnnotationStore>>>>,
}
