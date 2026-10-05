/**
 * 要件#40 追補2(backlog 230)の受け入れテスト AC-40-16
 * 「素材のパスはファイル名として扱う(`#` `?` `%` を含む名前)」
 *
 * 契約の正本: docs/requirements/req-40.md「### 追補2(2026-10-01・backlog 230=…)」
 *
 * ## 背景
 * `inputs[].path` は vedit が書く**ファイルのパス**(map 置き場基準の相対)であって URL
 * ではない。従来の `inputUriFor` は `resolveRelative`(= `new URL(path, mapUri)`)へ生で
 * 渡していたため、`#` 以降がフラグメント・`?` 以降がクエリ・`%XX` がエスケープとして
 * 読まれ、「Finder で表示」「パスをコピー」が別のパスを指していた。
 *
 * ## 本ファイルの判定範囲(AC-40-16=純関数のテスト)
 * - `inputs[].path` の各要素(`/` 区切りの名前)を文字どおりのファイル名として絶対化する:
 *   `#` `?` `%`(`%41` のような 16 進 2 桁の並びを含む)を含む名前でも、
 *   `planRevealInput(...).path` と `planCopyInputPath(...).text` はそのファイルの実際の
 *   絶対パス(名前の文字がそのまま入ったもの)になる
 * - `inputUriFor` の結果に `..` が残らない(asset プロトコルの 400 拒否を踏まない)
 * - 回帰防止: `#` `?` `%` を含まない `inputs[].path`(`..` 1段/3段・同ディレクトリ・
 *   日本語・空白)では `inputUriFor` の結果が今の `resolveRelative(map の URI, path)` と
 *   **同じ文字列**(AC-40-15 の既存テストは無改変で緑のまま)
 *
 * ## 既存 acceptance との関係
 * - 既存 `video-provenance.acceptance.test.ts`(AC-40-15=契約⑦の導線)は書き換えない。
 *   `MAP_URI` は同じ `file:///a/b/final.mp4.map.json` 形を使う
 * - 「Finder で表示」「パスをコピー」に渡すパスの作り方(`pathForReveal` / `pathForCopy`
 *   の再利用)は不変(契約⑦)。本ファイルは結果の絶対パスだけを固定し、再利用の等式は
 *   AC-40-15 が固定済み
 */

import { describe, expect, it } from "vitest";

import {
  inputUriFor,
  planCopyInputPath,
  planRevealInput,
} from "./video-provenance";
import { resolveRelative } from "./uri";

const MAP_URI = "file:///a/b/final.mp4.map.json";

/**
 * 追補2 の受け入れ基準に列挙された名前と、その実際の絶対パス。
 * `../media/…` は map の親の隣(`/a/media/`)・相対のみの名前は map の隣(`/a/b/`)。
 */
const SPECIAL_NAMES: { path: string; absolute: string; note: string }[] = [
  {
    path: "../media/take#2.mov",
    absolute: "/a/media/take#2.mov",
    note: "# はフラグメントではない",
  },
  {
    path: "../media/what?.mov",
    absolute: "/a/media/what?.mov",
    note: "? はクエリではない",
  },
  {
    path: "../media/100%.mov",
    absolute: "/a/media/100%.mov",
    note: "% 単独(16 進が続かない)",
  },
  {
    path: "../media/a%41b.mov",
    absolute: "/a/media/a%41b.mov",
    note: "%41 はエスケープではない(A に復号しない)",
  },
  {
    path: "clip #1 ?.mov",
    absolute: "/a/b/clip #1 ?.mov",
    note: "空白と記号の混在・同ディレクトリ",
  },
];

describe("AC-40-16 素材のパスはファイル名として扱う(要件#40 追補2・backlog 230)", () => {
  describe("planRevealInput: # ? % を含む名前でも Finder に渡すパスは実際の絶対パス", () => {
    for (const { path, absolute, note } of SPECIAL_NAMES) {
      it(`${path} → ${absolute}(${note})`, () => {
        const plan = planRevealInput(MAP_URI, path);
        expect(plan.command).toBe("reveal_item_in_dir");
        expect(plan.path).toBe(absolute);
      });
    }
  });

  describe("planCopyInputPath: # ? % を含む名前でもクリップボードに載せるのは実際の絶対パス", () => {
    for (const { path, absolute, note } of SPECIAL_NAMES) {
      it(`${path} → ${absolute}(${note})`, () => {
        const plan = planCopyInputPath(MAP_URI, path);
        expect(plan.command).toBe("copy");
        expect(plan.text).toBe(absolute);
      });
    }
  });

  describe("inputUriFor: 絶対 URI に .. が残らない(# ? % を含む名前でも)", () => {
    for (const { path } of SPECIAL_NAMES) {
      it(`${path}: file:// の絶対 URI で .. を含まない`, () => {
        const uri = inputUriFor(MAP_URI, path);
        expect(uri.startsWith("file:///a/")).toBe(true);
        expect(uri).not.toContain("..");
      });
    }

    it(".. を複数段含む名前でも解決の時点で正規化され、# ? % は名前の文字のまま残る", () => {
      // /a/b/ → .. → /a/ → .. → / → a → /a/ → x → /a/x/ → .. → /a/ → media/take#2.mov
      const uri = inputUriFor(MAP_URI, "../../a/x/../media/take#2.mov");
      expect(uri).not.toContain("..");
      expect(
        planRevealInput(MAP_URI, "../../a/x/../media/take#2.mov").path,
      ).toBe("/a/media/take#2.mov");
      expect(
        planCopyInputPath(MAP_URI, "../../a/x/../media/take#2.mov").text,
      ).toBe("/a/media/take#2.mov");
    });
  });

  describe("回帰防止: # ? % を含まない名前では inputUriFor は今の resolveRelative と同じ文字列", () => {
    const PLAIN_PATHS: { path: string; expected: string; note: string }[] = [
      {
        path: "../media/raw.mov",
        expected: "file:///a/media/raw.mov",
        note: ".. 1段",
      },
      {
        path: "../../a/x/../media/raw.mov",
        expected: "file:///a/media/raw.mov",
        note: ".. 3段(正規化で消える)",
      },
      {
        path: "raw.mov",
        expected: "file:///a/b/raw.mov",
        note: "同ディレクトリ",
      },
      {
        path: "./raw.mov",
        expected: "file:///a/b/raw.mov",
        note: ". は解決の時点で消える",
      },
      {
        path: "../media/素材.mov",
        expected: "file:///a/media/%E7%B4%A0%E6%9D%90.mov",
        note: "日本語名(URI ではエンコード)",
      },
      {
        path: "../media/my clip.mov",
        expected: "file:///a/media/my%20clip.mov",
        note: "空白名(URI では %20)",
      },
      {
        path: "sub/dir/take 1.mov",
        expected: "file:///a/b/sub/dir/take%201.mov",
        note: "複数要素の相対(/ 区切りは保たれる)",
      },
    ];

    for (const { path, expected, note } of PLAIN_PATHS) {
      it(`${path}(${note}): resolveRelative と同値`, () => {
        expect(inputUriFor(MAP_URI, path)).toBe(resolveRelative(MAP_URI, path));
        expect(inputUriFor(MAP_URI, path)).toBe(expected);
      });
    }

    it("日本語・空白名の導線の結果も今と同じ(OS パスでは復号される)", () => {
      expect(planRevealInput(MAP_URI, "../media/素材.mov").path).toBe(
        "/a/media/素材.mov",
      );
      expect(planCopyInputPath(MAP_URI, "../media/素材.mov").text).toBe(
        "/a/media/素材.mov",
      );
      expect(planRevealInput(MAP_URI, "../media/my clip.mov").path).toBe(
        "/a/media/my clip.mov",
      );
      expect(planCopyInputPath(MAP_URI, "../media/my clip.mov").text).toBe(
        "/a/media/my clip.mov",
      );
    });
  });
});
