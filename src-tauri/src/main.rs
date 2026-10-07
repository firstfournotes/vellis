// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use clap::Parser;

use vellis_lib::cli::Cli;
use vellis_lib::cli_fix;
use vellis_lib::cli_install;
use vellis_lib::ipc::client::IpcClient;
use vellis_lib::ipc::launch::{launch, Launch, LaunchError, STARTUP_RESPONSE_WAIT, STARTUP_WAIT};
use vellis_lib::ipc::protocol::{Request, Response};
use vellis_lib::ipc::server::{default_lock_path, default_socket_path};
use vellis_lib::self_check;
use vellis_lib::window::manager::WindowArgs;

fn main() {
    let cli = Cli::parse();

    // `--self-check <file>` (requirements.md #72) never talks to a running
    // instance: it branches off before the IPC probe / send and before any
    // request is built, and runs its own Tauri app with no lock, no IPC
    // server and no other side effects (契約2・8). It always exits from in
    // there: 0 after printing the JSON report, 6 when it could not run.
    if let Some(ref target) = cli.self_check {
        let file = match self_check::resolve_target(target) {
            Ok(file) => file,
            Err(reason) => self_check::not_runnable(&reason),
        };
        self_check::run(file);
    }

    // `--print-build-info` is short-circuited before any IPC / Tauri
    // work: pure stdout side-effect used by the CI release-channel smoke
    // (feature-flags.md §3.6-A / R2-A).
    if cli.print_build_info {
        let info = vellis_lib::commands::build_info::get_build_info();
        match serde_json::to_string(&info) {
            Ok(json) => {
                println!("{}", json);
                std::process::exit(0);
            }
            Err(e) => {
                eprintln!("vellis --print-build-info: {}", e);
                std::process::exit(5);
            }
        }
    }

    // `--fix <agent>` is short-circuited before any IPC / Tauri work:
    // it is purely a CLI side-effect (spawn external AI agent against
    // the local inbox).  Capabilities and Webview state are untouched
    // (`docs/ai-collab.md` §9.2).
    if let Some(ref agent) = cli.fix {
        match cli_fix::run_fix(agent, cli.inbox.as_deref(), None, None) {
            Ok(()) => std::process::exit(0),
            Err(e) => {
                eprintln!("vellis --fix: {}", e);
                std::process::exit(4);
            }
        }
    }

    if cli.install_cli {
        match cli_install::install_cli() {
            Ok(result) => {
                println!("✓ Installed: {}", result.target_path.display());
                println!("  → {}", result.source_path.display());
                println!();
                if result.target_dir_on_path {
                    println!("You can now run `vellis` from any shell.");
                } else {
                    let dir = result
                        .target_path
                        .parent()
                        .map(|p| p.display().to_string())
                        .unwrap_or_default();
                    println!("⚠ {} is not on your PATH.", dir);
                    println!("  Add it with:");
                    println!();
                    println!("    echo 'export PATH=\"$HOME/.local/bin:$PATH\"' >> ~/.zshrc");
                    println!("    source ~/.zshrc");
                }
                std::process::exit(0);
            }
            Err(e) => {
                eprintln!("vellis: failed to install CLI symlink: {}", e);
                std::process::exit(1);
            }
        }
    }

    // Build the tokio runtime for the CLI probe/send path.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime");

    let socket_path = default_socket_path();

    // Determine the request to send (if any) based on CLI flags.
    let request = build_request(&cli);

    // Probe the existing instance.
    let instance_running = rt.block_on(IpcClient::probe(&socket_path));

    if instance_running {
        // Wait up to STARTUP_RESPONSE_WAIT, not 500ms: a Main Process that has
        // just bound its socket may take longer to answer while its window is
        // being created (backlog 314・要件#3 追補d 契約1).
        if let Some(req) = request {
            match rt.block_on(IpcClient::send_with_timeout(
                &socket_path,
                &req,
                STARTUP_RESPONSE_WAIT,
            )) {
                Ok(Response::Ok) => std::process::exit(0),
                Ok(Response::Error { code, message }) => {
                    eprintln!("vellis: server error [{}]: {}", code, message);
                    std::process::exit(3);
                }
                Err(e) => {
                    eprintln!("vellis: IPC error: {}", e);
                    std::process::exit(3);
                }
            }
        } else {
            // No specific request; just bring to front (Ping).
            match rt.block_on(IpcClient::send_with_timeout(
                &socket_path,
                &Request::Ping,
                STARTUP_RESPONSE_WAIT,
            )) {
                Ok(_) => std::process::exit(0),
                Err(e) => {
                    eprintln!("vellis: IPC error: {}", e);
                    std::process::exit(3);
                }
            }
        }
    }

    // No existing instance. Become the Main Process only by taking the
    // single-instance lock before Tauri starts; when another `vellis` is
    // starting (it holds the lock), wait for its socket and hand the request
    // there instead (要件#3 追補b 契約1〜4).
    let request = request.unwrap_or(Request::Ping);
    let lock_path = default_lock_path();
    match rt.block_on(launch(
        &socket_path,
        &lock_path,
        &request,
        STARTUP_WAIT,
    )) {
        Ok(Launch::Main(lock)) => {
            // Drop the CLI runtime before starting Tauri (which has its own).
            drop(rt);
            vellis_lib::run_as_main(build_initial_args(&cli), lock);
        }
        // Same exit codes as when the instance was already running.
        Ok(Launch::Delivered(Response::Ok)) => std::process::exit(0),
        Ok(Launch::Delivered(Response::Error { code, message })) => {
            if request == Request::Ping {
                std::process::exit(0);
            }
            eprintln!("vellis: server error [{}]: {}", code, message);
            std::process::exit(3);
        }
        // The lock file itself cannot be opened / locked (not a lost race):
        // warn and start alone without the lock and without an IPC server,
        // as before 追補b (要件#3 追補b 契約7・backlog 313).
        Err(LaunchError::Lock(e)) => {
            eprintln!(
                "vellis: warning: cannot open the single-instance lock file {}: {}; \
                 starting without the single-instance lock",
                lock_path.display(),
                e
            );
            drop(rt);
            vellis_lib::run_with_args(build_initial_args(&cli));
        }
        Err(LaunchError::Timeout) => {
            eprintln!(
                "vellis: another Vellis is starting but did not answer within {}s",
                STARTUP_WAIT.as_secs()
            );
            std::process::exit(3);
        }
        Err(e) => {
            eprintln!("vellis: {}", e);
            std::process::exit(3);
        }
    }
}

/// Convert CLI arguments into the initial `WindowArgs` for the first window.
///
/// - A path pointing to a directory becomes `root`.
/// - A path pointing to a file becomes `initial_path` (its parent is used as root).
/// - If no path is provided, returns default args (cwd fallback applies).
///
/// The file/directory split lives in `WindowArgs::for_open_target`, shared
/// with the IPC `OpenPath` handler so both launch paths classify a target
/// the same way (issue #20).
fn build_initial_args(cli: &Cli) -> WindowArgs {
    let Some(path) = cli.path.as_deref() else {
        return WindowArgs {
            show_marks: cli.marks || cli.changed,
            show_changed: cli.changed,
            ..WindowArgs::default()
        };
    };

    let uri = resolve_path_to_uri(path);
    let mut args = WindowArgs::for_open_target(&uri);

    // `--root` forces the target to become the root even when it looks
    // like a file.
    if cli.root_switch {
        args.initial_path = None;
        args.root = Some(uri);
    }

    args.show_marks = cli.marks || cli.changed;
    args.show_changed = cli.changed;
    args
}

/// Build an IPC `Request` from the parsed CLI arguments.
///
/// Returns `None` if no path was specified and no special flag was set.
fn build_request(cli: &Cli) -> Option<Request> {
    // `--changed` (drift filter) takes priority over `--marks`.  Without
    // a path, send the focus-only request to the running instance.
    if cli.path.is_none() {
        if cli.changed {
            return Some(Request::ShowChanged);
        }
        if cli.marks {
            return Some(Request::ShowMarks);
        }
    }

    let path = cli.path.as_deref()?;

    // Resolve the path to an absolute URI.
    let uri = resolve_path_to_uri(path);

    if cli.root_switch {
        Some(Request::SwitchRoot { uri })
    } else {
        Some(Request::OpenPath {
            uri,
            new_window: cli.new_window,
        })
    }
}

/// Convert a CLI path argument to a `file://` URI.
///
/// If the path is already a URI (contains `://`), it is returned as-is.
/// Otherwise, it is resolved relative to the current directory and
/// converted to a `file://` URI.
fn resolve_path_to_uri(path: &str) -> String {
    if path.contains("://") {
        return path.to_string();
    }

    let abs = if std::path::Path::new(path).is_absolute() {
        std::path::PathBuf::from(path)
    } else {
        std::env::current_dir()
            .unwrap_or_default()
            .join(path)
    };

    // Canonicalize if possible, but fall back to the joined path.
    let canonical = abs.canonicalize().unwrap_or(abs);
    format!("file://{}", canonical.display())
}

#[cfg(test)]
mod tests {
    use super::*;
    use vellis_lib::cli::Cli;

    #[test]
    fn build_request_no_path() {
        let cli = Cli::parse_from(["vellis"]);
        assert!(build_request(&cli).is_none());
    }

    #[test]
    fn build_request_open_path() {
        let cli = Cli::parse_from(["vellis", "/tmp/test.md"]);
        let req = build_request(&cli).unwrap();
        match req {
            Request::OpenPath { uri, new_window } => {
                assert!(uri.starts_with("file:///tmp/test.md"));
                assert!(!new_window);
            }
            _ => panic!("expected OpenPath"),
        }
    }

    #[test]
    fn build_request_new_window() {
        let cli = Cli::parse_from(["vellis", "-n", "/tmp/test.md"]);
        let req = build_request(&cli).unwrap();
        match req {
            Request::OpenPath { new_window, .. } => assert!(new_window),
            _ => panic!("expected OpenPath"),
        }
    }

    #[test]
    fn build_request_switch_root() {
        let cli = Cli::parse_from(["vellis", "-r", "/tmp/docs"]);
        let req = build_request(&cli).unwrap();
        match req {
            Request::SwitchRoot { uri } => {
                assert!(uri.starts_with("file:///tmp/docs"));
            }
            _ => panic!("expected SwitchRoot"),
        }
    }

    #[test]
    fn build_request_marks_only() {
        let cli = Cli::parse_from(["vellis", "--marks"]);
        let req = build_request(&cli).unwrap();
        assert_eq!(req, Request::ShowMarks);
    }

    #[test]
    fn build_request_marks_with_path_prefers_path_request() {
        let cli = Cli::parse_from(["vellis", "--marks", "/tmp/test.md"]);
        let req = build_request(&cli).unwrap();
        match req {
            Request::OpenPath { uri, .. } => assert!(uri.starts_with("file:///tmp/test.md")),
            _ => panic!("expected OpenPath"),
        }
    }

    #[test]
    fn build_initial_args_marks_only_propagates_show_marks() {
        let cli = Cli::parse_from(["vellis", "--marks"]);
        let args = build_initial_args(&cli);
        assert!(args.show_marks);
        assert!(!args.show_changed);
        assert!(args.initial_path.is_none());
        assert!(args.root.is_none());
    }

    #[test]
    fn build_request_changed_only() {
        let cli = Cli::parse_from(["vellis", "--changed"]);
        let req = build_request(&cli).unwrap();
        assert_eq!(req, Request::ShowChanged);
    }

    #[test]
    fn build_initial_args_changed_implies_show_marks() {
        let cli = Cli::parse_from(["vellis", "--changed"]);
        let args = build_initial_args(&cli);
        assert!(args.show_marks);
        assert!(args.show_changed);
    }

    /// 要件72 AC-72-2(契約2): `--self-check` は既存インスタンスへの要求を作らない。
    /// `try_parse_from(...).expect(...)` なので、オプションが未実装のうちはここで赤になる
    /// (`Cli` に `self_check` が無くてもこのモジュールはコンパイルできる)。
    /// 分岐が `IpcClient::probe` より前にあることは
    /// `tests/acceptance_req72.rs::ac72_2_main_branches_to_self_check_before_ipc_probe`
    /// がソース走査で見る。
    #[test]
    fn build_request_self_check_makes_no_request() {
        let cli = Cli::try_parse_from(["vellis", "--self-check", "/tmp/test.md"])
            .expect("--self-check <file> は Cli のオプション(要件72 契約1)");
        assert!(cli.path.is_none());
        assert!(
            build_request(&cli).is_none(),
            "--self-check のとき OpenPath / SwitchRoot / ShowMarks などの要求を組み立てない"
        );
    }

    #[test]
    fn resolve_uri_passthrough() {
        assert_eq!(
            resolve_path_to_uri("ssh://alice@host/notes/"),
            "ssh://alice@host/notes/"
        );
    }

    #[test]
    fn resolve_absolute_path() {
        let uri = resolve_path_to_uri("/tmp/test.md");
        assert!(uri.starts_with("file:///tmp/test.md"));
    }
}
