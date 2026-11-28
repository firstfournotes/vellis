/**
 * CodeMirror の面(コードのファイルと plain text=`CodeEditor.svelte`・raw=`RawSourceEditor.svelte`)が共有する配線
 * (要件#74 契約5・17・23・第3段 3-3)。一致の装飾と数え方は `cm-find.ts`、置換の純関数は `cm-replace.ts`。
 * ここはそれを面の `EditorView` につなぐ糊(検索の運転・コピー・配色の読み込み)。
 */
import type { Compartment } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';

import type { MatchRange } from '$lib/find-in-document';
import { matchesIn, setFindMarks } from './cm-find';
import { replaceAllIn, replaceCurrentIn, type ReplaceOutcome } from './cm-replace';
import { highlightStyleFor } from './code-theme';
import { sliceStateText, stateLineEnding } from './text-document';

/** 打鍵の後の数え直しを待つ時間。 */
const RECOUNT_DELAY_MS = 150;

type View = () => EditorView | null | undefined;

/** 選択を一致 `target` へ移す取引の欄(移さない・一致が無いなら空)。 */
function moveTo(target: MatchRange | undefined, move: boolean) {
	return move && target ? { selection: { anchor: target.start, head: target.end }, scrollIntoView: true } : {};
}

export interface CmFinderOptions {
	view: View;
	/** 現在の一致の番目(Viewer が持つ)。 */
	current: () => number;
	/** 変換中か。真の間は語の変更と打鍵の後の数え直しを控え、`flush` で 1 回流す(契約10)。省けば待たない。 */
	composing?: () => boolean;
	/** 数えた一致を Viewer へ返す(位置は CodeMirror の文書の位置)。 */
	onResults?: (result: { query: string; ranges: MatchRange[]; current?: number }) => void;
}

export interface CmFinder {
	/** 今当てている語(空なら検索していない)。 */
	readonly query: string;
	/** 語を当てて文書全体を数える。`moveSelection` なら先頭の一致へ選択を移す。 */
	run(query: string, moveSelection: boolean): void;
	/** FindBar の語が変わった: 数え直して先頭の一致へ移る(変換中は確定まで待つ)。 */
	setQuery(query: string): void;
	/** 現在の一致が変わった(Prev / Next・番目合わせ): 選択をそこへ移す。 */
	setCurrent(current: number): void;
	/** 文書が変わった: 間をおいて数え直す(選択は動かさない)。 */
	scheduleRecount(): void;
	/** 文書を作り直した: 今の語で数え直す(選択は動かさない)。 */
	recount(): void;
	/** 変換が終わった: 控えた語の変更か数え直しを 1 回流す。 */
	flush(): void;
	/** 今の語の現在の一致を替える(替えた文字の終わり以降の最初の一致を現在に)。一致なしなら false。 */
	replaceCurrent(replacement: string): boolean;
	/** 今の語の全部を取引 1 つで替える。返り値は替えた数。 */
	replaceAll(replacement: string): number;
	dispose(): void;
}

/** 面の検索と置換の運転役(文書全体を数える・一致を装飾で塗る・Viewer へ結果を返す)。 */
export function createCmFinder(opts: CmFinderOptions): CmFinder {
	let query = '';
	let ranges: MatchRange[] = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pendingQuery: string | null = null;
	let recountPending = false;
	const composing = () => opts.composing?.() ?? false;

	function cancelRecount() {
		if (timer) clearTimeout(timer);
		timer = undefined;
	}

	function run(next: string, moveSelection: boolean) {
		const view = opts.view();
		if (!view) return;
		ranges = next.length === 0 ? [] : matchesIn(view.state.doc.toString(), next);
		query = next;
		const current = moveSelection ? 0 : Math.min(opts.current(), Math.max(0, ranges.length - 1));
		view.dispatch({ effects: setFindMarks.of({ ranges, current }), ...moveTo(ranges[current], moveSelection) });
		opts.onResults?.({ query, ranges });
	}

	/** 置換の後: 間をおいた数え直しを捨てて、今数え直した一致と現在を当て、Viewer へ返す。 */
	function applyOutcome(outcome: ReplaceOutcome, moveSelection: boolean) {
		const view = opts.view();
		if (!view) return;
		cancelRecount();
		ranges = outcome.ranges;
		view.dispatch({
			effects: setFindMarks.of({ ranges, current: outcome.current }),
			...moveTo(ranges[outcome.current], moveSelection),
		});
		opts.onResults?.({ query, ranges, current: outcome.current });
	}

	return {
		get query() {
			return query;
		},
		run,
		setQuery(next) {
			if (composing()) pendingQuery = next;
			else if (next !== query) run(next, true);
		},
		setCurrent(current) {
			const view = opts.view();
			const target = ranges[current];
			if (!view || !target) return;
			view.dispatch({ effects: setFindMarks.of({ ranges, current }), ...moveTo(target, true) });
		},
		scheduleRecount() {
			if (query.length === 0) return;
			cancelRecount();
			timer = setTimeout(() => {
				timer = undefined;
				if (composing()) recountPending = true;
				else run(query, false);
			}, RECOUNT_DELAY_MS);
		},
		recount() {
			if (query) run(query, false);
		},
		flush() {
			const next = pendingQuery;
			pendingQuery = null;
			const recount = recountPending;
			recountPending = false;
			if (next !== null && next !== query) run(next, true);
			else if (recount && query.length > 0) run(query, false);
		},
		replaceCurrent(replacement) {
			const view = opts.view();
			const outcome = view && replaceCurrentIn(view, query, opts.current(), replacement);
			if (!outcome) return false;
			applyOutcome(outcome, true);
			return true;
		},
		replaceAll(replacement) {
			const view = opts.view();
			const outcome = view && replaceAllIn(view, query, replacement);
			if (!outcome) return 0;
			applyOutcome(outcome, false);
			return outcome.count;
		},
		dispose: cancelRecount,
	};
}

/** 面の変換中(IME)の印(contentDOM の compositionstart〜compositionend を自前で数える=契約10)。 */
export interface CompositionWatch {
	/** 変換中か。 */
	readonly active: boolean;
	/** `EditorView.domEventHandlers` に混ぜる受け手。 */
	readonly handlers: { compositionstart: () => boolean; compositionend: () => boolean; blur: () => boolean };
}

/**
 * 変換中の印を作る(コードの面と raw の面で共有=Issue #840)。`onEnd` は変換が終わったとき(compositionend か、
 * 変換中の blur=WebKit は変換中の blur で compositionend を出さないことがある)に 1 回呼ぶ。受け手は既定の処理を止めない。
 */
export function createCompositionWatch(opts: { onStart?: () => void; onEnd: () => void }): CompositionWatch {
	let active = false;
	const end = () => {
		if (!active) return false;
		active = false;
		opts.onEnd();
		return false;
	};
	return {
		get active() {
			return active;
		},
		handlers: {
			compositionstart: () => {
				active = true;
				opts.onStart?.();
				return false;
			},
			compositionend: end,
			blur: end,
		},
	};
}

/**
 * コピー / 切り取り(契約17): `text/plain` は選んだ文字列そのもの(改行は文書の改行コード)。
 * 何も選んでいないときは何もしない(CodeMirror の既定の行ごとのコピーを止める=2026-11-16 由谷決定)。
 */
export function copySelection(event: ClipboardEvent, view: EditorView, cut: boolean): boolean {
	event.preventDefault();
	const ranges = view.state.selection.ranges.filter((r) => !r.empty);
	if (ranges.length === 0) return true;
	const text = ranges.map((r) => sliceStateText(view.state, r.from, r.to)).join(stateLineEnding(view.state));
	event.clipboardData?.clearData();
	event.clipboardData?.setData('text/plain', text);
	if (cut && !view.state.readOnly) {
		view.dispatch({
			changes: ranges.map((r) => ({ from: r.from, to: r.to })),
			userEvent: 'delete.cut',
			scrollIntoView: true,
		});
	}
	return true;
}

/**
 * 配色(Shiki のテーマの名前)を読んで `compartment` に当てる関数を作る。色だけ差し替える(文書・選択・履歴は保つ)。
 * 続けて呼んだら最後の 1 つだけが当たる(遅れて届いた古い応答は捨てる)。
 */
export function createHighlightLoader(view: View, compartment: Compartment): (name: string) => Promise<void> {
	let request = 0;
	return async (name) => {
		const mine = ++request;
		try {
			const style = await highlightStyleFor(name);
			const target = view();
			if (mine !== request || !target) return;
			target.dispatch({ effects: compartment.reconfigure(syntaxHighlighting(style)) });
		} catch (err) {
			console.warn(`Could not load the ${name} colours`, err);
		}
	};
}
