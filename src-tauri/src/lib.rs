pub mod annotation;
pub mod audio_extract;
pub mod channel;
pub mod cli;
pub mod features;
pub mod cli_fix;
pub mod cli_install;
pub mod commands;
pub mod errors;
pub mod fs;
pub mod history;
pub mod ipc;
pub mod menu;
pub mod print;
pub mod session;
pub mod spacemouse;
pub mod update_check;
pub mod video_frames;
pub mod wav_waveform;
pub mod watch;
pub mod window;

/// Window title derivation, also reachable as `vellis_lib::window_title`
/// (requirements.md #17).
pub use window::title as window_title;

use std::sync::Arc;

use tauri::{Listener, Manager};
use tokio::sync::Mutex;
use tracing;

use commands::annotation::{
    add_mark, diff_against_snapshot, generate_inbox, list_marks, list_snapshots,
    rebind_marks_for_file, remove_mark, revert_to_snapshot, update_mark,
};
use commands::app::init_window;
use commands::asset::handle_asset;
use commands::build_info::get_build_info;
use commands::dir_watch::{subscribe_dir, unsubscribe_dir};
use commands::document::{open_binary_document, open_document, save_document};
use commands::history::list_history;
use commands::list::list_dir;
use commands::print::{print_current_window, print_html};
use commands::root::set_root;
use commands::video::get_video_frame_index;
use commands::wav_waveform::analyze_wav_waveform;
use commands::waveform::extract_waveform_audio;
use commands::window::new_window;
use commands::AppState;
use fs::registry::FileProviderRegistry;
use ipc::handler::spawn_command_handler;
use ipc::lock::FileLock;
use ipc::server::{default_lock_path, default_socket_path, IpcServer};
use print::{handle_print_protocol, PrintDocumentStore, PRINT_SCHEME};
use watch::hub::DocumentCoordinator;
use window::manager::{WindowArgs, WindowManager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_with_args(WindowArgs::default())
}

/// Start the Tauri app with initial arguments for the first window.
pub fn run_with_args(initial_args: WindowArgs) {
    // Initialise the tracing subscriber so `tracing::warn!` / `info!` /
    // `error!` calls actually surface on stderr. Default filter level is
    // `warn` so users only see security-relevant events (known_hosts
    // mismatch, TOFU first-time persistence, etc.) without info/debug
    // noise; set `RUST_LOG=info` (or finer) for diagnostics. `try_init`
    // is used so re-entrant calls (tests, embedded scenarios) do not
    // panic on a duplicate init.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .with_writer(std::io::stderr)
        .try_init();

    let registry = Arc::new(FileProviderRegistry::new());
    let coordinator = Arc::new(DocumentCoordinator::new(Arc::clone(&registry)));
    let window_manager = Arc::new(Mutex::new(WindowManager::new()));

    let app_state = AppState {
        fs_registry: registry,
        coordinator,
        window_manager: window_manager.clone(),
        annotation_stores: Arc::new(std::sync::Mutex::new(
            std::collections::HashMap::new(),
        )),
    };

    // Base builder. The `webdriver` feature pulls in
    // `tauri-plugin-webdriver`, which embeds a W3C WebDriver server in
    // the running app so external clients can drive the Webview during
    // E2E tests. The `debug_assertions` gate is a defence-in-depth: even
    // if someone passes `--release --features webdriver` the plugin is
    // not registered.  See `docs/implementation.md` §10 (E2E).
    let builder = tauri::Builder::default()
        .manage(app_state)
        // 印刷文書のストア(要件#38)は AppState とは別に管理する。protocol
        // ハンドラとコマンドの2箇所からしか触らないうえ、窓・監視・注釈と違って
        // アプリの状態ではなく「いま印刷しようとしている1文書」の置き場なので。
        .manage(PrintDocumentStore::new());

    #[cfg(all(feature = "webdriver", debug_assertions))]
    let builder = builder.plugin(tauri_plugin_webdriver::init());

    let builder = builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // --- SpaceMouse focus tracking (要件#25) ---
        // The 3Dconnexion driver deactivates our client as soon as another
        // application comes to the front, so coming back needs an explicit
        // re-activation — without this the device goes dead after the first
        // focus round trip. Deactivating on blur is also what lets other 3D
        // apps keep using the device while Vellis is running (backlog #58).
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                if let Some(spacemouse) = window
                    .app_handle()
                    .try_state::<spacemouse::SpaceMouseHandle>()
                {
                    spacemouse.set_window_focus(window.label(), *focused);
                }
            }
        })
        .register_asynchronous_uri_scheme_protocol(
            "vellis-asset",
            move |ctx, req, responder| {
                let state = ctx.app_handle().state::<AppState>();
                let state_ref = state.inner().clone();
                tauri::async_runtime::spawn(async move {
                    let response = handle_asset(&state_ref, req).await;
                    responder.respond(response);
                });
            },
        )
        // 印刷窓が読む one-shot 文書(要件#38)。読み出しはメモリ上の
        // HashMap から1件取り出すだけなので同期ハンドラで足りる。
        .register_uri_scheme_protocol(PRINT_SCHEME, |ctx, req| {
            let store = ctx.app_handle().state::<PrintDocumentStore>();
            handle_print_protocol(&store, &req.uri().to_string())
        });

    // `invoke_handler` can only be called once per Builder — so the
    // `webdriver`-only test helpers (issue #22) need to be inlined into
    // the same list. The `cfg`-gated branches duplicate the production
    // command list to keep the test surface out of release builds. If
    // you add a new production command, update **both** branches.
    #[cfg(feature = "webdriver")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        init_window,
        open_document,
        open_binary_document,
        save_document,
        set_root,
        new_window,
        list_dir,
        subscribe_dir,
        unsubscribe_dir,
        add_mark,
        list_marks,
        update_mark,
        remove_mark,
        generate_inbox,
        rebind_marks_for_file,
        list_snapshots,
        diff_against_snapshot,
        revert_to_snapshot,
        get_build_info,
        list_history,
        get_video_frame_index,
        extract_waveform_audio,
        analyze_wav_waveform,
        print_current_window,
        print_html,
        commands::test_helpers::__test_list_windows,
    ]);
    #[cfg(not(feature = "webdriver"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        init_window,
        open_document,
        open_binary_document,
        save_document,
        set_root,
        new_window,
        list_dir,
        subscribe_dir,
        unsubscribe_dir,
        add_mark,
        list_marks,
        update_mark,
        remove_mark,
        generate_inbox,
        rebind_marks_for_file,
        list_snapshots,
        diff_against_snapshot,
        revert_to_snapshot,
        get_build_info,
        list_history,
        get_video_frame_index,
        extract_waveform_audio,
        analyze_wav_waveform,
        print_current_window,
        print_html,
    ]);

    builder
        .setup(move |app| {
            // --- Native menu bar ---
            let menu = menu::build(app.handle())?;
            #[cfg(target_os = "macos")]
            let window_menu_owner = menu.clone();
            app.set_menu(menu)?;
            // Ordering matters: only after `set_menu` has run muda's
            // `init_for_nsapp` may the Window submenu be handed to NSApp
            // (requirements.md #17).
            #[cfg(target_os = "macos")]
            menu::attach_windows_menu_to_nsapp(&window_menu_owner);
            app.on_menu_event(|app_handle, event| match event.id().as_ref() {
                id if id == menu::INSTALL_CLI_ITEM_ID => {
                    menu::handle_install_cli_click(app_handle);
                }
                id if id == menu::TOGGLE_DEVTOOLS_ITEM_ID => {
                    menu::handle_toggle_devtools_click(app_handle);
                }
                id if id == menu::PRINT_ITEM_ID => {
                    menu::handle_print_click(app_handle);
                }
                id if id == menu::NEW_WINDOW_ITEM_ID => {
                    menu::handle_new_window_click(app_handle);
                }
                id if id == menu::DUPLICATE_WINDOW_ITEM_ID => {
                    // 複製の中身(root・文書・展開)は窓しか知らないので、
                    // Open 系と同じくフォーカス中の窓へ投げて任せる(要件#34)。
                    menu::handle_menu_open_click(app_handle, menu::MENU_DUPLICATE_WINDOW_EVENT);
                }
                id if id == menu::ZOOM_IN_ITEM_ID => {
                    // 倍率も対象ビューアの判定もフロント側にしかないので、
                    // Open 系と同じくフォーカス中の窓へ投げて任せる(要件#36)。
                    menu::handle_menu_open_click(app_handle, menu::MENU_ZOOM_IN_EVENT);
                }
                id if id == menu::ZOOM_OUT_ITEM_ID => {
                    menu::handle_menu_open_click(app_handle, menu::MENU_ZOOM_OUT_EVENT);
                }
                id if id == menu::ACTUAL_SIZE_ITEM_ID => {
                    menu::handle_menu_open_click(app_handle, menu::MENU_ZOOM_RESET_EVENT);
                }
                id if id == menu::OPEN_FILE_ITEM_ID => {
                    menu::handle_menu_open_click(app_handle, menu::MENU_OPEN_FILE_EVENT);
                }
                id if id == menu::OPEN_FOLDER_ITEM_ID => {
                    menu::handle_menu_open_click(app_handle, menu::MENU_OPEN_FOLDER_EVENT);
                }
                id if id == menu::EDIT_ITEM_ID => {
                    // 編集に入れる文書かも、いま編集中かも窓の側にしかないので、
                    // Open 系と同じくフォーカス中の窓へ投げて任せる(要件#48 追補b)。
                    menu::handle_menu_open_click(app_handle, menu::MENU_EDIT_EVENT);
                }
                id if id == menu::SAVE_ITEM_ID => {
                    // 編集中かどうかも保存する中身も窓の側にしかないので、
                    // Open 系と同じくフォーカス中の窓へ投げて任せる(要件#48)。
                    menu::handle_menu_open_click(app_handle, menu::MENU_SAVE_EVENT);
                }
                _ => {}
            });

            // --- IPC Server: single-instance lock + socket server ---
            let lock_path = default_lock_path();
            match FileLock::try_acquire(&lock_path) {
                Ok(Some(lock)) => {
                    // We are the Main Process. Start the IPC server.
                    let socket_path = default_socket_path();
                    let app_handle_for_ipc = app.handle().clone();
                    let ipc_result = tauri::async_runtime::block_on(async move {
                        let (server, cmd_rx) = IpcServer::start(&socket_path)?;
                        spawn_command_handler(app_handle_for_ipc, cmd_rx);
                        Ok::<_, std::io::Error>((server, socket_path))
                    });
                    match ipc_result {
                        Ok((server, socket_path)) => {
                            // Keep the lock and server alive for the app lifetime
                            // by storing them in a managed state.
                            app.manage(IpcResources {
                                _lock: lock,
                                _server: server,
                            });

                            tracing::info!(
                                "IPC server started on {}",
                                socket_path.display()
                            );
                        }
                        Err(e) => {
                            tracing::error!("Failed to start IPC server: {}", e);
                            // Continue without IPC — the app still works as a
                            // standalone window.
                        }
                    }
                }
                Ok(None) => {
                    // Another instance holds the lock. In a full CLI flow we
                    // would delegate to the other instance and exit, but for
                    // now we just log and continue (the GUI was already shown).
                    tracing::warn!(
                        "Another Vellis instance holds the lock at {}",
                        lock_path.display()
                    );
                }
                Err(e) => {
                    tracing::error!("Failed to acquire lock: {}", e);
                }
            }

            // --- Update notification (要件#14) ---
            // One task for the whole process (single instance = one Rust
            // process behind every window). It is a no-op on the dev
            // channel, and every failure inside it is a log line only.
            update_check::spawn_poller(app.handle().clone());

            // --- SpaceMouse (要件#24 / #25) ---
            // One input source for the process; it emits `spacemouse_input`
            // to every window and the 3D viewer picks it up while it is on
            // screen. The source is decided once here: the 3DconnexionClient
            // framework when 3DxWare is installed (it seizes the device, so
            // raw HID reads nothing), otherwise the raw HID reader. No device
            // (the common case) is not an error. The handle is kept in
            // managed state so dropping it on shutdown stops the reader
            // thread / unregisters the SDK client.
            app.manage(spacemouse::start(app.handle().clone()));

            // Register the default window created by tauri.conf.json with the
            // CLI-derived initial arguments.
            let wm_clone = window_manager.clone();
            let initial_args_clone = initial_args.clone();
            tauri::async_runtime::spawn(async move {
                let mut wm = wm_clone.lock().await;
                wm.register_window("main".into(), initial_args_clone);
            });

            // Hook into window creation events for tracking.
            let wm_for_events = app.state::<AppState>().window_manager.clone();
            app.listen("tauri://window-created", move |_event| {
                // New windows created via `new_window` command are already
                // registered in WindowManager before the window is built,
                // so this hook is a no-op for now.
                let _ = &wm_for_events;
            });

            // Hook into window destroy events to unregister and potentially exit.
            let wm_for_destroy = app.state::<AppState>().window_manager.clone();
            let app_handle_for_destroy = app.handle().clone();
            app.listen("tauri://destroyed", move |event| {
                let wm = wm_for_destroy.clone();
                let app_handle = app_handle_for_destroy.clone();
                // Extract window label from the event payload if possible.
                // The event payload for window destruction contains the label.
                if let Some(label) = extract_window_label_from_event(&event) {
                    tauri::async_runtime::spawn(async move {
                        let mut manager = wm.lock().await;
                        manager.unregister_window(&label);
                        tracing::debug!(
                            "Window '{}' destroyed, {} remaining",
                            label,
                            manager.window_count()
                        );
                        // Exit the application when all windows are closed.
                        if manager.window_count() == 0 {
                            tracing::info!("All windows closed — exiting");
                            app_handle.exit(0);
                        }
                    });
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Resources kept alive for the lifetime of the application.
///
/// Dropping `IpcResources` releases the file lock and stops the IPC server.
struct IpcResources {
    _lock: FileLock,
    _server: IpcServer,
}

/// Attempt to extract a window label from a Tauri event.
fn extract_window_label_from_event(event: &tauri::Event) -> Option<String> {
    // Tauri 2.x event payloads for window events contain the window label
    // as a JSON string in the payload.
    let payload = event.payload();
    serde_json::from_str::<String>(payload).ok()
}
