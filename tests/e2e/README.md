# E2E tests

WebdriverIO + Mocha specs that drive the live Vellis Webview through
[`Choochmeque/tauri-webdriver`](https://github.com/Choochmeque/tauri-webdriver)
and [`Choochmeque/tauri-plugin-webdriver`](https://github.com/Choochmeque/tauri-plugin-webdriver).
Useful for catching regressions that don't show up in `cargo test` /
`vitest` — anything that crosses CLI → IPC → Tauri command → Webview
DOM in a single user gesture.

## Run

```sh
pnpm test:e2e
```

That wraps `scripts/e2e.sh`, which:

1. Builds a debug binary with the `webdriver` Cargo feature and the
   SvelteKit static export. **Note**: the build goes through `pnpm
   tauri build --debug --no-bundle`, not raw `cargo build`. A direct
   `cargo build` produces a binary that points at the Vite `devUrl`
   instead of the embedded `frontendDist` and the Webview hangs at
   `about:blank`.
2. Pre-creates fixtures under `tests/e2e/fixtures/` (gitignored).
3. Sets `XDG_RUNTIME_DIR` to a fresh temp dir so the e2e binary's
   single-instance lock and IPC socket are isolated from any vellis
   the developer may already have running.
4. Creates a throwaway home for the app under that temp dir
   (`VELLIS_E2E_APP_HOME=$XDG_RUNTIME_DIR/home`) and exports
   `XDG_CONFIG_HOME=$VELLIS_E2E_APP_HOME/.config` (backlog 335).
   `scripts/e2e-launch.sh` runs the app alone with `HOME` /
   `CFFIXED_USER_HOME` set to that home — and refuses to start it when
   the variable is missing — so the app never touches the user's Recent
   Files, history (`~/Library/Application Support/com.tetsuo.vellis/`;
   the webdriver build shares the release identifier) or
   `~/.config/vellis/settings.json`. wdio, pnpm and tauri-webdriver keep
   the real `HOME`; `XDG_CONFIG_HOME` reaches wdio too, so a spec reads
   the same `settings.json` the app does. The cleanup deletes the temp
   dir, home included.
5. Starts `tauri-webdriver` (Intermediary Node) on `:4444` with cwd
   = `fixtures/start-root` so the first window's `init_window`
   inherits that directory as its initial root. tauri-webdriver
   v0.1.1 ignores `tauri:options.args`, hence the cwd dance.
6. Runs the WebdriverIO suite at `tests/e2e/wdio.conf.ts`.
7. Tears down the proxy and any leftover vellis processes.

## Prerequisites

- `cargo install tauri-webdriver --locked` — installs the
  Intermediary Node binary used in step 5.
- `pnpm install` at the repo root — pulls in the WebdriverIO devDeps.

## Adding a spec

Create a new file under `tests/e2e/specs/` matching `*.e2e.ts`. Keep
each spec deterministic about cwd / fixtures: the harness only sets
up `start-root` and `target-root`. Anything else should be created
inside the spec's `before()`, prefixed with the test name to avoid
collisions, and removed in `after()`.

## ssh:// roots (disposable sshd)

`scripts/e2e-sshd.sh` starts a throwaway sshd on `127.0.0.1:<free port>` as
the current user. Its keys, agent, fake `HOME`/`known_hosts`, ssh config
(alias `vellis-e2e`) and remote root all live in one temp dir, and the real
`~/.ssh` is never touched.

```sh
pnpm test:e2e --ssh                         # = scripts/e2e.sh --ssh
scripts/e2e.sh --ssh --spec tests/e2e/specs/ssh-root-gates.e2e.ts
scripts/e2e.sh --ssh --spec tests/e2e/specs/ssh-watch-first-stat.e2e.ts   # 要件#5 追補b
```

In ssh mode `scripts/e2e.sh`:

1. starts the sshd (`scripts/e2e-sshd.sh start`) after the build and exports
   its harness variables for the specs — `VELLIS_E2E_SSH_URI`
   (`ssh://vellis-e2e/<dir>/root`), `VELLIS_E2E_SSH_ROOT` (the same folder as
   a local path, so a spec writes its fixture straight into it),
   `VELLIS_E2E_SSH_HOME`, `VELLIS_E2E_SSH_ALIAS`, …;
2. sets `VELLIS_E2E_SSH_MODE=1`, which makes `scripts/e2e-launch.sh` run the
   app as `e2e-sshd.sh exec -- vellis "$VELLIS_E2E_SSH_URI"`: the app alone
   gets the fake `HOME` / `CFFIXED_USER_HOME`, `SSH_AUTH_SOCK` and a `PATH`
   whose `ssh` forces `-F <dir>/ssh_config` (`ssh -G vellis-e2e` resolves
   without the real `~/.ssh/config`). wdio, pnpm and tauri-webdriver keep the
   real `HOME`;
3. exports `XDG_CONFIG_HOME=$VELLIS_E2E_SSH_HOME/.config` for wdio as well —
   the one value the app and the specs must agree on (the app reads
   `settings.json` from there; `ssh-root-gates.e2e.ts` writes it for the
   exclude-list gate);
4. runs only `tests/e2e/specs/ssh-root-gates.e2e.ts` unless `--spec` is given
   (the other specs expect the local `fixtures/start-root`), with a 900 s
   watchdog;
5. stops sshd and the agent and deletes the state dir in the cleanup, after
   the app.

`ssh-root-gates.e2e.ts` skips itself when `VELLIS_E2E_SSH_MODE` is not set,
so the ordinary full run is unaffected. The remote folder is polled over
sftp every 2 s (the open document and the root listing), expanded subfolders
are not watched at all (requirement #18 契約⑤): a spec that adds files
remotely either waits for the poll or collapses and re-expands the folder.

Standalone use of the tool:

```sh
eval "$(scripts/e2e-sshd.sh start)"   # exports VELLIS_E2E_SSH_URI, _ROOT, _PORT, _HOME …
scripts/e2e-sshd.sh exec -- "$VELLIS_E2E_BIN" "$VELLIS_E2E_SSH_URI"   # app env: HOME, SSH_AUTH_SOCK, PATH (ssh -F wrapper)
scripts/e2e-sshd.sh drop    # cut live sessions (reconnect gates)
scripts/e2e-sshd.sh clean   # stop sshd + agent, delete the dir
```

`VELLIS_E2E_SSHD_TOFU=1` starts with an empty `known_hosts`, and
`VELLIS_E2E_SSHD_NO_AGENT=1` exercises the IdentityFile fallback. Apply the
app env only to the app process (that is what `scripts/e2e-launch.sh` does),
not to wdio or tauri-webdriver.

## Limitations on macOS

- Only the WKWebView path is exercised. Linux WebKitGTK / Windows
  WebView2 should pass the same specs (the plugin abstracts the
  platform), but those targets aren't part of the local loop yet.
- `getPageSource` returns a stub for WKWebView via the plugin; reach
  into the live DOM via `browser.execute(() => ...)` if you need raw
  HTML in failure-diagnosis branches.
- `tauri-webdriver` v0.1.1 ignores `tauri:options.args`. Pass initial
  args via cwd or an env var the binary already reads (the harness
  uses cwd; the spec's IPC second-invocation uses the binary's CLI
  arg directly because `child_process.spawn` does pass args).
- A `webdriver` build never starts the SpaceMouse input source (requirement #25 addendum b /
  backlog 190): it does not register with 3DxWare or read raw HID, so a
  test app that is killed mid-run cannot leave a stale 3DxWare client
  behind. No local patch is needed before driving a webdriver build.
