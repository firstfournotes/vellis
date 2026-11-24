# 要件74 第2段(Markdown)の受け入れテストのデータ

`src/editor/markdown-*.acceptance.test.ts`・`to-markdown.acceptance.test.ts` が読む。中身の byte を変えないこと。
LF・CRLF・CR だけ・混在・BOM・BOM+front matter・末尾の改行なしの変種はテストの中で作る(ファイルは LF)。

| ファイル | 中身 |
| --- | --- |
| `notation.md` | 周回0 の記法の網羅(setext・`*` / `+` のリスト・`1)`・`~~~`・インデント式コード・段落の中の改行と字下げ・生 HTML のブロックとインライン・参照リンク・画像・脚注・区切り線・引用の入れ子・表(`\|`)・参照定義・NBSP・ゼロ幅・サロゲート対・行末の空白) |
| `ai-report.md` | AI が書いた週次レポートの型(front matter・アラート・表・脚注・code fence・mermaid・autolink・タスク・hard break 2 種・エスケープ・文字参照) |
| `ime.md` | 日本語入力の人間ゲートの場所(見出し・太字の境目・リスト・タスク・引用・アラート・表・空の段落・リンク・脚注) |
| `raw-only.md` | 2-3(raw)の「raw で直すもの」(契約7・23・AC-74-6): front matter・生 HTML のブロック(コメント・属性つき)とインライン・参照定義(タイトルつき)・mermaid・**閉じていない fence**(末尾)。`raw-sync.acceptance.test.ts`・`RawSource.wiring.test.ts` が読む |
| `nodeviews.md` | 2-4(NodeView)の見せ方(契約7・17・AC-74-34〜36): front matter・インラインの生 HTML(`<kbd>`・`onclick` つきの `<span>`・`<br>`)・`<script>` / `javascript:` / `onerror` を含む生 HTML のブロック(`id="target"`)・相対と外部の画像・参照定義と参照リンク・脚注 2 つ(label m・a)と原文の位置の定義・`#target` のリンク・mermaid と ts の fence。`MarkdownNodeViews.wiring.test.ts` が読む |
| `breakers.md` | 周回0 で見つけた「原文が壊れる型 11」(req-74.md「周回0 で見つけて試作を直したもの」): `*` の直後の `+` のリスト・`code` を含む取り消し線 / 太字 / リンク・リスト項目の中の参照定義・行ごとのセルの数がそろわない表・そろえた表・一部に太字を付ける取り消し線・タスクの印・脚注。BOM と BOM+front matter はテストの変種 |
