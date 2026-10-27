#!/usr/bin/env bash
# E2E orchestration for Vellis (`tests/e2e/`).
#
# Builds the debug binary with the `webdriver` feature, makes sure no
# existing Vellis instance holds the IPC socket, starts the
# `tauri-webdriver` Intermediary Node, runs the WebdriverIO suite, and
# tears the harness down on exit.
#
# Usage:
#   ./scripts/e2e.sh
#   ./scripts/e2e.sh --spec tests/e2e/specs/<one>.e2e.ts   (extra args go to wdio)
#       The app runs with a throwaway home ($VELLIS_E2E_APP_HOME under the
#       per-run temp dir, applied to the app alone by scripts/e2e-launch.sh),
#       so it never touches the user's Recent Files, history or
#       ~/.config/vellis/settings.json (backlog 335).
#   ./scripts/e2e.sh --ssh [--spec …]
#       ssh mode: starts a disposable sshd (scripts/e2e-sshd.sh), gives the
#       app that sshd's environment (its own fake home) through
#       scripts/e2e-launch.sh, and opens the first window on the
#       `ssh://vellis-e2e/...` remote root instead of fixtures/start-root.
#       Without --spec only tests/e2e/specs/ssh-root-gates.e2e.ts runs — the
#       other specs expect the local start-root; another ssh spec is run by
#       naming it with --spec.
#   In both modes XDG_CONFIG_HOME is exported for wdio too (the same value
#   the app gets), so a spec reads or writes the app's settings.json.
#
# Prerequisites:
#   - cargo install tauri-webdriver --locked
#   - pnpm install (root)
#   - No other `vellis` instance running (this script aborts otherwise
#     to avoid hijacking the user's session).

set -euo pipefail
# Enable job control so each backgrounded `cmd &` gets its own process
# group (pgid = pid of the leader). This lets cleanup SIGKILL whole
# subtrees with `kill -- -$pgid`, catching grandchildren that would
# otherwise outlive the parent and keep this script's stdio fds open
# (v0.1.15 release pipeline: tauri-webdriver's child vellis processes
# stalled the GitLab runner for 30+ min even after wdio exited 0).
set -m

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# `--ssh` is ours; everything else goes to wdio untouched.
ssh_mode=0
spec_given=0
wdio_args=()
for arg in "$@"; do
	case "$arg" in
	--ssh) ssh_mode=1 ;;
	*)
		[[ "$arg" == --spec* ]] && spec_given=1
		wdio_args+=("$arg")
		;;
	esac
done
set -- "${wdio_args[@]+"${wdio_args[@]}"}"

if ! command -v tauri-webdriver >/dev/null 2>&1; then
	echo "tauri-webdriver not found — install with: cargo install tauri-webdriver --locked" >&2
	exit 1
fi

echo "==> Building debug binary with webdriver feature (via tauri build)"
# `tauri build --debug --no-bundle` runs `beforeBuildCommand` (= `pnpm build`)
# first, so the SvelteKit static export lands in `build/` before Cargo
# compiles. Going through `cargo build` directly would leave the
# WebView pointing at `devUrl` (Vite dev server) and the WKWebView
# stays at `about:blank` — exactly what tripped earlier iterations.
pnpm --silent tauri build --debug --no-bundle -f webdriver

binary="$repo_root/src-tauri/target/debug/vellis"
if [[ ! -x "$binary" ]]; then
	echo "Built binary not found at $binary" >&2
	exit 1
fi
if [[ ! -f "$repo_root/build/index.html" ]]; then
	echo "Frontend build/index.html missing — pnpm tauri build did not produce static assets." >&2
	exit 1
fi

# Pre-create the fixture trees the spec relies on. The first window's
# initial root comes from tauri-webdriver's cwd (because v0.1.1 ignores
# the documented `tauri:options.args`), so `start-root` MUST exist
# before tauri-webdriver is launched.
fixture_base="$repo_root/tests/e2e/fixtures"
start_root="$fixture_base/start-root"
target_root="$fixture_base/target-root"
rm -rf "$fixture_base"
mkdir -p "$start_root" "$target_root/nested"
printf '# Start\n' >"$start_root/start-doc.md"
printf '# Target child\n' >"$target_root/child-doc.md"

# Isolate IPC from any vellis instance the user may already have open:
# `default_socket_path` / `default_lock_path` (`src-tauri/src/ipc/server.rs`)
# pick `$XDG_RUNTIME_DIR/vellis.{sock,lock}` when that variable is set,
# otherwise `/tmp/vellis-$UID.{sock,lock}`. Pointing it at a freshly
# created per-run dir means the e2e binary always becomes its own
# main process and the user's running `vellis .` is unaffected.
# Outside ssh mode the same dir also holds the app's throwaway home
# (below), so the cleanup's `rm -rf "$xdg_dir"` removes both.
xdg_dir="$(mktemp -d "${TMPDIR:-/tmp}/vellis-e2e-XXXXXX")"
export XDG_RUNTIME_DIR="$xdg_dir"

# Env vars consumed by the spawned Vellis binary AND the wdio runner.
# Exported BEFORE tauri-webdriver starts so it inherits them and
# passes them to its `Command::new(...).spawn()` of the launch wrapper.
#
# - `RUST_LOG=info` surfaces our `tracing::info!` calls from inside
#   the spawned app binary to this script's stdout via tauri-webdriver's
#   inherited stderr.
# - `VELLIS_E2E_BIN` / `VELLIS_E2E_INITIAL_ROOT` are read by
#   `scripts/e2e-launch.sh`, which the WebDriver capabilities point at
#   in lieu of the Vellis binary directly. The wrapper exec's the
#   binary with the initial root path as a CLI arg so `init_window`
#   does not return `needs_root_selection: true` (issue #18 e2e: a
#   `true` would make the Webview block on a folder-picker dialog).
export RUST_LOG="${RUST_LOG:-info}"
export VELLIS_E2E_BIN="$binary"
export VELLIS_E2E_INITIAL_ROOT="$start_root"

# ssh mode: a throwaway sshd on 127.0.0.1 whose keys, agent, fake HOME and
# remote folder live in one temp dir (scripts/e2e-sshd.sh). The harness
# exports (VELLIS_E2E_SSH_URI / _ROOT / _HOME / …) are for the specs; the
# app's own environment (HOME, SSH_AUTH_SOCK, PATH) is applied only inside
# scripts/e2e-launch.sh, never to wdio or tauri-webdriver. XDG_CONFIG_HOME is
# the one exception: the app reads settings.json from there and the specs
# write it, so both must agree.
if ((ssh_mode)); then
	echo "==> Starting the disposable sshd (scripts/e2e-sshd.sh)"
	eval "$(scripts/e2e-sshd.sh start)"
	export VELLIS_E2E_SSH_MODE=1
	export XDG_CONFIG_HOME="$VELLIS_E2E_SSH_HOME/.config"
	if ((!spec_given)); then
		set -- "$@" --spec "tests/e2e/specs/ssh-root-gates.e2e.ts"
	fi
else
	# Not ssh mode: the app still gets a throwaway home of its own (backlog
	# 335). The webdriver build shares the release identifier
	# `com.tetsuo.vellis`, so with the real HOME it writes the test files and
	# folders into the user's `~/Library/Application Support/com.tetsuo.vellis/`
	# `recent-files.json` / `history.json` (Recent Files is capped at 100, so
	# test entries push the user's out) and reads their
	# `~/.config/vellis/settings.json`. scripts/e2e-launch.sh applies HOME /
	# CFFIXED_USER_HOME to the app only — wdio, pnpm and tauri-webdriver keep
	# the real HOME. XDG_CONFIG_HOME is exported for wdio as well, as in ssh
	# mode, so a spec reads the same settings.json the app does.
	export VELLIS_E2E_APP_HOME="$xdg_dir/home"
	mkdir -p "$VELLIS_E2E_APP_HOME"
	export XDG_CONFIG_HOME="$VELLIS_E2E_APP_HOME/.config"
fi

# tauri-webdriver v0.1.1 spawns the application with no CLI args
# regardless of `tauri:options.args`. See `scripts/e2e-launch.sh`
# for how we work around it. The cwd of the proxy doesn't matter
# anymore (the wrapper passes the path explicitly) but we still
# launch from `start_root` for parity with prior runs.
echo "==> Starting tauri-webdriver on :4444 (proxying to plugin :4445)"
(cd "$start_root" && tauri-webdriver --port 4444 --native-port 4445) &
proxy_pid=$!

# SIGKILL the proxy's whole process group (pgid = $proxy_pid under
# `set -m`) so tauri-webdriver and its children — including the spawned
# vellis binary that inherits this script's stdio fds — die together.
# v0.1.15 pipeline observed: graceful SIGTERM + grace-period waits let
# orphaned grandchildren survive past the script exit, keeping the
# GitLab runner's job pipe open for 30+ minutes after `wdio exited 0`
# until the 1h GitLab job timeout fired.
cleanup() {
	echo "==> Tearing down e2e harness"
	# Kill leftover vellis instances first (path matching catches any
	# strays that escaped the proxy's pgid, e.g. forked from a different
	# shell during the run).
	pkill -KILL -f "$binary" 2>/dev/null || true
	# SIGKILL the proxy's whole process group. The `--` is required so
	# `-$pid` is not parsed as an option flag.
	if [[ -n "${proxy_pid:-}" ]]; then
		kill -KILL -- "-$proxy_pid" 2>/dev/null || true
	fi
	# ssh mode: stop sshd + agent and delete their state dir (after the app,
	# which held the connections, is gone).
	if [[ -n "${VELLIS_E2E_SSHD_DIR:-}" && -d "$VELLIS_E2E_SSHD_DIR" ]]; then
		scripts/e2e-sshd.sh clean "$VELLIS_E2E_SSHD_DIR" || true
	fi
	rm -rf "$xdg_dir" 2>/dev/null || true
	# Hard backstop: if anything above still managed to keep our stdio
	# alive, schedule a SIGKILL of the script itself in 5 seconds so the
	# GitLab job slot is released instead of held until the 1h timeout.
	(sleep 5 && kill -KILL "$$" 2>/dev/null) &
}
trap cleanup EXIT

# Give the proxy a moment to bind.
sleep 1

echo "==> Running WebdriverIO suite (XDG_RUNTIME_DIR=$xdg_dir)"
export VELLIS_E2E_BINARY="$repo_root/scripts/e2e-launch.sh"

# Watchdog: bound the wdio run independently of the CI job timeout. It
# caps the failure mode that bit v0.1.14 (wdio finished its spec run but
# the runner process never exited, burning the entire 1h job slot). On
# wdio hang we SIGKILL it so the script can fall through to `cleanup` and
# the job fails fast instead of timing out.
# The full run of every spec took 3 min 56 s on 2026-10-09 (req66 and
# req41 are most of it), so the default is 10 minutes: about 2.5 times the
# run, room for more specs and a slower machine (backlog 329).
# The ssh gate spec waits on the 2-second remote poll many times, so ssh
# mode gets a longer default.
if ((ssh_mode)); then
	WDIO_WATCHDOG_SECONDS="${WDIO_WATCHDOG_SECONDS:-900}"
else
	WDIO_WATCHDOG_SECONDS="${WDIO_WATCHDOG_SECONDS:-600}"
fi
pnpm --silent exec wdio run tests/e2e/wdio.conf.ts "$@" &
wdio_pid=$!
(
	sleep "$WDIO_WATCHDOG_SECONDS"
	if kill -0 "$wdio_pid" 2>/dev/null; then
		echo "==> wdio still alive after ${WDIO_WATCHDOG_SECONDS}s; sending SIGKILL to its pgid" >&2
		# SIGKILL the wdio process group, not just the leader, so any
		# webdriver / browser child inherits the kill.
		kill -KILL -- "-$wdio_pid" 2>/dev/null || true
	fi
) &
watchdog_pid=$!
set +e
wait "$wdio_pid"
wdio_exit=$?
set -e
# Kill the watchdog's whole process group, not just its leader. Under
# `set -m` the inner `sleep $WDIO_WATCHDOG_SECONDS` runs in its own pid
# but shares the watchdog subshell's pgid; killing only the leader
# orphans `sleep` and it keeps the script's stdio fds open until the
# sleep expires. v0.1.16 release pipeline observed this: e2e finished
# in ~5s but the job slot was held for ~5min until the orphaned sleep
# timed out. SIGKILL is used because the leader has already done its
# work — we don't need a graceful shutdown.
kill -KILL -- "-$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
echo "==> wdio exited with status $wdio_exit"
exit "$wdio_exit"
