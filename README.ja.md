# Vellis

[English](./README.md) | 日本語

Vellis は Markdown・HTML・画像・3D モデル・動画・音声・PDF を開くデスクトップ用ファイルビューアです。テキストのその場編集もできます。

AI ツールはさまざまな種類のファイルを扱うようになりました。Vellis はそれらのファイルを1か所に集めて、入力を用意するとき・出力を確認するとき・単にファイルを開きたいときに、ブラウズして中身を確かめられるようにします。

## 機能

### 開けるもの

- **Markdown** — GitHub Flavored Markdown に対応。表・タスクリスト・脚注・打ち消し線・`> [!NOTE]` 形式のアラートは GitHub と同じ見た目で表示されます。コードブロックは Shiki でシンタックスハイライトされ、11 言語(TypeScript・JavaScript・Rust・Python・Bash・JSON・YAML・HTML・CSS・Markdown・TOML)をあらかじめ読み込んでいます。
- **図** — `mermaid` を指定した fenced ブロックは図として描画されます。Mermaid は初めて使うときに読み込むので、図の無い文書はその分のコストを払いません。
- **HTML** — `.html` / `.htm` はソースではなくレンダリングした状態で、サンドボックス化した iframe の中に開きます。スクリプトは決して動かず、リンクは無効化されるため、AI が生成した自己完結型のレポートをその場で安全に読めます。
- **画像** — 既定はウィンドウに合わせる表示(実サイズを超えて拡大はしない)で、実サイズ表示との切り替えができます。SVG もここで開き、さらにレンダリング画像と XML ソースを切り替えられます。
- **3D モデル** — STL(ASCII・バイナリ)と 3MF を、回転・平行移動・ズームができる対話的なシーンとして開きます。三角形数はツールバーに表示されます。
- **動画** — システムのプレーヤー操作でインラインに再生します。再生前に全体を読み込むのではなく、シークに合わせて範囲ごとにストリーミングします。コンテナとコーデックは[対応形式](#対応形式)を参照してください。
- **音声** — `.wav`・`.mp3`・`.m4a` をインラインに再生し、トランスポートの上に音声の波形を描きます。ステレオのファイルは上が左・下が右の2レーンに分かれるので、どちらのチャンネルに音があるかが見えます。2時間程度のファイルまで扱えます。
- **PDF** — WebView 内蔵の PDF ビューアで開くため、スクロール・ズーム・テキスト選択・コピーが Safari と同じように動きます。PDF ではなかったファイルは、既定のアプリケーションで開くことを提案するプレースホルダーを表示します。

### 対応形式

| 分類 | 拡張子 | 開き方 |
|---|---|---|
| Markdown | `.md` `.markdown` `.mdx` | レンダリング — GFM・Shiki・アラート・Mermaid |
| HTML | `.html` `.htm` | サンドボックス化した iframe でレンダリング |
| 画像 | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.avif` `.bmp` `.ico` | 画像ビューア(ウィンドウに合わせる / 実サイズ) |
| SVG | `.svg` | 画像ビューア(XML ソースへの切り替えあり) |
| 3D モデル | `.stl` `.3mf` | 対話的なシーン(マウスまたは SpaceMouse) |
| 動画 | `.mp4` `.mov` `.webm` | インライン再生(システムの操作 UI) |
| 動画(その他のコンテナ) | `.mkv` `.avi` | 既定のアプリケーションを提案するプレースホルダー |
| 音声 | `.wav` `.mp3` `.m4a` | インライン再生(ステレオ波形付き) |
| PDF | `.pdf` | 内蔵 PDF ビューアでインライン表示 |
| プレーンテキスト | 上記以外の拡張子 | そのまま表示・その場で編集可能 |
| その他のバイナリ | アーカイブ・`.flac`・`.ogg`・フォント・TIFF・HEIC など | ツリーに表示するだけで開かない |

動画と音声のデコードはシステムの WebView が行うため、H.264・HEVC・ProRes は再生でき、AV1 は M3 世代以降の Mac が必要、WebM は VP8/Opus に限られます(VP9 はデコードできません)。`.flac` と `.ogg` は WebKit の対応がバージョンによって異なるため、開いて黙って失敗するより、意図的に対象から外しています。ssh リモート上の動画・音声・PDF もその場では開かず、リモート項目のコンテキストメニューと同様に、開くボタンの無いプレースホルダーを表示します。一覧に無い拡張子のファイルはテキストとして読み込み、最終的な判断は読み込み側が行って、UTF-8 でないものや 50 MB を超えるものは拒否します。

### 編集

Vellis はビューアとして始まり、あなたが求めない限り今もビューアとして振る舞います。保存を押さない限り何も書き込みません。

- **編集モード** — プレーンテキストのファイルは本文をダブルクリック、または **Edit → Edit**(`⌘E`)。Markdown はレンダリングされたブロック(段落・見出し・リスト項目・表のセル・code fence の中身)をその場で編集でき、HTML はレンダリング表示のままテキストノードを編集できます。原文の生テキストを直す *ソース* 編集モードも引き続き使えます。
- **書き戻しの範囲** — Markdown と HTML では、編集したブロック(またはテキストノード)の原文範囲だけを書き換え、それ以外はバイト単位で元のままです。マークアップの構造が変わる編集は拒否され、ファイルが壊れる形では書き込まれません。
- **保存** — `⌘S` または **File → Save**。自動保存はなく、ファイルはその場で上書きするのではなくアトミックな置き換えで書き込まれます。
- **スナップショット** — 保存のたびに、直前の内容を `<root>/.vellis/snapshots/` へ先にコピーします。差分表示の「スナップショットへ戻す」はこれを使って元の内容を戻します。
- **未保存の変更** — 未保存の変更があるままウィンドウを閉じる・別のファイルを開く・ルートを変える・`Esc` / 「Done」で編集モードを抜けると、保存・破棄・キャンセルを尋ねます。
- **外部からの変更** — 編集中にディスク上のファイルが変わったら、作業を捨てるのではなくその旨を伝え、ファイルを上書きするか外部の版を読み直すかを選べます。
- **やらないこと** — Vellis はファイルの削除・改名・移動を決してせず、リモート(`ssh://`)のルートは読み取り専用のままです。

### ソース Markdown のコピー

Vellis はレンダリングされた見た目ではなく**元のソース**をクリップボードに載せます。AI チャットに貼り付けても書式が崩れません。

- **文書全体** — ビューアのツールバーにあるコピーボタン(`Copy Markdown`)。
- **選択範囲** — 範囲を選んで `⌘C`。選択したテキストがマークアップ(`**太字**`・リストの記号・表の縦棒)を保ったまま Markdown ソースとして返ります。部分選択なら、その段落全体ではなく選んだ部分だけがコピーされます。

抽出にはレンダリングパイプラインがノードごとに記録したソースのオフセットを使うため、表示側の折り返しや空白の畳み込みの影響を受けません。

### AI との協働

レビューの指示を文書上の**マーク**として保存し、AI コーディングエージェント(Claude Code・Codex CLI・aider など)に渡して、結果を差分として確認します。

- **マーク** — 範囲を選んで指示を書くと `<root>/.vellis/marks.jsonl` に永続化されます。
- **エージェントへの申し送り** — `<root>/.vellis/agent-inbox.md` が LLM 向けのプロンプトとして書き出されます。マーク1件が1節で、ファイルパス・行範囲・選択したソース・見出しのパスが自動で入ります。
- **スナップショット** — inbox の生成時に、対象ファイルを `<root>/.vellis/snapshots/<timestamp>/` にもコピーします(直近 20 件を保持)。
- **エージェントの起動** — `vellis --fix <agent>` は `~/.config/vellis/agents.toml` に定義したエージェントを起動します。テンプレートはシェルを介さない単純な文字列置換で展開されます。
- **ずれの検出** — エージェントが編集したあと、各マークは5段階(変更なし → 位置が動いた → 節が動いた → あいまい一致 → 失効)で再アンカーされ、動いたり失効したマークにはサイドバーでバッジが付きます。
- **差分表示** — マークの横の差分ボタンでスナップショットと比較します(インラインまたは左右並び)。マークに重なるハンクは強調され、ワンクリックでファイルをスナップショットへ戻せます。
- **CLI フラグ** — `vellis --marks` でサイドバーを開き、`vellis --changed` でずれたマークだけに絞ります。

### デバイスとリモート

- **SpaceMouse** — 3Dconnexion の 6 自由度デバイスでマウスの代わりに 3D カメラを操作できます。ベンダーのドライバの有無にかかわらず動作し(3DxWare があれば公式の `3DconnexionClient` フレームワーク、無ければ生の HID)、ウィンドウのフォーカスに従います。何も同梱せず、デバイスは必須ではありません。
- **SSH リモート** — ルートは別のマシンにあっても構いません: `vellis ssh://user@host/path`(`~/.ssh/config` のホスト別名も可)。認証は `ssh-agent` から `IdentityFile`(暗号化されていない鍵のみ)へフォールバックし、ホストは `~/.ssh/known_hosts` で検証します(初回接続時に信頼)。リモートのファイルは2秒ごとに変更をポーリングします。

### その他

ライブリロード(開いているファイルがディスク上で変わると再描画され、ツリーも追従)・幅を変えられるエクスプローラーペイン・再読み込み時のルートと開いているファイルと展開したフォルダの復元・最近開いたフォルダの選択・印刷(`⌘P`)・開いているウィンドウの Window メニュー・ツリーのコンテキストメニュー(Finder で表示・アプリケーションで開く・パスをコピー)・単一インスタンス起動・新しいリリースを知らせるだけで決して勝手にインストールしない更新バナー。

## インストール

**macOS(Apple Silicon)** 用のビルド済み `.dmg` を [GitHub Releases ページ](https://github.com/firstfournotes/vellis/releases)で公開しています。リリースビルドは Developer ID 証明書で署名・公証済みです。

1. `.dmg` を開き、`Vellis.app` を `/Applications` にドラッグします。
2. 起動して、メニューバーから **Vellis → Install 'vellis' Command in PATH** を選びます。結果がダイアログで表示されます。
3. 確認します:

   ```bash
   vellis --version
   vellis .
   ```

手順 2 はターミナルからも行えます:

```bash
/Applications/vellis.app/Contents/MacOS/vellis --install-cli
```

どちらの方法でも、アプリのバイナリへのシンボリックリンクが `~/.local/bin/vellis` に作られます。`~/.local/bin` が `PATH` に無ければ追加してください:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

他のプラットフォーム向けのビルドは[ソースからビルドする](#ソースからビルドする)を参照してください。リリースとテストの対象は Apple Silicon の macOS だけです。

## 使い方

### 起動

```bash
vellis                         # フォルダ選択 / 最近開いたフォルダの履歴
vellis .                       # カレントディレクトリをルートとして開く
vellis path/to/file.md         # ファイルを開く(親フォルダがルートになる)
vellis -r path/to/dir          # 起動中のウィンドウのルートを切り替える
vellis -n file.md              # 必ず新しいウィンドウで開く
vellis ssh://user@host/path    # SSH 経由でリモートのルートを開く
vellis --marks                 # マークのサイドバーを開いた状態で起動
vellis --changed               # ずれたマークだけに絞ったサイドバーで起動
vellis --fix claude            # ~/.config/vellis/agents.toml のエージェントを実行
```

フラグの一覧は `vellis --help` で表示できます。

### キーボードショートカット

| ショートカット | 動作 |
|---|---|
| `⌘N` | 新しいウィンドウ |
| `⌘O` | ファイルを開く(ルートはその親フォルダに切り替わる) |
| `⇧⌘O` | フォルダを新しいルートとして開く |
| `⌘E` | 現在のファイルを編集する(または編集モードを抜ける) |
| `⌘S` | 保存 |
| `Esc` | 編集モードを抜ける(未保存の変更があれば先に確認) |
| `⌘P` | 印刷 |
| `⌘C` | 選択範囲を Markdown ソースとしてコピー |
| `⌘=` / `⌘-` / `⌘0` | 文字の拡大 / 縮小 / 実サイズに戻す |
| `⌘⏎` | マークのダイアログで指示を保存(`Esc` でキャンセル) |

動画・音声プレーヤーでは `Space` で再生・一時停止、`←` / `→` で 5 秒(`Shift` 併用で 1 秒)移動、波形の上で Option+ホイールで時間軸をズームします。

### Claude Code から Vellis を使う

`/vellis` スラッシュコマンドで、起動中の Vellis ウィンドウをカレントディレクトリに向けられます。`~/.claude/commands/vellis.md` を作ります:

```markdown
---
description: Point Vellis at the current directory
allowed-tools: Bash(vellis:*)
---

Switch the running Vellis window's explorer root to the current directory.

!`vellis -r .`
```

`/vellis` と打つと `vellis -r .` が実行され、起動中のウィンドウの向き先が切り替わります(起動していなければ Vellis が起動します)。

アプリ内の UI・CLI・メニューバーの表示はすべて英語です。

## ソースからビルドする

### 前提

| ツール | バージョン | 用途 |
|---|---|---|
| Rust | stable | Tauri バックエンドのコンパイル |
| Node.js | v18 以上 | SvelteKit フロントエンド |
| pnpm | v9 以上 | パッケージ管理 |
| プラットフォーム SDK | — | Tauri の WebView / ウィンドウ層 |

Rust は [rustup](https://rustup.rs/) で、Node.js は好みの方法([fnm](https://github.com/Schniz/fnm)・[nvm](https://github.com/nvm-sh/nvm)・パッケージマネージャ)で、pnpm は `corepack enable && corepack prepare pnpm@latest --activate` でインストールします。

プラットフォーム SDK は、macOS なら Xcode Command Line Tools(`xcode-select --install`)、Linux なら WebKitGTK 一式、Windows なら WebView2 と Microsoft C++ Build Tools が必要です。詳細は [Tauri 2 の前提条件ガイド](https://v2.tauri.app/start/prerequisites/)を参照してください。

### セットアップ

```bash
git clone https://github.com/firstfournotes/vellis.git
cd vellis
pnpm install
```

Rust のクレートは初回ビルド時に取得され、数分かかります。

### 開発

```bash
pnpm tauri dev     # Tauri の開発モード(フロントエンドはホットリロード)
pnpm dev           # フロントエンドのみ
```

`pnpm tauri dev` では、起動したディレクトリが初期ルートになります。

### ビルド

```bash
pnpm tauri build --no-bundle   # バイナリのみ → src-tauri/target/release/vellis
pnpm tauri build               # フルバンドル(.app / .dmg)
```

ソースからビルドしたバイナリでも同じ `--install-cli` が使えます:

```bash
./src-tauri/target/release/vellis --install-cli
```

### テストとチェック

```bash
pnpm test                                        # フロントエンドのユニットテスト(vitest)
pnpm check                                       # svelte-check / TypeScript
cargo test --manifest-path src-tauri/Cargo.toml  # Rust のテスト
pnpm test:e2e                                    # E2E(tauri-webdriver・時間がかかる)
```

### リリース

リリースは開発リポジトリで行います。`v*` タグを push すると CI が `.dmg` をビルドし、Developer ID 証明書で署名・公証して [Releases ページ](https://github.com/firstfournotes/vellis/releases)に公開します。タグ付けの前には手動のリリース前チェックリストを通します。CSP・Tauri の capability・feature flag など、テストスイートには決して現れずリリースビルドでだけ起きる回帰があるためです。

## アーキテクチャ

- **フロントエンド** — SvelteKit(Svelte 5 runes)+ TypeScript
- **デスクトップシェル** — Tauri 2(Rust)
- **Markdown** — unified パイプライン(remark-parse → remark-gfm → アラート → ソースマップ → remark-rehype → rehype-raw → mermaid → Shiki → URI 書き換え → rehype-sanitize → rehype-stringify)。ソースマップとアセット URI の書き換えは独自プラグイン
- **アセット** — 画像・3D モデル・動画・音声・PDF は独自の `vellis-asset://` プロトコルを通して WebView に届きます。HTTP の range リクエストに `206` のスライスで応えるため、大きなファイルもメモリに丸ごと読み込まずにストリーミングされます
- **波形** — `.mp4` / `.mov` は Rust で音声トラックを取り出し、`.wav` は数 MB 以上を保持しないストリーミング RIFF リーダーで 8 kHz のピークに間引き、それ以外は WebView でデコードします。3 つの経路は同じピーク・エンベロープ構造に収束するので、ズーム・レーン分割・シークの座標計算は1組の純関数です
- **3D** — three.js と STL / 3MF ローダー。マウスイベントも SpaceMouse の軸も同じ純関数のカメラ状態機械に写像するため、ビューア自体には入力元ごとの分岐がありません
- **永続化** — アトミックな rename で書く JSON Lines(`marks.jsonl`)。ストアごとの mutex で並行する IPC を直列化します

## コントリビューション

Vellis は private リポジトリで開発しています。公開リポジトリ [github.com/firstfournotes/vellis](https://github.com/firstfournotes/vellis) はリリースごとにソースのスナップショットを受け取るため、その履歴は開発履歴ではなく、リリースされた版ごとに1コミットです。設計ドキュメント(アーキテクチャノート・実装ガイド・feature flag の仕組み)は開発リポジトリ側にあり、スナップショットには含まれません。

不具合報告と機能要望は大歓迎です。issue を立ててください。**Pull request は現在受け付けていません**。公開リポジトリは同期先なので、そこにマージした変更は次のリリースで上書きされてしまいます。修正や機能の案があれば issue に書いてください(issue 本文にパッチや diff を貼っていただいて構いません)。上流で取り込みます。

## ライセンス

Vellis は MIT License で公開しています。全文は [LICENSE](./LICENSE) を参照してください。

Copyright (c) 2026 First Four Notes
