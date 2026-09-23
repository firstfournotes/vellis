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

## PLY(要件#58 — `model-ply.acceptance.test.ts`)

`node generate-ply.mjs`(同ディレクトリ)による一回きりの生成物。すべて同じ
8 点=立方体 **[0,30]^3** の角(STL 10・3MF 20・OBJ 5 と違う寸法にして、
取り違えを数値で検出する)。手で編集しないこと。

| ファイル | 内容 |
|---|---|
| `cloud-ascii.ply` | 色なし ASCII 点群(8点・面なし) |
| `cloud-color-ascii.ply` | 頂点色つき ASCII 点群(`x y z nx ny nz` + uchar `red green blue`。Revopoint 風) |
| `cloud-binary-le.ply` | binary_little_endian 点群(同じ8点・色なし) |
| `cloud-binary-be.ply` | binary_big_endian 点群(同じ8点・色なし) |
| `cube-mesh.ply` | 面ありメッシュ(8頂点・12三角形・法線/色なし) |
| `cube-color-mesh.ply` | 面あり+頂点色つきメッシュ(同じ8頂点・12三角形・uchar `red green blue`。追補a= AC-58-20「頂点色つきメッシュのマテリアル色は白」の入力) |
| `empty.ply` | 頂点0(`element vertex 0`)— 既存の失敗経路へ落ちる入力 |

壊れたヘッダの PLY はフィクスチャにせず、テスト内でバイト列を組む。
