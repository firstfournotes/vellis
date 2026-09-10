# Vellis

Vellis is a desktop file viewer for Markdown, HTML, images, 3D models, video, audio, and PDF — with in-place text editing.

AI tools now work with a wide range of files. Vellis brings those files into one place for you to browse and inspect, whether you're preparing inputs, reviewing outputs, or simply opening files yourself.

## Features

### What it opens

- **Markdown** — GitHub Flavored Markdown, so tables, task lists, footnotes, strikethrough and `> [!NOTE]`-style alert callouts all render as they do on GitHub. Code blocks are syntax-highlighted by Shiki, with 11 languages preloaded (TypeScript, JavaScript, Rust, Python, Bash, JSON, YAML, HTML, CSS, Markdown, TOML).
- **Diagrams** — fenced blocks tagged `mermaid` render as diagrams. Mermaid is loaded on first use, so documents without diagrams never pay for it.
- **HTML** — `.html` / `.htm` open rendered rather than as source, inside a sandboxed iframe. Scripts never run and links are inert, which makes self-contained AI-generated reports safe to read in place.
- **Images** — the default is fit-to-window (never upscaled past actual size) with a toggle for actual size. SVG opens here too, with a further toggle between the rendered image and its XML source.
- **3D models** — STL (ASCII and binary) and 3MF open as an interactive scene you can rotate, pan and zoom, with the triangle count shown in the toolbar.
- **Video** — plays inline with the system player controls, streamed a range at a time as you seek rather than read whole before it starts. See [Supported formats](#supported-formats) for containers and codecs.
- **Audio** — `.wav`, `.mp3` and `.m4a` play inline, with the waveform of the audio drawn above the transport: a stereo file is split into two lanes, left on top and right below, so you can see which channel a sound is in. Files of around two hours are handled.
- **PDF** — opens in the WebView's built-in PDF viewer, so scrolling, zooming, text selection and copying work as they do in Safari. A file that turns out not to be a PDF shows a placeholder offering to open it in the default application instead.

### Supported formats

| Category | Extensions | How it opens |
|---|---|---|
| Markdown | `.md` `.markdown` `.mdx` | Rendered — GFM, Shiki, alerts, Mermaid |
| HTML | `.html` `.htm` | Rendered in a sandboxed iframe |
| Images | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.avif` `.bmp` `.ico` | Image viewer, fit-to-window or actual size |
| SVG | `.svg` | Image viewer, with a toggle to the XML source |
| 3D models | `.stl` `.3mf` | Interactive scene, mouse or SpaceMouse |
| Video | `.mp4` `.mov` `.webm` | Inline playback, system controls |
| Video (other containers) | `.mkv` `.avi` | Placeholder offering the default application |
| Audio | `.wav` `.mp3` `.m4a` | Inline playback with a stereo waveform |
| PDF | `.pdf` | Built-in PDF viewer, inline |
| Plain text | any other extension | Shown verbatim, editable in place |
| Other binaries | archives, `.flac`, `.ogg`, fonts, TIFF, HEIC, … | Listed in the tree, not opened |

Video and audio decoding is the system WebView's, so H.264, HEVC and ProRes play, AV1 needs an M3-generation Mac or newer, and WebM has to be VP8/Opus — VP9 does not decode. `.flac` and `.ogg` are deliberately left out rather than opened and silently failing, because WebKit's support for them varies by version. Video, audio and PDF on an ssh remote are not opened in place either; they show the placeholder without the opener, as the context menu does for remote entries. A file with an unlisted extension is read as text; the reader has the final say and refuses anything that is not UTF-8 or is larger than 50 MB.

### Editing

Vellis started as a viewer and still behaves like one until you ask it to do otherwise. Nothing is written unless you press save.

- **Edit mode** — double-click the body of a plain-text file, or use **Edit → Edit** (`⌘E`). Markdown and HTML files open the same way into a *source* editing mode showing the raw text behind the rendered page; an HTML page is rendered inside a sandboxed iframe, so `⌘E` is the way in there.
- **Saving** — `⌘S` or **File → Save**. There is no autosave, and the file is written by an atomic replace rather than in place.
- **Snapshots** — every save copies the previous contents to `<root>/.vellis/snapshots/` beforehand, so the diff view's "revert to snapshot" brings back what was there.
- **Unsaved changes** — closing a window, opening another file, changing the root, or leaving edit mode with `Esc` / "Done" while there are unsaved changes asks whether to save, discard or cancel.
- **External changes** — if the file changes on disk while you are editing it, Vellis says so instead of throwing your work away, and lets you either overwrite the file or reload the external version.
- **Off limits** — Vellis never deletes, renames or moves a file, and remote (`ssh://`) roots stay read-only.

### Copying source Markdown

Vellis puts the **original source** on the clipboard, not the rendered appearance — so pasting into an AI chat keeps the formatting intact.

- **Whole document** — the copy button in the viewer toolbar (`マークダウンをコピー`).
- **Selection** — select a range and press `⌘C`. The selected text comes back as Markdown source with its markup (`**bold**`, list bullets, table pipes) preserved. A partial selection copies only what you selected, not the whole paragraph containing it.

Extraction uses the source offsets recorded by the render pipeline for each node, so it is not affected by line wrapping or whitespace collapsing in the rendered view.

### AI collaboration

Review instructions are saved as **marks** on the document, handed to an AI coding agent (Claude Code, Codex CLI, aider, …), and the result is reviewed as a diff:

- **Marks** — select a range, write an instruction, and it is persisted to `<root>/.vellis/marks.jsonl`.
- **Agent briefing** — `<root>/.vellis/agent-inbox.md` is written as an LLM-facing prompt, one section per mark, with file path, line range, selected source and heading path captured automatically.
- **Snapshots** — generating the inbox also copies the affected files to `<root>/.vellis/snapshots/<timestamp>/` (the 20 most recent are kept).
- **Agent launch** — `vellis --fix <agent>` spawns an agent defined in `~/.config/vellis/agents.toml`. Templates are expanded by plain string substitution without a shell.
- **Drift detection** — after the agent edits, each mark is re-anchored through a five-step ladder (unchanged → moved position → moved section → fuzzy match → stale) and marks that changed or went stale are badged in the sidebar.
- **Diff view** — the diff button next to a mark compares against the snapshot, inline or side-by-side, with hunks overlapping the mark highlighted. One click reverts the file to the snapshot.
- **CLI flags** — `vellis --marks` opens the sidebar, `vellis --changed` filters it to drifted marks only.

### Devices and remotes

- **SpaceMouse** — a 3Dconnexion 6DoF device drives the 3D camera in place of the mouse. It works with or without the vendor driver installed (the official `3DconnexionClient` framework when 3DxWare is present, raw HID otherwise) and follows window focus. Nothing is bundled and no device is required.
- **SSH remotes** — a root can live on another machine: `vellis ssh://user@host/path`, including `~/.ssh/config` host aliases. Authentication falls back from `ssh-agent` to `IdentityFile` (unencrypted keys only), hosts are verified against `~/.ssh/known_hosts` (trust on first use), and remote files are polled every 2 seconds for changes.

### Everything else

Live reload (the open file re-renders when it changes on disk and the tree follows), a resizable explorer pane, reload restoring the root and open file and expanded folders, a recent-folder picker, printing (`⌘P`), a Window menu of the open windows, a tree context menu (reveal in the Finder, open with, copy path), single-instance launch, and an update banner that tells you about a new release without ever installing it.

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
| `⌘E` | Edit the current file (or leave edit mode) |
| `⌘S` | Save |
| `Esc` | Leave edit mode (asks first if there are unsaved changes) |
| `⌘P` | Print |
| `⌘C` | Copy the selection as Markdown source |
| `⌘=` / `⌘-` / `⌘0` | Zoom the text in, out, back to actual size |
| `⌘⏎` | Save the instruction in the mark dialog (`Esc` cancels) |

In a video or audio player: `Space` plays and pauses, `←` / `→` step 5 seconds (1 second with `Shift`), and Option+wheel over the waveform zooms its time axis.

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
- **Assets** — images, 3D models, video, audio and PDFs reach the WebView through a custom `vellis-asset://` protocol that answers HTTP range requests with `206` slices, so a large file streams instead of being read whole into memory
- **Waveforms** — an `.mp4` or `.mov` has its audio track extracted in Rust, a `.wav` is decimated to 8 kHz peaks by a streaming RIFF reader that never holds more than a few megabytes, and everything else is decoded in the WebView; the three routes converge on the same peak-and-envelope structures, so zooming, lane splitting and the seek geometry are one set of pure functions
- **3D** — three.js with its STL and 3MF loaders, driving a camera state machine of plain functions that both mouse events and SpaceMouse axes map onto, so the viewer itself carries no per-input-source branching
- **Persistence** — JSON Lines (`marks.jsonl`) written by atomic rename, with a per-store mutex serializing concurrent IPC

## Contributing

Vellis is developed in a private repository. The public repository at [github.com/firstfournotes/vellis](https://github.com/firstfournotes/vellis) receives a source snapshot with every release, so its history is one commit per released version rather than the development history. The design documentation — architecture notes, the implementation guide, the feature-flag mechanism — is kept in that development repository and is not part of the snapshot.

Bug reports and feature requests are very welcome — please open an issue. **Pull requests are not accepted at the moment**: the public repository is a synchronisation target, so a change merged there would be overwritten by the next release. If you have a fix or a feature in mind, describe it in an issue (a patch or a diff in the issue body is perfectly fine) and it will be picked up upstream.

## License

Vellis is released under the MIT License — see [LICENSE](./LICENSE) for the full text.

Copyright (c) 2026 First Four Notes
