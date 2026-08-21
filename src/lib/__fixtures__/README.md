# テストフィクスチャ(要件#23 — 3D モデル表示)

`model-parse.acceptance.test.ts` が読む最小モデル。すべて同じ立方体(12 三角形)で、
形式ごとにバウンディングボックスを変えてある(取り違えの検出用)。

| ファイル | 形式 | bbox |
|---|---|---|
| `cube-ascii.stl` | ASCII STL | (0,0,0)–(10,10,10) |
| `cube-binary.stl` | バイナリ STL(80B ヘッダ+三角形数+50B/tri) | (0,0,0)–(10,10,10) |
| `cube.3mf` | 3MF(ZIP: `[Content_Types].xml` + `_rels/.rels` + `3D/3dmodel.model`) | (0,0,0)–(20,20,20) |

Python(zipfile / struct)による一回きりの生成物。手で編集しないこと —
数値を変えるとテストの期待値と食い違う。
