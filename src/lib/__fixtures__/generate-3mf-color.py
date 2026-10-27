#!/usr/bin/env python3
"""色つき 3MF のフィクスチャ生成(要件#23 追補e・Issue #558)。

`cube-color.3mf` を同ディレクトリに書き出す。標準ライブラリ(zipfile)だけで組み、
依存は足さない。実行: `python3 src/lib/__fixtures__/generate-3mf-color.py`

内容: 立方体 **[0,40]^3**(STL 10・3MF 20・OBJ 5・PLY 30 と違う寸法=取り違えの検出用)・
12 三角形・`basematerials`(id=2)に `displaycolor="#FF0000"` の `base` 1 つ・
`object` が `pid="2" pindex="0"` でその材質を全三角形に当てる(3MF Core 1.x の
object レベルの property 参照)。three.js の `ThreeMFLoader` はこの形を
`buildBasematerialsMeshes` で読み、`material.color.setStyle('#FF0000', SRGBColorSpace)`
の `MeshPhongMaterial`(name=Red)を 1 つの非インデックス Mesh(36 頂点)に付ける。

ZIP は `cube.3mf` と同じ 3 エントリ(`[Content_Types].xml` / `_rels/.rels` / `3D/3dmodel.model`)・
Deflate。日時を固定して再生成が byte 等価になるようにしてある。手で編集しないこと。
"""
from __future__ import annotations

import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "cube-color.3mf"

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>
"""

RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>
"""

SIZE = 40
VERTICES = [
    (0, 0, 0),
    (0, 0, SIZE),
    (0, SIZE, 0),
    (0, SIZE, SIZE),
    (SIZE, 0, 0),
    (SIZE, 0, SIZE),
    (SIZE, SIZE, 0),
    (SIZE, SIZE, SIZE),
]
# cube.3mf と同じ 12 三角形(頂点番号の並びも同じ)。
TRIANGLES = [
    (0, 1, 3),
    (0, 3, 2),
    (4, 6, 7),
    (4, 7, 5),
    (0, 4, 5),
    (0, 5, 1),
    (2, 3, 7),
    (2, 7, 6),
    (0, 2, 6),
    (0, 6, 4),
    (1, 5, 7),
    (1, 7, 3),
]

DISPLAY_COLOR = "#FF0000"


def model_xml() -> str:
    vertices = "\n".join(
        f'          <vertex x="{x}" y="{y}" z="{z}" />' for x, y, z in VERTICES
    )
    triangles = "\n".join(
        f'          <triangle v1="{a}" v2="{b}" v3="{c}" />' for a, b, c in TRIANGLES
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <basematerials id="2">
      <base name="Red" displaycolor="{DISPLAY_COLOR}" />
    </basematerials>
    <object id="1" type="model" pid="2" pindex="0">
      <mesh>
        <vertices>
{vertices}
        </vertices>
        <triangles>
{triangles}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" />
  </build>
</model>
"""


def main() -> None:
    entries = [
        ("[Content_Types].xml", CONTENT_TYPES),
        ("_rels/.rels", RELS),
        ("3D/3dmodel.model", model_xml()),
    ]
    with zipfile.ZipFile(OUT, "w") as zf:
        for name, text in entries:
            info = zipfile.ZipInfo(name, date_time=(2026, 10, 25, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, text.encode("utf-8"))
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
