/**
 * Issue #860(要件#90)— 隠した枠を丸ごと消す範囲削除の後、印刷で畳んだ形が一時的に出ない(`mapAlerts` に長さ 0 の項目が残る)。
 * unit プロジェクト(ProseMirror の state だけで判定。view は作らない)。
 *
 * `src/editor/alert-visibility-plugin.ts` の `apply`: 枠に触れないと判定された取引(`touchesAlerts` が偽)で枠が丸ごと消える場合
 * (段落 4 の途中〜段落 8 の途中の範囲削除で、間の隠した枠 5〜7 が消える。変更点の両隣が段落)、`alerts` に pos===end の長さ 0 の項目が残る。
 * 次に枠へ触れる取引か設定の変更で作り直されるまでの間、印刷の `applyAlertStatesToPrint` の突き合わせが数の不一致で全体の設定に落ち、
 * 畳んだ形(collapsed)が紙に出ない。
 *
 * ## 固定する振る舞い(直った後)
 * - 枠を丸ごと消す範囲削除の後、`faceAlerts(state)` は**文書に残っている枠だけ**(長さ 0 の項目を持たない)。残った枠の pos / end は
 *   新しい文書のその node の位置で、状態(畳んだ=collapsed)は保たれる
 * - その一覧で `applyAlertStatesToPrint` を当てると、残った畳んだ枠は印刷の文書でも `data-alert-state="collapsed"`
 * - 枠に触れる削除(枠の中から枠の外へ)でも同じ(こちらは今も作り直すので通るはず=回帰の守り)
 *
 * ## 判断の記録(test-writer 2026-11-28)
 * - 枠を畳む操作は plugin の見出しのクリック(view が要る)でなく、同じ取引の形 `tr.setMeta(alertVisibilityKey, { toggle: pos })` で起こす
 *   (plugin の中の `dispatchAlertMeta` と同じ)。meta の形は plugin の内部だが、面の操作と等価なのでここでは固定して使う
 * - 「touchesAlerts が偽になる削除」は Issue の例(段落の途中から段落の途中)をそのまま使う。もし実装が判定を変えて作り直す道に入っても、
 *   結果(残っている枠だけ)が同じなら通る(直し方は縛らない)
 * - 印刷の DOM は `render` を通さず、`alert-dom.ts` の selector(blockquote.markdown-alert.markdown-alert-<kind>・.markdown-alert-title)に
 *   合わせて手で組む(unit プロジェクトで描画器を起こさないため)
 *
 * ## 修正前に赤になる理由
 * - 削除の後の `faceAlerts(state)` に消えた 3 つの枠が pos===end で残り(4 項目)、印刷の突き合わせ(1 要素)が数の不一致で全体の設定に落ちて
 *   WARNING が `shown` になる
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TextSelection, type EditorState } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';

import { createMarkdownDocument, withFacePlugins } from './markdown-document';
import { alertVisibilityKey, alertVisibilityPlugin, faceAlerts } from './alert-visibility-plugin';
import { blockPos, textSpots } from './markdown.testkit';
import { ALL_ALERTS_SHOWN, applyAlertVisibility, currentAlertVisibility, type AlertVisibility } from '$lib/alert-visibility';
import { applyAlertStatesToPrint } from '$lib/alert-dom';

const URI = 'file:///Users/a/scripts/episode-12.md';

/**
 * 最上位ブロック: 0 P1 / 1 P2 / 2 P3 / 3 P4 / 4 NOTE / 5 NOTE / 6 NOTE / 7 P8 / 8 P9 / 9 WARNING。
 * NOTE は全体の設定で隠す(hidden)。WARNING は見出しで畳む(collapsed)。
 */
const MD = [
	'Paragraph one.',
	'',
	'Paragraph two.',
	'',
	'Paragraph three.',
	'',
	'Paragraph four is here.',
	'',
	'> [!NOTE]',
	'> note one',
	'',
	'> [!NOTE]',
	'> note two',
	'',
	'> [!NOTE]',
	'> note three',
	'',
	'Paragraph eight is here.',
	'',
	'Paragraph nine.',
	'',
	'> [!WARNING]',
	'> keep the camera running',
	'',
].join('\n');

/** NOTE だけ隠す設定。 */
const NOTE_HIDDEN: AlertVisibility = Object.freeze({ ...ALL_ALERTS_SHOWN, note: false });

function faceState(md: string): EditorState {
	return withFacePlugins(createMarkdownDocument(md, { uri: URI, readOnly: false }), [alertVisibilityPlugin()]).state;
}

/** 文書の最上位の alert の node とその位置(文書の順)。 */
function alertNodes(doc: PMNode): Array<{ pos: number; end: number; kind: string }> {
	const out: Array<{ pos: number; end: number; kind: string }> = [];
	doc.forEach((child, offset) => {
		if (child.type.name === 'alert') out.push({ pos: offset, end: offset + child.nodeSize, kind: String(child.attrs.kind).toLowerCase() });
	});
	return out;
}

/** 見出しを押したのと同じ取引(plugin の dispatchAlertMeta と同じ meta)。 */
function toggleAlert(state: EditorState, pos: number): EditorState {
	return state.apply(state.tr.setMeta(alertVisibilityKey, { toggle: pos }).setMeta('addToHistory', false));
}

/** 最上位ブロック `block` の text の `col` 文字目の位置。 */
function textPos(doc: PMNode, block: number, col: number): number {
	const spot = textSpots(doc, block).find((t) => !t.inCode)!;
	return spot.pos + col;
}

/** 印刷の文書(読み取り専用の描画と同じ形の枠)。 */
function printRoot(kinds: string[]): HTMLElement {
	const root = document.createElement('div');
	for (const kind of kinds) {
		const alert = document.createElement('blockquote');
		alert.className = `markdown-alert markdown-alert-${kind}`;
		const title = document.createElement('p');
		title.className = 'markdown-alert-title';
		title.textContent = kind.toUpperCase();
		const body = document.createElement('p');
		body.textContent = `${kind} body text`;
		alert.append(title, body);
		root.appendChild(alert);
	}
	return root;
}

beforeEach(() => {
	localStorage.clear();
	applyAlertVisibility(NOTE_HIDDEN);
});
afterEach(() => {
	applyAlertVisibility(ALL_ALERTS_SHOWN);
	localStorage.clear();
});

describe('Issue #860: 隠した枠を丸ごと消す範囲削除の後、面の枠の一覧に長さ 0 の項目を残さない', () => {
	function collapsedWarning(): { state: EditorState; warningPos: number } {
		let state = faceState(MD);
		const nodes = alertNodes(state.doc);
		expect(nodes.map((n) => n.kind)).toEqual(['note', 'note', 'note', 'warning']);
		const warningPos = nodes[3]!.pos;
		state = toggleAlert(state, warningPos);
		const before = faceAlerts(state);
		expect(before.map((a) => a.state), '前提: NOTE は隠れ・WARNING は畳んだ').toEqual(['hidden', 'hidden', 'hidden', 'collapsed']);
		return { state, warningPos };
	}

	it('段落 4 の途中〜段落 8 の途中の範囲削除(枠の隣でない=枠に触れない取引)で、消えた 3 つの NOTE は一覧から消え、WARNING だけが残る', () => {
		const { state } = collapsedWarning();
		const from = textPos(state.doc, 3, 'Paragraph four'.length);
		const to = textPos(state.doc, 7, 'Paragraph eight'.length);
		const next = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)).deleteSelection());

		expect(next.doc.textContent, '前提: 削除で 3 つの NOTE が丸ごと消え、段落 4 と 8 がつながる').toContain('Paragraph four is here.');
		const remaining = alertNodes(next.doc);
		expect(remaining.map((n) => n.kind), '前提: 文書に残る枠は WARNING だけ').toEqual(['warning']);

		const alerts = faceAlerts(next);
		expect(alerts.filter((a) => a.pos === a.end), '長さ 0 の項目を残さない').toEqual([]);
		expect(alerts, '文書に残っている枠だけ').toHaveLength(1);
		expect(alerts[0]!.kind).toBe('warning');
		expect(alerts[0]!.state, '畳んだ状態は保つ').toBe('collapsed');
		expect(alerts[0]!.pos).toBe(remaining[0]!.pos);
		expect(alerts[0]!.end).toBe(remaining[0]!.end);
	});

	it('その一覧で印刷の文書に当てると、残った WARNING は畳んだ形(collapsed)で出る(全体の設定に落ちて shown にならない)', () => {
		const { state } = collapsedWarning();
		const from = textPos(state.doc, 3, 'Paragraph four'.length);
		const to = textPos(state.doc, 7, 'Paragraph eight'.length);
		const next = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)).deleteSelection());

		const root = printRoot(['warning']);
		applyAlertStatesToPrint(root, faceAlerts(next), currentAlertVisibility());
		const warning = root.querySelector<HTMLElement>('blockquote.markdown-alert-warning');
		expect(warning, '印刷の文書に WARNING の枠がある').not.toBeNull();
		expect(warning!.getAttribute('data-alert-state')).toBe('collapsed');
		expect(warning!.hasAttribute('data-alert-summary')).toBe(true);
		expect(root.querySelectorAll('.vellis-alert-marker')).toHaveLength(0);
	});

	it('枠の中から枠の外への削除(枠に触れる取引)でも同じ結果(回帰の守り)', () => {
		const { state } = collapsedWarning();
		// 2 つ目の NOTE の中(最上位ブロック 5)の先頭から段落 8 の途中まで
		const from = blockPos(state.doc, 5) + 2;
		const to = textPos(state.doc, 7, 'Paragraph eight'.length);
		const next = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)).deleteSelection());

		const remaining = alertNodes(next.doc);
		const alerts = faceAlerts(next);
		expect(alerts.filter((a) => a.pos === a.end)).toEqual([]);
		expect(alerts.map((a) => [a.pos, a.end, a.kind])).toEqual(remaining.map((n) => [n.pos, n.end, n.kind]));
		expect(alerts.at(-1)!.state, 'WARNING の畳んだ状態は保つ').toBe('collapsed');
	});

	it('枠を消さない削除(段落 1 の途中〜段落 2 の途中)では、枠の一覧は位置が写るだけで数も状態も変わらない(回帰の守り)', () => {
		const { state } = collapsedWarning();
		const from = textPos(state.doc, 0, 'Paragraph'.length);
		const to = textPos(state.doc, 1, 'Paragraph'.length);
		const next = state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)).deleteSelection());

		const remaining = alertNodes(next.doc);
		const alerts = faceAlerts(next);
		expect(alerts.map((a) => [a.pos, a.end, a.kind])).toEqual(remaining.map((n) => [n.pos, n.end, n.kind]));
		expect(alerts.map((a) => a.state)).toEqual(['hidden', 'hidden', 'hidden', 'collapsed']);
	});
});
