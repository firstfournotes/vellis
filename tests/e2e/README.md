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
4. Starts `tauri-webdriver` (Intermediary Node) on `:4444` with cwd
   = `fixtures/start-root` so the first window's `init_window`
   inherits that directory as its initial root. tauri-webdriver
   v0.1.1 ignores `tauri:options.args`, hence the cwd dance.
5. Runs the WebdriverIO suite at `tests/e2e/wdio.conf.ts`.
6. Tears down the proxy and any leftover vellis processes.

## Prerequisites

- `cargo install tauri-webdriver --locked` — installs the
  Intermediary Node binary used in step 4.
- `pnpm install` at the repo root — pulls in the WebdriverIO devDeps.

## Adding a spec

Create a new file under `tests/e2e/specs/` matching `*.e2e.ts`. Keep
each spec deterministic about cwd / fixtures: the harness only sets
up `start-root` and `target-root`. Anything else should be created
inside the spec's `before()`, prefixed with the test name to avoid
collisions, and removed in `after()`.

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
