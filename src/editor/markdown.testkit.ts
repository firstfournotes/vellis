/**
 * 要件#74 第2段 2-1 の受け入れテストの共通の道具(テスト専用。実装は import するだけ)。
 *
 * - フィクスチャ(`fixtures/editing/markdown/`)と、その 7 変種(LF・CRLF・CR だけ・混在・BOM+LF・BOM+CRLF・
 *   末尾の改行なし)+ BOM+front matter(周回0 で検出漏れを見つけた型)
 * - 文書モデルの上で取引を当てる補助(最上位ブロックの位置・ブロックの中の text の位置)
 * - 前後の共通部分(AC-74-2 の「触ったブロックの外が byte 等価」)
 * - xorshift32(位置の乱数の種を固定)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Node as PMNode } from 'prosemirror-model';

export const REPO_ROOT = resolve(__dirname, '../..');
export const MD_FIXTURES = resolve(REPO_ROOT, 'fixtures/editing/markdown');

export const MD_FILES = ['notation.md', 'ai-report.md', 'ime.md', 'breakers.md'] as const;

export function fixture(name: string): string {
	return readFileSync(resolve(MD_FIXTURES, name), 'utf8');
}

export const BOM = '﻿';
const FRONT_MATTER = '---\ntitle: variant\ntags: [a, b]\n---\n\n';

/** 周回0 と同じ 7 変種+BOM+front matter(前に front matter が無いフィクスチャだけ)。 */
export function variants(name: string, src: string): Array<[string, string]> {
	const lf = src.replace(/\r\n|\r/g, '\n');
	const lines = lf.split('\n');
	const out: Array<[string, string]> = [
		[`${name} LF`, lf],
		[`${name} CRLF`, lf.replace(/\n/g, '\r\n')],
		[`${name} CR`, lf.replace(/\n/g, '\r')],
		[`${name} mixed`, lines.map((l, i) => l + (i === lines.length - 1 ? '' : i % 3 === 0 ? '\r\n' : '\n')).join('')],
		[`${name} BOM+LF`, BOM + lf],
		[`${name} BOM+CRLF`, BOM + lf.replace(/\n/g, '\r\n')],
		[`${name} no-final-eol`, lf.replace(/\n+$/, '')],
	];
	if (!lf.startsWith('---')) out.push([`${name} BOM+front matter`, BOM + FRONT_MATTER + lf]);
	return out;
}

/** 最上位の `index` 番目のブロックの文書の位置(そのブロックの開きトークンの位置)。 */
export function blockPos(doc: PMNode, index: number): number {
	let p = 0;
	for (let i = 0; i < index; i++) p += doc.child(i).nodeSize;
	return p;
}

export interface TextSpot {
	/** 最上位ブロックの番号 */
	block: number;
	/** text ノードの文書の位置(先頭) */
	pos: number;
	text: string;
	marks: string[];
	inCode: boolean;
}

/** 最上位ブロック `index` の中の text ノード(位置つき)。 */
export function textSpots(doc: PMNode, index: number): TextSpot[] {
	const out: TextSpot[] = [];
	const block = doc.child(index);
	const base = blockPos(doc, index);
	let inCodeBlock = false;
	block.descendants((n, pos, parent) => {
		if (n.type.name === 'code_block') inCodeBlock = true;
		if (n.isText && n.text) {
			out.push({
				block: index,
				pos: base + 1 + pos,
				text: n.text,
				marks: n.marks.map((m) => m.type.name),
				inCode: inCodeBlock || parent?.type.name === 'code_block' || n.marks.some((m) => m.type.name === 'code'),
			});
		}
		return true;
	});
	return out;
}

/** サロゲート対の間に落ちない、`text` の中の挿入の位置(0 < col < length)。 */
export function safeCol(text: string, col: number): number {
	const c = text.charCodeAt(col);
	if (c >= 0xdc00 && c <= 0xdfff) return col + 1 <= text.length ? col + 1 : col - 1;
	return col;
}

export function commonPrefix(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	return i;
}

export function commonSuffix(a: string, b: string, prefix: number): number {
	let i = 0;
	while (i < a.length - prefix && i < b.length - prefix && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
	return i;
}

/**
 * 変わった範囲が `[start, end)`(原文の切片の範囲)の内側に収まっているか(AC-74-2)。
 * `prefix` は原文と書き出しの共通の接頭辞の長さ、`suffix` は接尾辞の長さ。
 */
export function changedWithin(src: string, out: string, start: number, end: number): { ok: boolean; prefix: number; suffix: number } {
	const prefix = commonPrefix(src, out);
	const suffix = commonSuffix(src, out, prefix);
	return { ok: prefix >= start && src.length - suffix <= end, prefix, suffix };
}

/** xorshift32(種を固定)。 */
export function rng(seed: number): () => number {
	let x = seed >>> 0 || 1;
	return () => {
		x ^= x << 13;
		x >>>= 0;
		x ^= x >>> 17;
		x ^= x << 5;
		x >>>= 0;
		return x / 0x1_0000_0000;
	};
}

/** 最上位ブロックの名前の列(形の目印)。 */
export function blockNames(doc: PMNode): string[] {
	const out: string[] = [];
	doc.forEach((c) => out.push(c.type.name));
	return out;
}
