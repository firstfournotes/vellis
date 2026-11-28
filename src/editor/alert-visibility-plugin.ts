/**
 * 編集面(ProseMirror)の GitHub Alerts の隠す・畳む・開く(要件#90 契約2・3・4・5・7・8)。
 *
 * 文書には触れない: 枠の状態は decoration(node decoration で `data-alert-kind` / `data-alert-state` / `hidden` / `data-alert-summary`、
 * widget decoration で印)だけで出し、状態の変更は doc を変えない取引(meta だけ・`addToHistory: false`)で運ぶ。だから保存の byte も
 * Undo の履歴も変わらない(契約4)。DOM の形は読み取り専用の描画と同じ(`src/lib/alert-dom.ts`)。
 *
 * - 全体の設定は `$lib/alert-visibility` の store(mount のとき今の値・`subscribeAlertVisibility` で追う=契約7)
 * - 1 つずつの上書き(札・検索で開いた / 見出しで畳んだ)は plugin の state だけ(面を作り直すと消える)。位置は取引で写す
 * - 隠した・畳んだ枠の中に選択は入らない(appendTransaction で外へ直す)。矢印キーは隠した枠を飛ばす(契約8)
 */
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView, type NodeView, type ViewMutationRecord } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import {
	alertSummary,
	currentAlertVisibility,
	groupHiddenAlerts,
	hideAll,
	isAlertKind,
	sameAlertVisibility,
	subscribeAlertVisibility,
	type AlertKind,
	type AlertVisibility,
} from '$lib/alert-visibility';
import {
	ALERT_REVEAL_EVENT,
	ALERT_SELECTOR,
	ALERT_TITLE_SELECTOR,
	createAlertMarker,
	effectiveAlertState,
	overridesAfterSetting,
	selectionTouches,
	toggledOverride,
	type AlertOverride,
	type AlertState,
} from '$lib/alert-dom';

export interface FaceAlert {
	/** 枠の node の前の位置。 */
	pos: number;
	/** 枠の node の後ろの位置。 */
	end: number;
	kind: AlertKind;
	state: AlertState;
	summary?: string;
}

interface AlertPluginState {
	visibility: AlertVisibility;
	overrides: ReadonlyMap<number, AlertOverride>;
	/** 文書の順(入れ子は外側が先)。 */
	alerts: FaceAlert[];
	decorations: DecorationSet;
}

type AlertMeta =
	| { visibility: AlertVisibility; resetLocal?: boolean }
	| { reveal: number[] }
	| { toggle: number };

export const alertVisibilityKey = new PluginKey<AlertPluginState>('vellis-alert-visibility');

/** 印の組を作る設定(渡す種類はもう隠れたものだけ)。 */
const ALL_HIDDEN = hideAll();

function alertKindOf(node: PMNode): AlertKind | null {
	if (node.type.name !== 'alert') return null;
	const kind = String(node.attrs.kind ?? '').toLowerCase();
	return isAlertKind(kind) ? kind : null;
}

function compute(doc: PMNode, visibility: AlertVisibility, overrides: ReadonlyMap<number, AlertOverride>) {
	const alerts: FaceAlert[] = [];
	const decorations: Decoration[] = [];
	const visit = (parent: PMNode, contentStart: number) => {
		const kinds: Array<AlertKind | null> = [];
		const starts: number[] = [];
		parent.forEach((child, offset) => {
			const pos = contentStart + offset;
			starts.push(pos);
			const kind = alertKindOf(child);
			let hidden = false;
			if (kind) {
				const state = effectiveAlertState(visibility, kind, overrides.get(pos));
				const summary = state === 'collapsed' ? alertSummary(child.textBetween(0, child.content.size, ' ', ' ')) : undefined;
				alerts.push({ pos, end: pos + child.nodeSize, kind, state, summary });
				const attrs: Record<string, string> = { 'data-alert-kind': kind, 'data-alert-state': state };
				if (state === 'hidden') attrs.hidden = '';
				if (summary !== undefined) attrs['data-alert-summary'] = summary;
				decorations.push(Decoration.node(pos, pos + child.nodeSize, attrs, { alertState: state }));
				hidden = state === 'hidden';
			}
			kinds.push(hidden ? kind : null);
			if (!child.isTextblock && !child.isAtom && child.childCount > 0) visit(child, pos + 1);
		});
		for (const group of groupHiddenAlerts(kinds, ALL_HIDDEN)) {
			const at = starts[group.start]!;
			const size = group.end - group.start;
			const counts = group.counts;
			decorations.push(
				Decoration.widget(
					at,
					(view: EditorView, getPos: () => number | undefined) => {
						const marker = createAlertMarker(view.dom.ownerDocument, counts, () => revealGroupAt(view, getPos(), size));
						// 印は編集の外(カーソルも打鍵も入らない)
						marker.setAttribute('contenteditable', 'false');
						return marker;
					},
					{
						side: -1,
						key: `vellis-alert-marker:${at}:${size}:${counts.map(([k, n]) => `${k}${n}`).join('.')}`,
						stopEvent: () => true,
						ignoreSelection: true,
					},
				),
			);
		}
	};
	visit(doc, 0);
	// アラートの無い文書は decoration を作らない
	if (alerts.length === 0) return { alerts, decorations: DecorationSet.empty };
	return { alerts, decorations: DecorationSet.create(doc, decorations) };
}

/**
 * 取引がアラートの枠(とその隣)に触れたか。触れていなければ枠の状態も印の組も変わらないので、decoration は写すだけで足りる。
 * 変わった範囲(取引の後の文書の位置)を 1 つずつ外へ広げ、その中にアラートの node(祖先を含む)があれば触れた。
 */
function touchesAlerts(tr: Transaction): boolean {
	const doc = tr.doc;
	const size = doc.content.size;
	const maps = tr.mapping.maps;
	for (let i = 0; i < maps.length; i++) {
		const rest = tr.mapping.slice(i + 1);
		let hit = false;
		maps[i]!.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
			if (hit) return;
			const from = Math.max(0, rest.map(newStart, -1) - 1);
			const to = Math.min(size, rest.map(newEnd, 1) + 1);
			doc.nodesBetween(from, to, (node) => {
				if (hit) return false;
				if (node.type.name === 'alert') hit = true;
				return !hit && !node.isTextblock;
			});
		});
		if (hit) return true;
	}
	return false;
}

/**
 * 取引で枠の位置を写す(枠に触れていない取引のとき)。範囲削除で丸ごと消えた枠(写した後に長さ 0)は落とす
 * (Issue #860: 残すと印刷の突き合わせが数の不一致で全体の設定に落ちる)。
 */
function mapAlerts(alerts: FaceAlert[], tr: Transaction): FaceAlert[] {
	const out: FaceAlert[] = [];
	for (const a of alerts) {
		const pos = tr.mapping.map(a.pos, 1);
		const end = tr.mapping.map(a.end, -1);
		if (pos < end) out.push({ ...a, pos, end });
	}
	return out;
}

/** 印の組(`start` から続く `size` 個の枠)を開く。 */
function revealGroupAt(view: EditorView, start: number | undefined, size: number): void {
	if (start === undefined) return;
	const $start = view.state.doc.resolve(start);
	const parent = $start.parent;
	const positions: number[] = [];
	let pos = start;
	for (let i = $start.index(); i < parent.childCount && positions.length < size; i++) {
		const child = parent.child(i);
		if (!alertKindOf(child)) break;
		positions.push(pos);
		pos += child.nodeSize;
	}
	if (positions.length > 0) dispatchAlertMeta(view, { reveal: positions });
}

function dispatchAlertMeta(view: EditorView, meta: AlertMeta): void {
	view.dispatch(view.state.tr.setMeta(alertVisibilityKey, meta).setMeta('addToHistory', false));
}

function mapOverrides(overrides: ReadonlyMap<number, AlertOverride>, tr: Transaction): Map<number, AlertOverride> {
	const out = new Map<number, AlertOverride>();
	for (const [pos, value] of overrides) {
		const r = tr.mapping.mapResult(pos, 1);
		if (r.deleted) continue;
		const node = tr.doc.nodeAt(r.pos);
		if (node && alertKindOf(node)) out.set(r.pos, value);
	}
	return out;
}

/** 面の枠(文書の順)と状態。印刷の文書へ写すときに使う。 */
export function faceAlerts(state: EditorState): FaceAlert[] {
	return alertVisibilityKey.getState(state)?.alerts ?? [];
}

/** 隠した・畳んだ枠(中に選択を置かない範囲)。 */
function concealed(state: EditorState): FaceAlert[] {
	return faceAlerts(state).filter((a) => a.state !== 'shown');
}

/** `pos` を含む(端は含まない)隠した・畳んだ枠のうち一番外側。 */
function concealedAround(list: FaceAlert[], pos: number): FaceAlert | null {
	for (const a of list) if (pos > a.pos && pos < a.end) return a;
	return null;
}

/**
 * `pos`(ブロックの境)から `dir` の向きへ、続けて隠した・畳んだ枠を越えた位置。親の端に着いたら 1 段外へ出て続ける。
 * `skipped` は 1 つでも越えたか。
 */
function passConcealed(doc: PMNode, list: FaceAlert[], start: number, dir: 1 | -1): { pos: number; skipped: boolean } {
	let pos = start;
	let skipped = false;
	for (;;) {
		const $pos = doc.resolve(pos);
		const node = dir > 0 ? $pos.nodeAfter : $pos.nodeBefore;
		const at = node ? (dir > 0 ? pos : pos - node.nodeSize) : -1;
		if (node && alertKindOf(node) !== null && list.some((a) => a.pos === at)) {
			pos += dir * node.nodeSize;
			skipped = true;
			continue;
		}
		if (!node && $pos.depth > 0) {
			pos = dir > 0 ? $pos.after() : $pos.before();
			continue;
		}
		return { pos, skipped };
	}
}

/** 隠した・畳んだ枠 `around` の外で、`dir` の向きの最初の選択の置き場(連なりを越える)。無ければ null。 */
function placeOutside(doc: PMNode, list: FaceAlert[], around: FaceAlert, dir: 1 | -1): Selection | null {
	const { pos } = passConcealed(doc, list, dir > 0 ? around.end : around.pos, dir);
	const found = Selection.findFrom(doc.resolve(pos), dir, true);
	return found && !concealedAround(list, found.head) ? found : null;
}

/**
 * 選択の head が隠した・畳んだ枠の中なら、動いた向きへ枠の外に出す(契約8)。続けて隠れた枠は連なりごと越え、その向きに置き場が
 * 無ければ反対の向き、どちらにも無ければ文書の端。範囲の選択は head だけを動かす(anchor はそのまま)。
 */
function fixSelection(oldState: EditorState, newState: EditorState): Transaction | null {
	const list = concealed(newState);
	if (list.length === 0) return null;
	const { anchor, head, empty } = newState.selection;
	const around = concealedAround(list, head);
	if (!around) return null;
	const doc = newState.doc;
	const dir: 1 | -1 = head >= oldState.selection.head ? 1 : -1;
	const target =
		placeOutside(doc, list, around, dir) ??
		placeOutside(doc, list, around, dir > 0 ? -1 : 1) ??
		Selection.near(doc.resolve(dir > 0 ? doc.content.size : 0), dir > 0 ? -1 : 1);
	const selection = empty ? target : TextSelection.create(doc, anchor, target.head);
	return newState.tr.setSelection(selection).setMeta('addToHistory', false);
}

/**
 * カーソルが文字の塊の端にあり、その `dir` の向きの隣に隠した・畳んだ枠が続くとき、その連なりを越えた位置と今の枠の一覧。
 * そうでなければ null。
 */
function concealedAhead(state: EditorState, dir: 1 | -1): { pos: number; list: FaceAlert[] } | null {
	const sel = state.selection;
	if (!sel.empty || !(sel instanceof TextSelection)) return null;
	const $head = sel.$head;
	if (!$head.parent.isTextblock) return null;
	const atEdge = dir > 0 ? $head.parentOffset === $head.parent.content.size : $head.parentOffset === 0;
	if (!atEdge) return null;
	const list = concealed(state);
	if (list.length === 0) return null;
	const { pos, skipped } = passConcealed(state.doc, list, dir > 0 ? $head.after() : $head.before(), dir);
	return skipped ? { pos, list } : null;
}

/** 矢印キーで隠した枠を飛ばす(契約8)。カーソルが文字の塊の端にあり、その先に隠した枠が続くときだけ。 */
function skipConcealed(view: EditorView, dir: 1 | -1): boolean {
	const { state } = view;
	const ahead = concealedAhead(state, dir);
	if (!ahead) return false;
	const { pos, list } = ahead;
	const target = Selection.findFrom(state.doc.resolve(pos), dir, true);
	if (target && !concealedAround(list, target.head)) {
		view.dispatch(state.tr.setSelection(target).scrollIntoView());
	}
	return true;
}

/**
 * Backspace(文字の塊の先頭)/ Delete(末尾)の隣が隠した・畳んだ枠なら、結合を止める(何もしないで true=front-matter-guard と同じ形)。
 * 見えない枠の中身と結合しない(契約8)。出ている枠との結合は今までどおり。
 */
function guardJoin(view: EditorView, dir: 1 | -1): boolean {
	return concealedAhead(view.state, dir) !== null;
}

/** 見出しの要素からその枠の位置。 */
function alertPosOfTitle(view: EditorView, title: Element): number | null {
	const alertEl = title.closest(ALERT_SELECTOR);
	if (!alertEl || alertEl.querySelector(ALERT_TITLE_SELECTOR) !== title) return null;
	return alertPosOfElement(view, alertEl);
}

function alertPosOfElement(view: EditorView, el: Element): number | null {
	for (const a of faceAlerts(view.state)) if (view.nodeDOM(a.pos) === el) return a.pos;
	return null;
}

function titleOf(view: EditorView, event: Event): Element | null {
	const target = event.target as Element | null;
	const title = target?.closest?.(ALERT_TITLE_SELECTOR) ?? null;
	return title && view.dom.contains(title) ? title : null;
}

/**
 * アラートの枠の NodeView(markdown-schema の toDOM と同じ形)。見出しを操作子にする: role=button・tabindex=0・aria-expanded
 * (decoration の spec の状態から)。見出しは文書の外なので、そこの変化は ProseMirror に読ませない。
 */
class AlertView implements NodeView {
	dom: HTMLElement;
	contentDOM: HTMLElement;
	private title: HTMLElement;
	private kind: string;

	constructor(node: PMNode, doc: Document, decorations: readonly Decoration[]) {
		this.kind = String(node.attrs.kind);
		this.dom = doc.createElement('blockquote');
		this.dom.className = `markdown-alert markdown-alert-${this.kind}`;
		this.title = doc.createElement('p');
		this.title.className = 'markdown-alert-title';
		this.title.setAttribute('contenteditable', 'false');
		this.title.setAttribute('role', 'button');
		this.title.setAttribute('tabindex', '0');
		this.title.textContent = this.kind;
		this.contentDOM = doc.createElement('div');
		this.dom.append(this.title, this.contentDOM);
		this.setExpanded(decorations);
	}

	private setExpanded(decorations: readonly Decoration[]) {
		const deco = decorations.find((d) => (d.spec as { alertState?: AlertState }).alertState !== undefined);
		const state = (deco?.spec as { alertState?: AlertState } | undefined)?.alertState ?? 'shown';
		this.title.setAttribute('aria-expanded', state === 'shown' ? 'true' : 'false');
	}

	update(node: PMNode, decorations: readonly Decoration[]): boolean {
		if (node.type.name !== 'alert' || String(node.attrs.kind) !== this.kind) return false;
		this.setExpanded(decorations);
		return true;
	}

	ignoreMutation(mutation: ViewMutationRecord): boolean {
		if (mutation.type === 'selection') return false;
		return !this.contentDOM.contains(mutation.target);
	}
}

export function alertVisibilityPlugin(): Plugin<AlertPluginState> {
	return new Plugin<AlertPluginState>({
		key: alertVisibilityKey,
		state: {
			init: (_config, state) => {
				const visibility = currentAlertVisibility();
				const overrides = new Map<number, AlertOverride>();
				return { visibility, overrides, ...compute(state.doc, visibility, overrides) };
			},
			apply: (tr, prev) => {
				const meta = tr.getMeta(alertVisibilityKey) as AlertMeta | undefined;
				if (!meta && !tr.docChanged) return prev;
				// 枠に触れない打鍵・取引は decoration を写すだけ(状態も印の組も変わらない)
				if (!meta && !touchesAlerts(tr)) {
					return {
						...prev,
						overrides: mapOverrides(prev.overrides, tr),
						alerts: mapAlerts(prev.alerts, tr),
						decorations: prev.decorations.map(tr.mapping, tr.doc),
					};
				}
				let visibility = prev.visibility;
				let overrides: Map<number, AlertOverride> = tr.docChanged ? mapOverrides(prev.overrides, tr) : new Map(prev.overrides);
				if (meta && 'visibility' in meta) {
					const byPos = new Map(prev.alerts.map((a) => [a.pos, a.kind] as const));
					overrides =
						overridesAfterSetting(overrides, (pos) => byPos.get(pos), visibility, meta.visibility, meta.resetLocal === true) ??
						overrides;
					visibility = meta.visibility;
				} else if (meta && 'reveal' in meta) {
					for (const pos of meta.reveal) overrides.set(pos, 'shown');
				} else if (meta && 'toggle' in meta) {
					const current = prev.alerts.find((a) => a.pos === meta.toggle);
					const next = current ? toggledOverride(current.state) : null;
					if (next) overrides.set(meta.toggle, next);
				}
				return { visibility, overrides, ...compute(tr.doc, visibility, overrides) };
			},
		},
		appendTransaction: (_trs, oldState, newState) => fixSelection(oldState, newState),
		props: {
			decorations: (state) => alertVisibilityKey.getState(state)?.decorations ?? DecorationSet.empty,
			nodeViews: { alert: (node, view, _getPos, decorations) => new AlertView(node, view.dom.ownerDocument, decorations) },
			handleKeyDown: (view, event) => {
				// 見出しは操作子: Enter / Space で畳む・開く(契約3)
				const title = titleOf(view, event);
				if (title) {
					if (event.key !== 'Enter' && event.key !== ' ') return false;
					const pos = alertPosOfTitle(view, title);
					if (pos === null) return false;
					dispatchAlertMeta(view, { toggle: pos });
					return true;
				}
				if (event.key === 'Backspace') return guardJoin(view, -1);
				if (event.key === 'Delete') return guardJoin(view, 1);
				if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
				if (event.key === 'ArrowRight' || event.key === 'ArrowDown') return skipConcealed(view, 1);
				if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') return skipConcealed(view, -1);
				return false;
			},
			handleDOMEvents: {
				// 見出しを押すと畳む・開く(契約3)。mousedown は既定を止める(見出しにカーソルを置きに行かない)
				mousedown: (view, event) => {
					if ((event as MouseEvent).button !== 0 || !titleOf(view, event)) return false;
					event.preventDefault();
					return true;
				},
				click: (view, event) => {
					const title = titleOf(view, event);
					if (!title) return false;
					// 左ボタン以外・見出しの字のドラッグ選択では畳まない
					if ((event as MouseEvent).button !== 0 || selectionTouches(title)) return false;
					const pos = alertPosOfTitle(view, title);
					if (pos === null) return false;
					event.preventDefault();
					dispatchAlertMeta(view, { toggle: pos });
					return true;
				},
				// 検索の一致へ移るとき、その枠だけを開く(契約5)
				[ALERT_REVEAL_EVENT]: (view, event) => {
					const target = event.target as Element | null;
					if (!target) return false;
					const pos = alertPosOfElement(view, target);
					if (pos === null) return false;
					dispatchAlertMeta(view, { reveal: [pos] });
					return true;
				},
			},
		},
		view: (view) => {
			const unsubscribe = subscribeAlertVisibility((visibility, change) => {
				const prev = alertVisibilityKey.getState(view.state);
				const same = !!prev && sameAlertVisibility(prev.visibility, visibility);
				if (same && (!change.resetLocal || prev.overrides.size === 0)) return;
				dispatchAlertMeta(view, { visibility, resetLocal: change.resetLocal });
			});
			return { destroy: unsubscribe };
		},
	});
}
