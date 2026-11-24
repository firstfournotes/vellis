# 編集の受け入れテストのデータ(要件74)

`docs/requirements/req-74.md` の受け入れ基準(第1段=コードのファイルと plain text)が読むフィクスチャ。テストは
`src/editor/*.acceptance.test.ts`・`src/components/CodeEditor.wiring.test.ts`。**中身の byte を変えない**こと
(改行コード・BOM・末尾の改行の有無・不可視文字が判定の対象)。`.gitattributes` の `* -text` で git の改行変換を止めている。

| ファイル | 中身 | 見るもの |
| --- | --- | --- |
| `lf.txt` | LF・タブと空白の字下げ・空行 | 往復(AC-74-1)・字下げの検出 |
| `crlf.txt` | `lf.txt` と同じ本文を CRLF で | CRLF の保持(AC-74-32) |
| `cr.txt` | 同じ本文を CR だけで | CR の保持 |
| `mixed.txt` | CRLF 4・LF 1・CR 1 の混在(dominant=CRLF) | 混在の保持・`detectLineEnding` |
| `bom-crlf.txt` | BOM(U+FEFF)+CRLF | BOM の保持 |
| `no-final-newline.txt` | 末尾に改行なし | 末尾の改行の有無の保持 |
| `empty.txt` | 空 | 空の文書 |
| `indent-tabs.go` | タブの字下げ | `detectIndentUnit` = `\t`・行番号あり |
| `indent-spaces.py` | 空白 4 の字下げ | `detectIndentUnit` = 4 spaces |
| `indent-two-spaces.ts` | 空白 2 の字下げ | `detectIndentUnit` = 2 spaces |
| `special-chars.txt` | NBSP・ゼロ幅・サロゲート対・タブ・行末の空白・日本語 | 不可視文字の保持 |
| `long-line.log` | 1 行 10 万字 | 長い行の往復 |
| `settings.json` | 要件65 の設定ファイルの形 | 設定ファイルの面(言語 json が分かるので行番号あり=由谷 2026-11-16) |
| `sample.rs` | コメント・キーワード・文字列・数値 | コードのファイル(行番号あり) |
| `query.graphql` | `CODE_LANGUAGES` にあるが CodeMirror の文法が無い言語 | 文法なし=色なしで打てる |

生成は `node` のワンライナー(`fixtures/editing/` を作ったコミットの本文)。手で直すときは `od -c` で byte を確かめる。
