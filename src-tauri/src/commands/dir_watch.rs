//! `subscribe_dir` / `unsubscribe_dir` — ツリーの開閉をディレクトリ監視へつなぐ
//! (requirements.md #18)。
//!
//! 呼び出し側は `ExplorerItem`: 子を読み込んだ(=展開した)ら `subscribe_dir`、
//! 折りたたんだら `unsubscribe_dir`。以後そのディレクトリの追加・削除は既存の
//! `directory_changed { root_uri, entries }` で届く(root 直下と同じ経路)。
//!
//! 失敗はいずれも致命ではない — 監視が付かなければ従来どおり reload で追いつく
//! ので、`Err` を返さず warn に落とす。フロントは展開の成否をこれで左右させない。

use tauri::{Manager, Window};

use crate::fs::uri::Uri;
use crate::watch::hub::WindowId;

use super::AppState;

/// 展開したディレクトリの監視を始める。
///
/// ssh リモートは対象外(要件#18 ⑤)。現状のリモート watch は単一パスの stat
/// ポーリングで、子の増減を検知しない設計のため、購読しても空振りになる。
#[tauri::command]
pub async fn subscribe_dir(
    uri: String,
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let dir_uri = match Uri::parse(&uri) {
        Ok(u) => u,
        Err(e) => {
            tracing::warn!("subscribe_dir: invalid uri {}: {}", uri, e);
            return Ok(());
        }
    };
    if dir_uri.scheme != "file" {
        return Ok(());
    }

    let label = window.label().to_string();
    let coordinator = state.coordinator.clone();
    let app_handle = window.app_handle().clone();

    let mut wm = state.window_manager.lock().await;
    let Some(win_state) = wm.get_mut(&label) else {
        tracing::warn!("subscribe_dir: window '{}' not registered", label);
        return Ok(());
    };
    // The coordinator takes its own lock and never reaches back for the
    // window manager, so awaiting here only serializes other window-manager
    // work — it cannot deadlock. The set lives inside `WindowState`, which
    // is what keeps the watches tied to the window's lifetime.
    if let Err(e) = win_state
        .dir_watches
        .watch(&coordinator, dir_uri, WindowId(label.clone()), app_handle)
        .await
    {
        tracing::warn!("subscribe_dir: failed to watch {}: {}", uri, e);
    }
    Ok(())
}

/// 折りたたんだ(あるいはツリーから消えた)ディレクトリの監視をやめる。
#[tauri::command]
pub async fn unsubscribe_dir(
    uri: String,
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let canonical = match Uri::parse(&uri) {
        Ok(u) => u.canonical(),
        // 解釈できない URI は購読もできていない。キーとして持っていない以上
        // 消すものも無いので、そのまま返す。
        Err(_) => return Ok(()),
    };

    let mut wm = state.window_manager.lock().await;
    if let Some(win_state) = wm.get_mut(&label) {
        win_state.dir_watches.unwatch(&canonical);
    }
    Ok(())
}
