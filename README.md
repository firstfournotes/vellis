# Vellis

A desktop Markdown viewer for AI-generated documents.

Vellis pairs a tree file explorer with a Markdown viewer and re-renders as files change on disk. It is built for the case where an AI agent is writing the documents and you are reading them: open a folder, watch the rendered output update as the agent edits, copy the *source* Markdown back out, and hand review instructions to the agent without leaving the app.

Vellis is a viewer — it has no editor. The only files it writes are its own metadata under `<root>/.vellis/`, plus the explicit one-click revert that restores a file from a snapshot you took.

## Features

### Viewing

- **Tree explorer** — expand and collapse directories, children load lazily. `Shift`-click an entry to open it in a new window, and the `↑` button in the header moves the root up one directory.
- **Every file is listed** — not just Markdown. Text files open as plain text; known binary formats are listed but not opened.
- **Live reload** — the file on screen re-renders when it changes on disk.
- **GitHub Flavored Markdown + Shiki** — tables, task lists, footnotes and strikethrough, with syntax-highlighted code blocks (11 languages preloaded: TypeScript, JavaScript, Rust, Python, Bash, JSON, YAML, HTML, CSS, Markdown, TOML).
- **GitHub-style alerts** — `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]` and `> [!CAUTION]` blockquotes render as coloured callouts instead of leaking the raw marker text.
- **Mermaid diagrams** — fenced code blocks tagged `mermaid` render as diagrams. Mermaid is loaded on first use, so documents without diagrams never pay for it.
- **HTML files** — `.html` / `.htm` open rendered rather than as source, inside a sandboxed iframe. Scripts never run and links are inert, which makes self-contained AI-generated reports safe to read in place.
- **Images and SVG** — PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG display as images. The default is fit-to-window (never upscaled past actual size) with a toggle for actual size; SVG additionally toggles between the rendered image and its XML source.
- **Resizable explorer pane** — drag the divider between the tree and the viewer. The width is remembered across restarts and new windows.
- **Reload keeps your place** — reloading the window restores the current root, the open file and which directories were expanded. Closing the window or quitting the app clears it.
- **Folder history** — every folder you open is recorded (most recent first, 20 kept). Launching with no arguments shows a picker of that history.
- **Printing** — `File → Print…` (`⌘P`) opens the native print dialog with print-specific styling.
- **Update notification** — Vellis checks for new releases and shows an in-app banner when one is available. It only tells you; it never installs anything. "Download" opens the releases page in your default browser.
- **Single instance** — later launches are handed to the running window over an IPC socket.
- **CLI launch** — `vellis .` or `vellis path/to/file.md` opens directly from the terminal.
- **Remote viewing over SSH/SFTP** — `vellis ssh://user@host/path`, including `~/.ssh/config` host aliases (`vellis ssh://myhost/path`). Authentication falls back from `ssh-agent` to `IdentityFile` (unencrypted keys only), and hosts are verified against `~/.ssh/known_hosts` (trust on first use). Remote files are polled every 2 seconds for changes.

### Copying source Markdown

Vellis puts the **original source** on the clipboard, not the rendered appearance — so pasting into an AI chat keeps the formatting intact.

- **Whole document** — the copy button in the viewer toolbar (`マークダウンをコピー`).
- **Selection** — select a range and press `⌘C`. The selected text comes back as Markdown source with its markup (`**bold**`, list bullets, table pipes) preserved. A partial selection copies only what you selected, not the whole paragraph containing it.

Extraction uses the source offsets recorded by the render pipeline for each node, so it is not affected by line wrapping or whitespace collapsing in the rendered view.

### AI collaboration

Review instructions are saved as **marks** on the document, handed to an AI coding agent (Claude Code, Codex CLI, aider, …), and the result is reviewed as a diff:

- **Add a mark** — select a range, write an instruction, and it is persisted to `<root>/.vellis/marks.jsonl`.
- **Generate an agent briefing** — `<root>/.vellis/agent-inbox.md` is written as an LLM-facing prompt, one section per mark, with file path, line range, selected source and heading path captured automatically.
- **Snapshots** — generating the inbox also copies the affected files to `<root>/.vellis/snapshots/<timestamp>/` (the 20 most recent are kept).
- **Launch an agent** — `vellis --fix <agent>` spawns an agent defined in `~/.config/vellis/agents.toml`. Templates are expanded by plain string substitution without a shell.
- **Drift detection** — after the agent edits, each mark is re-anchored through a five-step ladder (unchanged → moved position → moved section → fuzzy match → stale) and marks that changed or went stale are badged in the sidebar.
- **Diff view** — the diff button next to a mark compares against the snapshot, inline or side-by-side, with hunks overlapping the mark highlighted. One click reverts the file to the snapshot.
- **CLI entry points** — `vellis --marks` opens the sidebar, `vellis --changed` filters it to drifted marks only.

## Installation

Prebuilt `.dmg` files for **macOS (Apple Silicon)** are published on the [GitHub Releases page](https://github.com/firstfournotes/vellis/releases). Release builds are signed and notarized with a Developer ID certificate.

1. Open the `.dmg` and drag `Vellis.app` into `/Applications`.
2. Launch it and choose **Vellis → Install 'vellis' Command in PATH** from the menu bar. A dialog reports the result.
3. Verify:

   ```bash
   vellis --version
   vellis .
   ```

Step 2 has a terminal equivalent, if you prefer:

```bash
/Applications/vellis.app/Contents/MacOS/vellis --install-cli
```

Either way a symlink to the app binary is created at `~/.local/bin/vellis`. If `~/.local/bin` is not on your `PATH`, add it:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

To build for another platform, see [Building from source](#building-from-source). Only macOS on Apple Silicon is released and tested.

## Usage

### Launching

```bash
vellis                         # folder picker / recent-folder history
vellis .                       # open the current directory as root
vellis path/to/file.md         # open a file (its parent becomes the root)
vellis -r path/to/dir          # switch the running window's root
vellis -n file.md              # force a new window
vellis ssh://user@host/path    # open a remote root over SSH
vellis --marks                 # open with the mark sidebar showing
vellis --changed               # open the sidebar filtered to drifted marks
vellis --fix claude            # run an agent from ~/.config/vellis/agents.toml
```

Run `vellis --help` for the full flag list.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘N` | New window |
| `⌘O` | Open a file (the root switches to its parent folder) |
| `⇧⌘O` | Open a folder as the new root |
| `⌘P` | Print |
| `⌘C` | Copy the selection as Markdown source |
| `⌘⏎` | Save the instruction in the mark dialog (`Esc` cancels) |

### Using Vellis with Claude Code

A `/vellis` slash command can point the running Vellis window at your current directory. Create `~/.claude/commands/vellis.md`:

```markdown
---
description: Point Vellis at the current directory
allowed-tools: Bash(vellis:*)
---

Switch the running Vellis window's explorer root to the current directory.

!`vellis -r .`
```

Typing `/vellis` then runs `vellis -r .`, which retargets the running window — or starts Vellis if none is running.

Note that the in-app UI labels are currently in Japanese; the CLI and menu bar are in English.

## Building from source

### Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Rust | stable | compiling the Tauri backend |
| Node.js | v18+ | the SvelteKit frontend |
| pnpm | v9+ | package management |
| Platform SDK | — | Tauri's WebView/window layer |

Install Rust with [rustup](https://rustup.rs/), Node.js however you prefer ([fnm](https://github.com/Schniz/fnm), [nvm](https://github.com/nvm-sh/nvm) or a package manager), and pnpm via `corepack enable && corepack prepare pnpm@latest --activate`.

For the platform SDK: macOS needs the Xcode Command Line Tools (`xcode-select --install`); Linux needs WebKitGTK and friends; Windows needs WebView2 and the Microsoft C++ Build Tools. The [Tauri 2 prerequisites guide](https://v2.tauri.app/start/prerequisites/) covers all three in detail.

### Setup

```bash
git clone https://github.com/firstfournotes/vellis.git
cd vellis
pnpm install
```

The Rust crates are fetched on the first build, which takes a few minutes.

### Development

```bash
pnpm tauri dev     # Tauri dev mode with frontend hot reload
pnpm dev           # frontend only
```

In `pnpm tauri dev` the directory you launched from becomes the initial root.

### Building

```bash
pnpm tauri build --no-bundle   # binary only → src-tauri/target/release/vellis
pnpm tauri build               # full bundle (.app / .dmg)
```

A binary built from source supports the same `--install-cli`:

```bash
./src-tauri/target/release/vellis --install-cli
```

### Tests and checks

```bash
pnpm test                                        # frontend unit tests (vitest)
pnpm check                                       # svelte-check / TypeScript
cargo test --manifest-path src-tauri/Cargo.toml  # Rust tests
pnpm test:e2e                                    # end-to-end (tauri-webdriver; slow)
```

### Releasing

Releases are cut in the development repository: pushing a `v*` tag builds the `.dmg` in CI, signs and notarizes it with a Developer ID certificate, and publishes it to the [Releases page](https://github.com/firstfournotes/vellis/releases). Tagging is preceded by a manual pre-release checklist, because some regressions — CSP, Tauri capabilities, feature flags — only appear in a release build and never in the test suite.

## Architecture

- **Frontend** — SvelteKit (Svelte 5 runes) + TypeScript
- **Desktop shell** — Tauri 2 (Rust)
- **Markdown** — a unified pipeline (remark-parse → remark-gfm → alerts → source map → remark-rehype → rehype-raw → mermaid → Shiki → URI rewrite → rehype-sanitize → rehype-stringify) with custom plugins for source mapping and asset URI rewriting
- **Persistence** — JSON Lines (`marks.jsonl`) written by atomic rename, with a per-store mutex serializing concurrent IPC

## Contributing

Vellis is developed in a private repository. The public repository at [github.com/firstfournotes/vellis](https://github.com/firstfournotes/vellis) receives a source snapshot with every release, so its history is one commit per released version rather than the development history. The design documentation — architecture notes, the implementation guide, the feature-flag mechanism — is kept in that development repository and is not part of the snapshot.

Bug reports and feature requests are very welcome — please open an issue. **Pull requests are not accepted at the moment**: the public repository is a synchronisation target, so a change merged there would be overwritten by the next release. If you have a fix or a feature in mind, describe it in an issue (a patch or a diff in the issue body is perfectly fine) and it will be picked up upstream.

## License

Vellis is released under the MIT License — see [LICENSE](./LICENSE) for the full text.

Copyright (c) 2026 First Four Notes
