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

set -euo pipefail

binary="${VELLIS_E2E_BIN:-}"
root="${VELLIS_E2E_INITIAL_ROOT:-}"

if [[ -z "$binary" ]]; then
	echo "VELLIS_E2E_BIN not set" >&2
	exit 1
fi

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
