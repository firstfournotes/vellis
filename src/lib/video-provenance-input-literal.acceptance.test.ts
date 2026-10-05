/**
 * 要件#40 追補7(backlog 241)の受け入れテスト AC-40-21
 * 「素材の名前の空白・制御文字・バックスラッシュ・先頭の `//` をファイル名として扱う」
 *
 * 契約の正本: docs/requirements/req-40.md「### 追補7(2026-10-01 夜・backlog 241=…)」
 *
 * ## 背景
 * `inputs[].path` は vedit が書く**ファイルのパス**(map 置き場基準の相対)であって URL
 * ではない。`inputUriFor` は追補2(`#` `?` `%`)・追補4(先頭がスキームの形)の手当ての
 * 後に `new URL(path, mapUri)` で解決するが、URL パーサは
 *   (1) 入力の先頭と末尾の空白・制御文字を削る(` take.mov` → `take.mov`)
 *   (2) タブ・改行・CR を黙って取り除く(`tab⇥here.mov` → `tabhere.mov`)
 *   (3) file: では `\` を `/` として読む(`a\b.mov` → `a/b.mov`)
 *   (4) 先頭の `//` をホスト名として読む(`//media/x.mov` → `file://media/x.mov`)
 * ため、macOS のファイル名として普通の文字(`/` 以外は何でも使える)で導線が別のパスを
 * 指していた。
 *
 * ## 本ファイルの判定範囲(AC-40-21=純関数のテスト)
 * - `inputs[].path` の各要素は、空白・制御文字(U+0000〜U+001F・U+007F)・バックスラッシュを
 *   含めて文字どおりのファイル名として解決する: ` take.mov`(先頭の空白)・`take.mov `
 *   (末尾の空白)・`a\b.mov`(1文字のバックスラッシュ)・`tab⇥here.mov`(実際のタブ)・
 *   `nl↵x.mov`(実際の改行)・`a␍b.mov`(実際の CR)・` take:2.mov`(先頭の空白+スキームの形)
 *   について、`planRevealInput(...).path` と `planCopyInputPath(...).text` が map の
 *   フォルダ(`/a/b/`)の下のそのままの名前の絶対パスになる
 * - 先頭が `/` を2つ以上重ねたパスは POSIX どおり絶対パス: `//media/x.mov`・
 *   `///media/x.mov` → `/media/x.mov`
 * - `inputUriFor` の結果は `file:///a/b/`(相対)または `file:///media/`(先頭 `//`)で
 *   始まり `..` を含まない(asset プロトコルの 400 拒否を踏まない)。空白・制御文字・
 *   バックスラッシュを URI 上でどうエンコードするかは基準が固定しない(導線に渡る OS
 *   パスだけを固定する)
 * - 回帰防止: これらの文字を含まない名前(`raw.mov`・`./raw.mov`・`../media/raw.mov`・
 *   `..` 3段・日本語・名前の途中の空白・`#` `?` `%`・`take:2.mov`・`v1.2:final.mov`・
 *   `/abs/x.mov`)では `inputUriFor` の結果が追補4 までの実装と**同じ文字列**
 *   (期待の文字列はテスト内に固定。2026-10-01 夜に追補4 までの実装で実測した値)
 *
 * ## 既存 acceptance との関係
 * - 既存 `video-provenance.acceptance.test.ts`(AC-40-15)・
 *   `video-provenance-input-path.acceptance.test.ts`(AC-40-16)・
 *   `video-provenance-input-scheme.acceptance.test.ts`(AC-40-18)は書き換えない。
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

const MAP_URI = "file:///a/b/final.mp4.map.json";

/** テスト名に制御文字をそのまま出さないための表記(⇥ ↵ ␍ ␡ など)。 */
function show(path: string): string {
  return path
    .replace(/\t/g, "⇥")
    .replace(/\n/g, "↵")
    .replace(/\r/g, "␍")
    .replace(/\u0001/g, "␁")
    .replace(/\u007f/g, "␡");
}

/**
 * 追補7 の受け入れ基準に列挙された名前と、その実際の絶対パス。
 * 相対のみの名前は map の隣(`/a/b/`)。文字列リテラルのエスケープに注意:
 * `"a\\b.mov"` は1文字のバックスラッシュ・`"\t"` `"\n"` `"\r"` は実際のタブ・改行・CR。
 */
const LITERAL_NAMES: {
  path: string;
  absolute: string;
  uriPrefix: string;
  note: string;
}[] = [
  {
    path: " take.mov",
    absolute: "/a/b/ take.mov",
    uriPrefix: "file:///a/b/",
    note: "先頭の空白(URL パーサは削るが、ファイル名の一部)",
  },
  {
    path: "take.mov ",
    absolute: "/a/b/take.mov ",
    uriPrefix: "file:///a/b/",
    note: "末尾の空白(同上)",
  },
  {
    path: "a\\b.mov",
    absolute: "/a/b/a\\b.mov",
    uriPrefix: "file:///a/b/",
    note: "1文字のバックスラッシュ(file: では / と読まれるが、ファイル名の一部)",
  },
  {
    path: "tab\there.mov",
    absolute: "/a/b/tab\there.mov",
    uriPrefix: "file:///a/b/",
    note: "実際のタブ(URL パーサは黙って取り除くが、ファイル名の一部)",
  },
  {
    path: "nl\nx.mov",
    absolute: "/a/b/nl\nx.mov",
    uriPrefix: "file:///a/b/",
    note: "実際の改行(同上)",
  },
  {
    path: "a\rb.mov",
    absolute: "/a/b/a\rb.mov",
    uriPrefix: "file:///a/b/",
    note: "実際の CR(同上)",
  },
  {
    path: " take:2.mov",
    absolute: "/a/b/ take:2.mov",
    uriPrefix: "file:///a/b/",
    note: "先頭の空白+スキームの形(追補4 の判定はエンコード後に行う=スキームにならない)",
  },
  {
    path: "//media/x.mov",
    absolute: "/media/x.mov",
    uriPrefix: "file:///media/",
    note: "先頭の // は POSIX どおり絶対パス(ホスト名ではない)",
  },
  {
    path: "///media/x.mov",
    absolute: "/media/x.mov",
    uriPrefix: "file:///media/",
    note: "先頭の /// も絶対パス(/ の連なりは1つに縮める)",
  },
];

/**
 * 契約(追補7)の範囲=制御文字 U+0000〜U+001F・U+007F のうち、AC の列挙(タブ・改行・CR)
 * 以外の代表。U+0000 は macOS のファイル名に入り得ないので除く。
 */
const CONTROL_NAMES: { path: string; absolute: string; note: string }[] = [
  {
    path: "\u0001x.mov",
    absolute: "/a/b/\u0001x.mov",
    note: "先頭の U+0001(URL パーサは先頭の C0 制御文字を削る)",
  },
  {
    path: "a\u007fb.mov",
    absolute: "/a/b/a\u007fb.mov",
    note: "途中の U+007F(DEL)",
  },
];

describe("AC-40-21 素材の名前の空白・制御文字・バックスラッシュ・先頭の // をファイル名として扱う(要件#40 追補7・backlog 241)", () => {
  describe("planRevealInput: 空白・制御文字・バックスラッシュ・先頭の // を含む名前でも Finder に渡すパスは実際の絶対パス", () => {
    for (const { path, absolute, note } of LITERAL_NAMES) {
      it(`${show(path)} → ${show(absolute)}(${note})`, () => {
        const plan = planRevealInput(MAP_URI, path);
        expect(plan.command).toBe("reveal_item_in_dir");
        expect(plan.path).toBe(absolute);
      });
    }
  });

  describe("planCopyInputPath: 空白・制御文字・バックスラッシュ・先頭の // を含む名前でもクリップボードに載せるのは実際の絶対パス", () => {
    for (const { path, absolute, note } of LITERAL_NAMES) {
      it(`${show(path)} → ${show(absolute)}(${note})`, () => {
        const plan = planCopyInputPath(MAP_URI, path);
        expect(plan.command).toBe("copy");
        expect(plan.text).toBe(absolute);
      });
    }
  });

  describe("inputUriFor: map の URI を基準にした file:// の絶対 URI になり .. が残らない", () => {
    for (const { path, uriPrefix, note } of LITERAL_NAMES) {
      it(`${show(path)}: ${uriPrefix} で始まり .. を含まない(${note})`, () => {
        const uri = inputUriFor(MAP_URI, path);
        expect(uri.startsWith(uriPrefix)).toBe(true);
        expect(uri).not.toContain("..");
      });
    }

    it(" take:2.mov は take: スキームの URI(従来の壊れた結果)にならない", () => {
      const uri = inputUriFor(MAP_URI, " take:2.mov");
      expect(uri.startsWith("take:")).toBe(false);
      expect(uri.startsWith("file:///a/b/")).toBe(true);
    });

    it("//media/x.mov はホスト名 media の URI(従来の壊れた結果)にならない", () => {
      const uri = inputUriFor(MAP_URI, "//media/x.mov");
      expect(uri.startsWith("file://media/")).toBe(false);
      expect(uri.startsWith("file:///media/")).toBe(true);
    });

    it("a\\b.mov の \\ は / 区切りにならない(末尾の要素は a\\b.mov のまま)", () => {
      const uri = inputUriFor(MAP_URI, "a\\b.mov");
      expect(uri.startsWith("file:///a/b/")).toBe(true);
      // `/a/b/a/b.mov`(\ を / と読んだ形)になっていない
      expect(uri).not.toBe("file:///a/b/a/b.mov");
      expect(planRevealInput(MAP_URI, "a\\b.mov").path).not.toBe("/a/b/a/b.mov");
    });
  });

  describe("契約の範囲: AC の列挙外の制御文字(U+0001・U+007F)もファイル名の一部", () => {
    for (const { path, absolute, note } of CONTROL_NAMES) {
      it(`${show(path)} → ${show(absolute)}(${note})`, () => {
        expect(planRevealInput(MAP_URI, path).path).toBe(absolute);
        expect(planCopyInputPath(MAP_URI, path).text).toBe(absolute);
        const uri = inputUriFor(MAP_URI, path);
        expect(uri.startsWith("file:///a/b/")).toBe(true);
        expect(uri).not.toContain("..");
      });
    }
  });

  describe("回帰防止: これらの文字を含まない名前では inputUriFor は追補4 までの実装と同じ文字列", () => {
    /** 期待値は 2026-10-01 夜に追補4 までの実装(node の new URL)で実測した文字列。 */
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
        path: "../media/素材.mov",
        expected: "file:///a/media/%E7%B4%A0%E6%9D%90.mov",
        note: "日本語名(URI ではエンコード)",
      },
      {
        path: "../media/my clip.mov",
        expected: "file:///a/media/my%20clip.mov",
        note: "名前の途中の空白(URI では %20=追補7 の手当て後も同じ文字列)",
      },
      {
        path: "clip #1 ?.mov",
        expected: "file:///a/b/clip%20%231%20%3F.mov",
        note: "空白と # ? の混在(追補2)",
      },
      {
        path: "take#2.mov",
        expected: "file:///a/b/take%232.mov",
        note: "#(追補2)",
      },
      {
        path: "100%.mov",
        expected: "file:///a/b/100%25.mov",
        note: "%(追補2)",
      },
      {
        path: "take:2.mov",
        expected: "file:///a/b/take:2.mov",
        note: "先頭がスキームの形(追補4)",
      },
      {
        path: "v1.2:final.mov",
        expected: "file:///a/b/v1.2:final.mov",
        note: "先頭がスキームの形・数字と . を含む(追補4)",
      },
      {
        path: "/abs/x.mov",
        expected: "file:///abs/x.mov",
        note: "/ 1つで始まる絶対パス(縮める対象ではない)",
      },
    ];

    for (const { path, expected, note } of PLAIN_PATHS) {
      it(`${path}(${note}): ${expected}`, () => {
        expect(inputUriFor(MAP_URI, path)).toBe(expected);
      });
    }

    it("導線の結果も追補4 までと同じ(OS パスでは復号される)", () => {
      expect(planRevealInput(MAP_URI, "../media/my clip.mov").path).toBe(
        "/a/media/my clip.mov",
      );
      expect(planCopyInputPath(MAP_URI, "../media/my clip.mov").text).toBe(
        "/a/media/my clip.mov",
      );
      expect(planRevealInput(MAP_URI, "clip #1 ?.mov").path).toBe(
        "/a/b/clip #1 ?.mov",
      );
      expect(planCopyInputPath(MAP_URI, "take:2.mov").text).toBe(
        "/a/b/take:2.mov",
      );
      expect(planRevealInput(MAP_URI, "/abs/x.mov").path).toBe("/abs/x.mov");
      expect(planCopyInputPath(MAP_URI, "/abs/x.mov").text).toBe("/abs/x.mov");
    });
  });
});
