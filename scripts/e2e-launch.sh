#!/usr/bin/env bash
# Launch wrapper for the Vellis binary used by `tauri-webdriver` during
# E2E tests. The upstream `Choochmeque/tauri-webdriver` v0.1.1 spawns
# the application with no CLI args (it ignores `tauri:options.args`),
# but our Vellis binary needs an explicit path argument when launched
# without a real user — otherwise `init_window` returns
# `needs_root_selection: true` and the Webview blocks awaiting a
# folder-picker dialog that no human is around to dismiss, which in
# turn prevents the rest of `onMount` (the `listen` calls for
# `directory_changed` etc.) from running.
#
# This wrapper reads `VELLIS_E2E_INITIAL_ROOT` from the environment
# (set by `scripts/e2e.sh`) and execs the real binary with that path
# as its sole positional argument, so `build_initial_args` resolves a
# concrete root and `needs_root_selection` is `false`.
#
# The app never runs with the user's real HOME (backlog 335): in ssh mode
# it gets the disposable sshd's fake home, otherwise HOME /
# CFFIXED_USER_HOME are set to `VELLIS_E2E_APP_HOME` (the throwaway home
# `scripts/e2e.sh` makes under its per-run temp dir). Without that variable
# the wrapper refuses to start the app.

set -euo pipefail

binary="${VELLIS_E2E_BIN:-}"
root="${VELLIS_E2E_INITIAL_ROOT:-}"
app_home="${VELLIS_E2E_APP_HOME:-}"

if [[ -z "$binary" ]]; then
	echo "VELLIS_E2E_BIN not set" >&2
	exit 1
fi

# ssh mode (`scripts/e2e.sh --ssh`): the app runs with the disposable
# sshd's environment (fake HOME / known_hosts, SSH_AUTH_SOCK, a PATH whose
# `ssh` forces `-F <state>/ssh_config`) and its first window's root is the
# `ssh://vellis-e2e/...` URI of that sshd's remote folder. Only the app is
# wrapped — wdio and tauri-webdriver keep the real HOME. (VELLIS_E2E_APP_HOME
# is not used here: the sshd's fake home plays that role.)
if [[ "${VELLIS_E2E_SSH_MODE:-}" == 1 ]]; then
	sshd_tool="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/e2e-sshd.sh"
	if [[ $# -gt 0 ]]; then
		exec "$sshd_tool" exec -- "$binary" "$@"
	fi
	if [[ -z "${VELLIS_E2E_SSH_URI:-}" ]]; then
		echo "VELLIS_E2E_SSH_MODE=1 but VELLIS_E2E_SSH_URI is not set" >&2
		exit 1
	fi
	exec "$sshd_tool" exec -- "$binary" "$VELLIS_E2E_SSH_URI"
fi

# Not ssh mode: run the app in the throwaway home so it never writes the
# user's Recent Files / history (`~/Library/Application Support/
# com.tetsuo.vellis/` — the webdriver build shares the release identifier)
# or reads their `~/.config/vellis/settings.json`. HOME is what the Rust side
# reads (app data, settings); CFFIXED_USER_HOME is what Cocoa / WebKit read
# (NSHomeDirectory), as in `e2e-sshd.sh exec`. Both exec paths below inherit
# them; wdio and tauri-webdriver keep the real HOME.
# Never fall back to the real HOME when the variable is missing.
if [[ -z "$app_home" ]]; then
	echo "VELLIS_E2E_APP_HOME not set — refusing to run the app with the real HOME (scripts/e2e.sh sets it)" >&2
	exit 1
fi
export HOME="$app_home"
export CFFIXED_USER_HOME="$app_home"

# When invoked with explicit args (the way the spec spawns a second
# `vellis <path>` to test IPC OpenPath routing), pass them through
# verbatim. Only fall back to the env var when no args were given —
# that's tauri-webdriver's spawn path which ignores
# `tauri:options.args`.
if [[ $# -gt 0 ]]; then
	exec "$binary" "$@"
fi

if [[ -z "$root" ]]; then
	echo "VELLIS_E2E_INITIAL_ROOT not set and no args given" >&2
	exit 1
fi

exec "$binary" "$root"
