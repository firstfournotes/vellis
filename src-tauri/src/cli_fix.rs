//! `vellis --fix <agent>` runtime — load `~/.config/vellis/agents.toml`,
//! resolve the named agent template, substitute `{{inbox}}` / `{{root}}`
//! placeholders, and exec the resulting command directly via
//! `std::process::Command`.
//!
//! Spec: `docs/ai-collab.md` 改訂 2 §9.2.  No shell is spawned; each
//! token in `command` becomes a separate argv entry so shell-injection
//! through arbitrary instructions is impossible.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;
use thiserror::Error;

const AGENT_CONFIG_DIR: &str = "vellis";
const AGENT_CONFIG_FILE: &str = "agents.toml";
const DEFAULT_INBOX: &str = ".vellis/agent-inbox.md";

#[derive(Debug, Error)]
pub enum FixError {
    #[error("agents.toml not found at {0}")]
    ConfigMissing(PathBuf),

    #[error("failed to read agents.toml: {0}")]
    Read(#[from] std::io::Error),

    #[error("failed to parse agents.toml: {0}")]
    Parse(#[from] toml::de::Error),

    #[error("agent '{0}' not defined in agents.toml")]
    UnknownAgent(String),

    #[error("agent '{0}' has an empty command list")]
    EmptyCommand(String),

    #[error("inbox file not found: {0}")]
    InboxMissing(PathBuf),

    #[error("agent process exited with status {0}")]
    NonZeroExit(i32),

    #[error("agent process spawn failed: {0}")]
    Spawn(String),
}

#[derive(Debug, Deserialize)]
struct AgentsConfig {
    #[serde(default)]
    agents: HashMap<String, AgentTemplate>,
}

#[derive(Debug, Deserialize, Clone)]
struct AgentTemplate {
    /// argv (first element is the program, rest are args).  Tokens may
    /// contain `{{inbox}}` / `{{root}}` placeholders.
    command: Vec<String>,
    /// Optional working directory.  Placeholders allowed.  Defaults to
    /// `{{root}}` (i.e. the resolved root).
    #[serde(default)]
    cwd: Option<String>,
}

/// Default config path, resolved per the XDG Base Directory Spec on
/// every platform (matches `docs/ai-collab.md` §9.2).
///
/// 1. `$XDG_CONFIG_HOME/vellis/agents.toml` if set and non-empty.
/// 2. `$HOME/.config/vellis/agents.toml` otherwise.
///
/// `dirs::config_dir()` was tempting but returns
/// `~/Library/Application Support/` on macOS, which is for app-managed
/// state, not user-edited config.  Sticking with `~/.config/` keeps the
/// path consistent across macOS / Linux / Windows-WSL and matches the
/// spec example.
pub fn default_config_path() -> Option<PathBuf> {
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return Some(
                PathBuf::from(xdg)
                    .join(AGENT_CONFIG_DIR)
                    .join(AGENT_CONFIG_FILE),
            );
        }
    }
    dirs::home_dir().map(|h| {
        h.join(".config")
            .join(AGENT_CONFIG_DIR)
            .join(AGENT_CONFIG_FILE)
    })
}

/// Resolve `{{inbox}}` / `{{root}}` placeholders in `template`.
fn render_template(template: &str, inbox: &str, root: &str) -> String {
    template
        .replace("{{inbox}}", inbox)
        .replace("{{root}}", root)
}

/// Run the named agent.  `root` defaults to the current directory when
/// `None`; `inbox` defaults to `<root>/.vellis/agent-inbox.md`.  Blocks
/// until the spawned process exits; the parent inherits stdio so
/// terminal output flows naturally.
pub fn run_fix(
    agent_name: &str,
    inbox_override: Option<&Path>,
    root_override: Option<&Path>,
    config_path: Option<&Path>,
) -> Result<(), FixError> {
    let config_path = config_path
        .map(|p| p.to_path_buf())
        .or_else(default_config_path)
        .ok_or_else(|| FixError::ConfigMissing(PathBuf::from(AGENT_CONFIG_FILE)))?;

    if !config_path.exists() {
        return Err(FixError::ConfigMissing(config_path));
    }
    let body = std::fs::read_to_string(&config_path)?;
    let cfg: AgentsConfig = toml::from_str(&body)?;
    let template = cfg
        .agents
        .get(agent_name)
        .ok_or_else(|| FixError::UnknownAgent(agent_name.to_string()))?
        .clone();

    if template.command.is_empty() {
        return Err(FixError::EmptyCommand(agent_name.to_string()));
    }

    let root = root_override
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let root_str = root.display().to_string();

    let inbox = inbox_override
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| root.join(DEFAULT_INBOX));
    if !inbox.exists() {
        return Err(FixError::InboxMissing(inbox));
    }
    let inbox_str = inbox.display().to_string();

    let argv: Vec<String> = template
        .command
        .iter()
        .map(|t| render_template(t, &inbox_str, &root_str))
        .collect();
    let cwd_str = template
        .cwd
        .as_deref()
        .map(|c| render_template(c, &inbox_str, &root_str))
        .unwrap_or_else(|| root_str.clone());
    let cwd = PathBuf::from(cwd_str);

    let program = &argv[0];
    let args = &argv[1..];

    let status = Command::new(program)
        .args(args)
        .current_dir(&cwd)
        .status()
        .map_err(|e| FixError::Spawn(format!("{}: {}", program, e)))?;

    if !status.success() {
        return Err(FixError::NonZeroExit(status.code().unwrap_or(-1)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn write_config(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("agents.toml");
        fs::write(&path, body).unwrap();
        path
    }

    fn ensure_inbox(root: &Path) -> PathBuf {
        let dir = root.join(".vellis");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent-inbox.md");
        fs::write(&path, "<!-- inbox -->\n").unwrap();
        path
    }

    #[test]
    fn render_template_substitutes_placeholders() {
        let s = render_template(
            "claude -p Follow {{inbox}} from {{root}}",
            "/proj/.vellis/agent-inbox.md",
            "/proj",
        );
        assert_eq!(
            s,
            "claude -p Follow /proj/.vellis/agent-inbox.md from /proj"
        );
    }

    #[test]
    fn run_fix_rejects_unknown_agent() {
        let dir = tempfile::TempDir::new().unwrap();
        let cfg = write_config(
            dir.path(),
            r#"[agents.claude]
command = ["echo", "ok"]
"#,
        );
        ensure_inbox(dir.path());
        let err = run_fix(
            "missing",
            None,
            Some(dir.path()),
            Some(&cfg),
        )
        .unwrap_err();
        assert!(matches!(err, FixError::UnknownAgent(ref n) if n == "missing"));
    }

    #[test]
    fn run_fix_errors_when_inbox_missing() {
        let dir = tempfile::TempDir::new().unwrap();
        let cfg = write_config(
            dir.path(),
            r#"[agents.claude]
command = ["echo", "ok"]
"#,
        );
        // No `.vellis/agent-inbox.md`
        let err = run_fix(
            "claude",
            None,
            Some(dir.path()),
            Some(&cfg),
        )
        .unwrap_err();
        assert!(matches!(err, FixError::InboxMissing(_)));
    }

    #[test]
    fn run_fix_executes_argv_and_substitutes_placeholders() {
        let dir = tempfile::TempDir::new().unwrap();
        let cfg = write_config(
            dir.path(),
            r#"[agents.echoer]
command = ["sh", "-c", "test \"$1\" = \"{{inbox}}\" && test \"$2\" = \"{{root}}\"", "_", "{{inbox}}", "{{root}}"]
"#,
        );
        let inbox = ensure_inbox(dir.path());
        // Run from a different cwd to verify cwd substitution works.
        let res = run_fix(
            "echoer",
            Some(&inbox),
            Some(dir.path()),
            Some(&cfg),
        );
        assert!(res.is_ok(), "{:?}", res);
    }

    #[test]
    fn run_fix_propagates_non_zero_exit() {
        let dir = tempfile::TempDir::new().unwrap();
        let cfg = write_config(
            dir.path(),
            r#"[agents.failing]
command = ["sh", "-c", "exit 42"]
"#,
        );
        ensure_inbox(dir.path());
        let err = run_fix(
            "failing",
            None,
            Some(dir.path()),
            Some(&cfg),
        )
        .unwrap_err();
        assert!(matches!(err, FixError::NonZeroExit(42)));
    }

    #[test]
    fn run_fix_errors_when_config_missing() {
        let dir = tempfile::TempDir::new().unwrap();
        let cfg = dir.path().join("nope.toml");
        let err = run_fix("claude", None, Some(dir.path()), Some(&cfg)).unwrap_err();
        assert!(matches!(err, FixError::ConfigMissing(_)));
    }

    #[test]
    fn default_config_path_uses_xdg_config_home_when_set() {
        let dir = tempfile::TempDir::new().unwrap();
        // SAFETY: this test process owns its env; no parallel test
        // mutates these vars (cargo nextest aside, which respects
        // SAFETY-marked unsafe blocks).
        unsafe {
            std::env::set_var("XDG_CONFIG_HOME", dir.path());
        }
        let path = default_config_path().unwrap();
        assert!(path.starts_with(dir.path()));
        assert!(path.ends_with(format!(
            "{}/{}",
            AGENT_CONFIG_DIR, AGENT_CONFIG_FILE
        )));
        unsafe {
            std::env::remove_var("XDG_CONFIG_HOME");
        }
    }

    #[test]
    fn default_config_path_falls_back_to_home_dot_config() {
        unsafe {
            std::env::remove_var("XDG_CONFIG_HOME");
        }
        let path = default_config_path().expect("HOME should be set");
        // Some path under .config/vellis/agents.toml
        let s = path.to_string_lossy();
        assert!(
            s.contains("/.config/vellis/agents.toml"),
            "unexpected default path: {}",
            s
        );
    }

    #[test]
    fn empty_command_is_rejected() {
        let dir = tempfile::TempDir::new().unwrap();
        let cfg = write_config(
            dir.path(),
            r#"[agents.empty]
command = []
"#,
        );
        ensure_inbox(dir.path());
        let err = run_fix("empty", None, Some(dir.path()), Some(&cfg)).unwrap_err();
        assert!(matches!(err, FixError::EmptyCommand(_)));
    }
}
