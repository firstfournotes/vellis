//! CLI argument definitions for the `vellis` command.

use clap::Parser;

#[derive(Parser, Debug)]
#[command(name = "vellis", version, about = "A read-only Markdown viewer")]
pub struct Cli {
    /// Target path or URI (file, directory, ssh://..., et://...)
    pub path: Option<String>,

    /// Switch the root of the running instance instead of opening a new file
    #[arg(short = 'r', long = "root")]
    pub root_switch: bool,

    /// Force a new window even if an instance is already running
    #[arg(short = 'n', long = "new-window")]
    pub new_window: bool,

    /// Do not fork; run the main process in foreground (for debugging)
    #[arg(long = "foreground", hide = true)]
    pub foreground: bool,

    /// Install a `vellis` symlink into `~/.local/bin` so the CLI is on PATH,
    /// then exit. Useful after installing the `.dmg` to `/Applications`.
    #[arg(long = "install-cli")]
    pub install_cli: bool,

    /// Open the marks sidebar (ai-collab) on startup, or focus the
    /// existing instance with the sidebar visible.
    #[arg(long = "marks")]
    pub marks: bool,

    /// Open the marks sidebar filtered to drifted marks
    /// (status = changed_by_agent / stale).  Implies `--marks`.
    #[arg(long = "changed")]
    pub changed: bool,

    /// Run an AI agent (defined in `~/.config/vellis/agents.toml`)
    /// against the current `.vellis/agent-inbox.md` and exit.  CLI-only
    /// — Tauri capabilities unaffected (`docs/ai-collab.md` §9.2).
    #[arg(long = "fix", value_name = "AGENT")]
    pub fix: Option<String>,

    /// Override the inbox path used by `--fix`.  Defaults to
    /// `<root>/.vellis/agent-inbox.md`.
    #[arg(long = "inbox", value_name = "PATH")]
    pub inbox: Option<std::path::PathBuf>,

    /// Verbosity (repeat -v for more: -v, -vv, -vvv)
    #[arg(short = 'v', long, action = clap::ArgAction::Count)]
    pub verbose: u8,

    /// Print build info (version / channel / flags) as JSON to stdout
    /// and exit. Used by the CI release-channel smoke since
    /// `get_build_info` is an IPC command not otherwise shell-invokable
    /// (feature-flags.md §3.6-A / R2-A).
    #[arg(long = "print-build-info")]
    pub print_build_info: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn parse_no_args() {
        let cli = Cli::parse_from(["vellis"]);
        assert!(cli.path.is_none());
        assert!(!cli.root_switch);
        assert!(!cli.new_window);
        assert!(!cli.foreground);
        assert_eq!(cli.verbose, 0);
    }

    #[test]
    fn parse_path_only() {
        let cli = Cli::parse_from(["vellis", "README.md"]);
        assert_eq!(cli.path.as_deref(), Some("README.md"));
        assert!(!cli.root_switch);
        assert!(!cli.new_window);
    }

    #[test]
    fn parse_root_switch() {
        let cli = Cli::parse_from(["vellis", "-r", "./docs"]);
        assert_eq!(cli.path.as_deref(), Some("./docs"));
        assert!(cli.root_switch);
    }

    #[test]
    fn parse_root_switch_long() {
        let cli = Cli::parse_from(["vellis", "--root", "./docs"]);
        assert!(cli.root_switch);
    }

    #[test]
    fn parse_new_window() {
        let cli = Cli::parse_from(["vellis", "-n", "README.md"]);
        assert!(cli.new_window);
        assert_eq!(cli.path.as_deref(), Some("README.md"));
    }

    #[test]
    fn parse_new_window_long() {
        let cli = Cli::parse_from(["vellis", "--new-window", "README.md"]);
        assert!(cli.new_window);
    }

    #[test]
    fn parse_foreground() {
        let cli = Cli::parse_from(["vellis", "--foreground"]);
        assert!(cli.foreground);
    }

    #[test]
    fn parse_verbose_levels() {
        let cli0 = Cli::parse_from(["vellis"]);
        assert_eq!(cli0.verbose, 0);

        let cli1 = Cli::parse_from(["vellis", "-v"]);
        assert_eq!(cli1.verbose, 1);

        let cli2 = Cli::parse_from(["vellis", "-vv"]);
        assert_eq!(cli2.verbose, 2);

        let cli3 = Cli::parse_from(["vellis", "-vvv"]);
        assert_eq!(cli3.verbose, 3);
    }

    #[test]
    fn parse_combined_flags() {
        let cli = Cli::parse_from(["vellis", "-n", "-vv", "--foreground", "file.md"]);
        assert!(cli.new_window);
        assert!(cli.foreground);
        assert_eq!(cli.verbose, 2);
        assert_eq!(cli.path.as_deref(), Some("file.md"));
    }

    #[test]
    fn parse_marks_flag() {
        let cli = Cli::parse_from(["vellis", "--marks"]);
        assert!(cli.marks);
        assert!(cli.path.is_none());
    }

    #[test]
    fn parse_marks_with_path() {
        let cli = Cli::parse_from(["vellis", "--marks", "./docs"]);
        assert!(cli.marks);
        assert_eq!(cli.path.as_deref(), Some("./docs"));
    }

    #[test]
    fn parse_changed_flag() {
        let cli = Cli::parse_from(["vellis", "--changed"]);
        assert!(cli.changed);
        assert!(!cli.marks);
        assert!(cli.path.is_none());
    }

    #[test]
    fn parse_changed_with_path() {
        let cli = Cli::parse_from(["vellis", "--changed", "./docs"]);
        assert!(cli.changed);
        assert_eq!(cli.path.as_deref(), Some("./docs"));
    }

    #[test]
    fn parse_fix_agent() {
        let cli = Cli::parse_from(["vellis", "--fix", "claude"]);
        assert_eq!(cli.fix.as_deref(), Some("claude"));
    }

    #[test]
    fn parse_fix_with_inbox_override() {
        let cli = Cli::parse_from([
            "vellis",
            "--fix",
            "codex",
            "--inbox",
            "/tmp/inbox.md",
        ]);
        assert_eq!(cli.fix.as_deref(), Some("codex"));
        assert_eq!(
            cli.inbox.as_deref(),
            Some(std::path::Path::new("/tmp/inbox.md"))
        );
    }
}
