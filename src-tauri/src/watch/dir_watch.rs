//! 展開中サブディレクトリの監視束(requirements.md #18)。
//!
//! ツリーで開いているディレクトリは、その1階層だけを `notify` で見る。root と
//! 同じ [`DocumentCoordinator::subscribe_directory`] に相乗りするので、監視の
//! 重複排除・再一覧化・`directory_changed` の配信は hub がそのまま担う。ここが
//! 足すのは「ウィンドウ1つが今どのディレクトリを開いているか」の束と、その
//! 寿命管理だけ。
//!
//! 寿命は3経路とも RAII に寄せてある: 折りたたみ=[`unwatch`]・root 切替=
//! [`clear`]・ウィンドウクローズ=`WindowState` ごと `Drop`(束が落ちれば
//! 各 [`WatchSubscription`] の `Drop` が hub の refcount を戻す)。
//!
//! [`unwatch`]: DirWatchSet::unwatch
//! [`clear`]: DirWatchSet::clear

use std::collections::HashMap;
use std::sync::Arc;

use crate::errors::FsError;
use crate::fs::uri::Uri;
use crate::watch::hub::{DocumentCoordinator, WatchSubscription, WindowId};

/// ウィンドウ1つが持つ、展開中サブディレクトリの監視束。
/// キーは `uri.canonical()`。
pub struct DirWatchSet<R: tauri::Runtime = tauri::Wry> {
    watches: HashMap<String, WatchSubscription<R>>,
}

impl<R: tauri::Runtime> DirWatchSet<R> {
    pub fn new() -> Self {
        Self {
            watches: HashMap::new(),
        }
    }

    /// 展開時: `uri` のディレクトリ監視を hub へ追加登録する。
    ///
    /// 既に監視中の URI は no-op。展開⇔折りたたみの反復や reload 後の復元展開で
    /// 購読を積み増さない(1ウィンドウ1ディレクトリにつき購読は高々1本)。
    pub async fn watch(
        &mut self,
        hub: &Arc<DocumentCoordinator<R>>,
        uri: Uri,
        window_id: WindowId,
        app: tauri::AppHandle<R>,
    ) -> Result<(), FsError> {
        let canonical = uri.canonical();
        if self.watches.contains_key(&canonical) {
            return Ok(());
        }
        let sub = hub.subscribe_directory(uri, window_id, app).await?;
        self.watches.insert(canonical, sub);
        Ok(())
    }

    /// 折りたたみ時: 当該 canonical URI の購読を解放する(未監視は no-op)。
    pub fn unwatch(&mut self, canonical: &str) {
        self.watches.remove(canonical);
    }

    /// root 切替時: 全購読を解放する(ウィンドウクローズは `Drop` が同じ結果になる)。
    pub fn clear(&mut self) {
        self.watches.clear();
    }

    pub fn is_watched(&self, canonical: &str) -> bool {
        self.watches.contains_key(canonical)
    }
}

impl<R: tauri::Runtime> Default for DirWatchSet<R> {
    fn default() -> Self {
        Self::new()
    }
}
