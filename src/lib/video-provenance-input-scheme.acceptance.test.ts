/**
 * 要件#40 追補4(backlog 240)の受け入れテスト AC-40-18
 * 「先頭が「英字+:」の素材の名前をスキームとして読まない」
 *
 * 契約の正本: docs/requirements/req-40.md「### 追補4(2026-10-01・backlog 240=…)」
 *
 * ## 背景
 * `inputs[].path` は vedit が書く**ファイルのパス**(map 置き場基準の相対)であって URL
 * ではない。従来の `inputUriFor` は `resolveRelative`(= `new URL(path, mapUri)`)に
 * 渡すため、先頭の要素が `[A-Za-z][A-Za-z0-9+.-]*:` の形(`take:2.mov` など)だと
 * それを URL のスキームと読み、map の URI を基準にしない。macOS では Finder で名前に
 * `/` を入れると POSIX では `:` になるので、map の隣の素材を同じフォルダの相対名で
 * 書くと踏む(「Finder で表示」に渡るパスもコピーされる文字列も「2.mov」になっていた)。
 *
 * ## 本ファイルの判定範囲(AC-40-18=純関数のテスト)
 * - `inputs[].path` が `/` で始まらない(相対)とき、先頭の要素はスキームとしてではなく
 *   ファイル名として解決する: `take:2.mov`・`v1.2:final.mov`・`sub:dir/x.mov`・
 *   `take:#2.mov`(追補2 の `#` の扱いとの組み合わせ)・`../media/take:2.mov` について、
 *   `planRevealInput(...).path` と `planCopyInputPath(...).text` が map のフォルダの下の
 *   そのままの名前の絶対パスになる
 * - `inputUriFor` の結果は `file:///a/` で始まり `..` を含まない(asset プロトコルの
 *   400 拒否を踏まない)。`:` を URI 上でエンコードするかどうかは基準が固定しない
 *   (導線に渡る OS パスだけを固定する)
 * - `/abs/x.mov`(`/` で始まる絶対パス)は `/abs/x.mov` のまま
 * - 回帰防止: 先頭がスキームの形でない名前(`raw.mov`・`./raw.mov`・`../media/raw.mov`・
 *   数字で始まる `2026:10:01.mov`・日本語・空白・`..` 3段)では `inputUriFor` の結果が
 *   従来の `resolveRelative(map の URI, path)` と**同じ文字列**(追補2 の等式は
 *   先頭がスキームの形の名前を除いて成り立つ)
 *
 * ## 既存 acceptance との関係
 * - 既存 `video-provenance.acceptance.test.ts`(AC-40-15)・
 *   `video-provenance-input-path.acceptance.test.ts`(AC-40-16)は書き換えない。
 *   `MAP_URI` は同じ `file:///a/b/final.mp4.map.json` 形を使う
 * - 「Finder で表示」「パスをコピー」に渡すパスの作り方(`pathForReveal` / `pathForCopy`
 *   の再利用)は不変(契約⑦)。本ファイルは結果の絶対パスだけを固定する
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
 * 追補4 の受け入れ基準に列挙された、先頭(または途中)の要素がスキームの形の名前と、
 * その実際の絶対パス。相対のみの名前は map の隣(`/a/b/`)・`../media/…` は map の
 * 親の隣(`/a/media/`)。
 */
const SCHEME_SHAPED_NAMES: { path: string; absolute: string; note: string }[] =
  [
    {
      path: "take:2.mov",
      absolute: "/a/b/take:2.mov",
      note: "英字+: で始まる(macOS で Finder の / が POSIX の : になる典型)",
    },
    {
      path: "v1.2:final.mov",
      absolute: "/a/b/v1.2:final.mov",
      note: "英字+数字+. を含む(スキーム文字集合 [A-Za-z0-9+.-] の形)",
    },
    {
      path: "sub:dir/x.mov",
      absolute: "/a/b/sub:dir/x.mov",
      note: "先頭の要素が : を含み、後ろに / 区切りの要素が続く",
    },
    {
      path: "take:#2.mov",
      absolute: "/a/b/take:#2.mov",
      note: "追補2 の # の扱いと組み合わせても成り立つ",
    },
    {
      path: "../media/take:2.mov",
      absolute: "/a/media/take:2.mov",
      note: "先頭の要素が .. なら : を含む要素が後ろにあっても従来どおり(回帰防止)",
    },
  ];

describe("AC-40-18 先頭が「英字+:」の素材の名前をスキームとして読まない(要件#40 追補4・backlog 240)", () => {
  describe("planRevealInput: スキームの形の名前でも Finder に渡すパスは map のフォルダの下の実際の絶対パス", () => {
    for (const { path, absolute, note } of SCHEME_SHAPED_NAMES) {
      it(`${path} → ${absolute}(${note})`, () => {
        const plan = planRevealInput(MAP_URI, path);
        expect(plan.command).toBe("reveal_item_in_dir");
        expect(plan.path).toBe(absolute);
      });
    }
  });

  describe("planCopyInputPath: スキームの形の名前でもクリップボードに載せるのは map のフォルダの下の実際の絶対パス", () => {
    for (const { path, absolute, note } of SCHEME_SHAPED_NAMES) {
      it(`${path} → ${absolute}(${note})`, () => {
        const plan = planCopyInputPath(MAP_URI, path);
        expect(plan.command).toBe("copy");
        expect(plan.text).toBe(absolute);
      });
    }
  });

  describe("inputUriFor: map の URI を基準にした file:// の絶対 URI になり .. が残らない", () => {
    for (const { path, note } of SCHEME_SHAPED_NAMES) {
      it(`${path}: file:///a/ で始まり .. を含まない(${note})`, () => {
        const uri = inputUriFor(MAP_URI, path);
        expect(uri.startsWith("file:///a/")).toBe(true);
        expect(uri).not.toContain("..");
      });
    }

    it("take:2.mov は take: スキームの URI(従来の壊れた結果)にならない", () => {
      const uri = inputUriFor(MAP_URI, "take:2.mov");
      expect(uri.startsWith("take:")).toBe(false);
      expect(uri.startsWith("file:///a/b/")).toBe(true);
    });

    it("sub:dir/x.mov は / 区切りが保たれ、末尾の要素 x.mov が sub:dir の下に来る", () => {
      const uri = inputUriFor(MAP_URI, "sub:dir/x.mov");
      expect(uri.startsWith("file:///a/b/")).toBe(true);
      expect(uri.endsWith("/x.mov")).toBe(true);
    });
  });

  describe("絶対パス(/ で始まる)は従来どおりそのまま", () => {
    it("/abs/x.mov → /abs/x.mov(Finder で表示・パスをコピーとも)", () => {
      expect(planRevealInput(MAP_URI, "/abs/x.mov").path).toBe("/abs/x.mov");
      expect(planCopyInputPath(MAP_URI, "/abs/x.mov").text).toBe("/abs/x.mov");
    });

    it("/abs/x.mov: inputUriFor は従来の resolveRelative と同じ文字列(file:///abs/x.mov)", () => {
      expect(inputUriFor(MAP_URI, "/abs/x.mov")).toBe(
        resolveRelative(MAP_URI, "/abs/x.mov"),
      );
      expect(inputUriFor(MAP_URI, "/abs/x.mov")).toBe("file:///abs/x.mov");
    });
  });

  describe("回帰防止: 先頭がスキームの形でない名前(# ? % を含まない)では inputUriFor は従来の resolveRelative と同じ文字列", () => {
    const PLAIN_PATHS: { path: string; expected: string; note: string }[] = [
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
        path: "2026:10:01.mov",
        expected: "file:///a/b/2026:10:01.mov",
        note: "数字で始まる名前の : はもともとスキームと読まれない(従来どおり)",
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

    it("数字で始まる 2026:10:01.mov の導線の結果も今と同じ", () => {
      expect(planRevealInput(MAP_URI, "2026:10:01.mov").path).toBe(
        "/a/b/2026:10:01.mov",
      );
      expect(planCopyInputPath(MAP_URI, "2026:10:01.mov").text).toBe(
        "/a/b/2026:10:01.mov",
      );
    });

    it("日本語・空白名の導線の結果も今と同じ(OS パスでは復号される)", () => {
      expect(planRevealInput(MAP_URI, "../media/素材.mov").path).toBe(
        "/a/media/素材.mov",
      );
      expect(planCopyInputPath(MAP_URI, "../media/my clip.mov").text).toBe(
        "/a/media/my clip.mov",
      );
    });
  });
});
