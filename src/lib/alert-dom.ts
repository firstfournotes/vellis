/**
 * GitHub Alerts の隠す・畳む・開くの DOM の側(要件#90 契約2・3・5・6・9)。
 *
 * 面(ProseMirror)と読み取り専用の描画は同じ DOM の形にする:
 * - 枠 `blockquote.markdown-alert[data-alert-kind][data-alert-state="shown|collapsed|hidden"]`。hidden は `hidden` 属性で見えなくし、
 *   中身は DOM に残す(検索が容器の textContent で数える=契約5)。collapsed は `data-alert-summary` に中身の最初の数語
 * - 印 `div.vellis-alert-marker[data-testid="alert-marker"][data-alert-counts]` > `button[data-testid="alert-marker-label"]`。続けて隠れた
 *   枠の組の最初の枠の直前の兄弟。札の字は CSS(`content: attr(data-label)`)で描き textContent は空(検索・コピーに混ぜない)
 *
 * ここに置くのは、両方が使う部品(種類の読み取り・印の要素・検索で開く知らせ・印刷の文書への写し)と、読み取り専用の描画の
 * 受け手(`attachAlertVisibility`)。面の側は `src/editor/alert-visibility-plugin.ts`(decoration で同じ属性と印を出す)。
 */
import {
	ALERT_KINDS,
	ALERT_MARKER_CLASS,
	alertSummary,
	currentAlertVisibility,
	groupHiddenAlerts,
	hideAll,
	isHidden,
	markerCounts,
	markerLabel,
	subscribeAlertVisibility,
	type AlertKind,
	type AlertVisibility,
	type HiddenAlertGroup,
} from './alert-visibility';

export const ALERT_SELECTOR = 'blockquote.markdown-alert';
export const ALERT_TITLE_SELECTOR = '.markdown-alert-title';
const ALERT_MARKER_LABEL_TESTID = 'alert-marker-label';
const ALERT_MARKER_LABEL_SELECTOR = `[data-testid="${ALERT_MARKER_LABEL_TESTID}"]`;
const CONCEALED_SELECTOR = `${ALERT_SELECTOR}[data-alert-state="hidden"], ${ALERT_SELECTOR}[data-alert-state="collapsed"]`;
/** 印の組を作る設定(渡す種類はもう隠れたものだけ)。 */
const ALL_HIDDEN = hideAll();

/** 隠した・畳んだ枠を開いてほしいという知らせ(枠の要素に送る・泡立つ)。面と読み取り専用の描画の両方が受ける。 */
export const ALERT_REVEAL_EVENT = 'vellis-alert-reveal';

export type AlertState = 'shown' | 'collapsed' | 'hidden';
/** 1 つずつの上書き(札・検索で開いた=shown、見出しで畳んだ=collapsed)。面の中だけで、覚えない(契約7)。 */
export type AlertOverride = 'shown' | 'collapsed';

/** 枠の種類(class `markdown-alert-<kind>`)。要件15 の 5 種でなければ null(契約10)。 */
function alertKindOfElement(el: Element): AlertKind | null {
	if (!el.classList.contains('markdown-alert')) return null;
	for (const kind of ALERT_KINDS) if (el.classList.contains(`markdown-alert-${kind}`)) return kind;
	return null;
}

/** 全体の設定と上書きから、枠の状態。全体の設定で隠れている枠は、札・検索で開いたときだけ出る(畳んだ形は設定に負ける)。 */
export function effectiveAlertState(v: AlertVisibility, kind: AlertKind, override: AlertOverride | undefined): AlertState {
	if (isHidden(v, kind)) return override === 'shown' ? 'shown' : 'hidden';
	return override === 'collapsed' ? 'collapsed' : 'shown';
}

/** 設定が変わった種類(その種類の枠の上書きを捨てる=設定が当たるたびに設定が勝つ)。 */
export function changedKinds(before: AlertVisibility, after: AlertVisibility): Set<AlertKind> {
	return new Set(ALERT_KINDS.filter((kind) => before[kind] !== after[kind]));
}

/** 見出しで畳む・開く(契約3): 出ている枠は畳み、畳んだ枠は開く。隠れている枠は変えない(null)。 */
export function toggledOverride(state: AlertState): AlertOverride | null {
	if (state === 'shown') return 'collapsed';
	if (state === 'collapsed') return 'shown';
	return null;
}

/**
 * 全体の設定が `before` から `after` になったときに残す上書き(契約7)。Show All / Hide All(`resetLocal`)は全部捨て、ほかは設定が
 * 変わった種類の枠のものだけ捨てる。設定も上書きも変わらないときは null(描き直さなくてよい)。面(位置が鍵)と読み取り専用の描画
 * (要素が鍵)の両方が使う。
 */
export function overridesAfterSetting<K>(
	overrides: ReadonlyMap<K, AlertOverride>,
	kindOf: (key: K) => AlertKind | undefined,
	before: AlertVisibility,
	after: AlertVisibility,
	resetLocal: boolean,
): Map<K, AlertOverride> | null {
	const changed = changedKinds(before, after);
	if (resetLocal) return changed.size === 0 && overrides.size === 0 ? null : new Map();
	if (changed.size === 0) return null;
	return new Map(
		[...overrides].filter(([key]) => {
			const kind = kindOf(key);
			return kind === undefined || !changed.has(kind);
		}),
	);
}

/**
 * 印の要素。`onReveal` は札を押したとき(mousedown は既定を止めてフォーカスと選択を動かさない)。
 */
export function createAlertMarker(
	doc: Document,
	counts: HiddenAlertGroup['counts'],
	onReveal?: () => void,
): HTMLDivElement {
	const marker = doc.createElement('div');
	marker.className = ALERT_MARKER_CLASS;
	marker.setAttribute('data-testid', 'alert-marker');
	marker.setAttribute('data-alert-counts', markerCounts(counts));
	// 線の色は最初の種類の色(CSS)
	if (counts[0]) marker.setAttribute('data-alert-kind', counts[0][0]);
	const label = markerLabel(counts);
	const button = doc.createElement('button');
	button.type = 'button';
	button.className = 'vellis-alert-marker-label';
	button.setAttribute('data-testid', ALERT_MARKER_LABEL_TESTID);
	button.setAttribute('aria-label', label);
	button.setAttribute('data-label', label);
	button.title = `Show ${label}`;
	if (onReveal) {
		button.addEventListener('mousedown', (e) => e.preventDefault());
		button.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			onReveal();
		});
	}
	marker.append(button);
	return marker;
}

/**
 * 検索の一致がある場所(`node`)を囲む、隠した・畳んだ枠を開いてもらう(契約5)。外側の枠から順に知らせる。
 * 開いたら true(どれかが隠れていた)。
 */
export function revealAlertsAround(node: Node | null): boolean {
	let el: Element | null = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
	const concealed: Element[] = [];
	while (el) {
		const hit: Element | null = el.closest(CONCEALED_SELECTOR);
		if (!hit) break;
		concealed.push(hit);
		el = hit.parentElement;
	}
	for (const alert of concealed.reverse()) {
		alert.dispatchEvent(new CustomEvent(ALERT_REVEAL_EVENT, { bubbles: true }));
	}
	return concealed.length > 0;
}

/** `root` の中に隠した・畳んだ枠があるか(無ければ検索で開くものも無い)。 */
export function hasConcealedAlert(root: ParentNode): boolean {
	return root.querySelector(CONCEALED_SELECTOR) !== null;
}

/** 見出しの字をドラッグで選んだ(click の時点で選択が見出しにかかっている)か。 */
export function selectionTouches(el: Element): boolean {
	const sel = el.ownerDocument.getSelection();
	if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
	return sel.getRangeAt(0).intersectsNode(el);
}

/** 枠の本文の文字(見出しを除く)。 */
function bodyTextOfAlertElement(alert: Element): string {
	const title = alert.querySelector(ALERT_TITLE_SELECTOR)?.textContent ?? '';
	const all = alert.textContent ?? '';
	return all.startsWith(title) ? all.slice(title.length) : all.replace(title, '');
}

/** 1 つの枠に状態の属性を当てる。 */
function setAlertElementState(alert: HTMLElement, kind: AlertKind, state: AlertState, summary?: string): void {
	alert.setAttribute('data-alert-kind', kind);
	alert.setAttribute('data-alert-state', state);
	alert.hidden = state === 'hidden';
	// 見出しは操作子(押す・Enter / Space で畳む・開く)
	const title = alert.querySelector(ALERT_TITLE_SELECTOR);
	if (title) {
		title.setAttribute('role', 'button');
		title.setAttribute('tabindex', '0');
		title.setAttribute('aria-expanded', state === 'shown' ? 'true' : 'false');
	}
	if (state === 'collapsed') alert.setAttribute('data-alert-summary', summary ?? alertSummary(bodyTextOfAlertElement(alert)));
	else alert.removeAttribute('data-alert-summary');
}

/**
 * 印刷の文書(刷る直前の `render()` の HTML)へ面の状態を写す(契約6): 隠した枠は外し、印は置かず、畳んだ枠は畳んだ形。
 * `states` は面の枠の文書の順の状態。数か種類が合わない枠は全体の設定だけで決める。
 */
export function applyAlertStatesToPrint(
	root: ParentNode,
	states: ReadonlyArray<{ kind: AlertKind; state: AlertState; summary?: string }>,
	v: AlertVisibility,
): void {
	const alerts = [...root.querySelectorAll<HTMLElement>(ALERT_SELECTOR)];
	const kinds = alerts.map(alertKindOfElement);
	const aligned = states.length === alerts.length && states.every((s, i) => s.kind === kinds[i]);
	const remove: HTMLElement[] = [];
	alerts.forEach((alert, i) => {
		const kind = kinds[i];
		if (!kind) return;
		const s = aligned ? states[i]! : { kind, state: effectiveAlertState(v, kind, undefined) };
		if (s.state === 'hidden') remove.push(alert);
		else setAlertElementState(alert, kind, s.state, s.summary);
	});
	for (const alert of remove) alert.remove();
	for (const marker of root.querySelectorAll(`.${ALERT_MARKER_CLASS}`)) marker.remove();
}

/**
 * 読み取り専用の描画(2 MiB 超・ssh)の受け手(契約9)。`root` の中の枠に状態の属性と印を付け、設定(`$lib/alert-visibility`)を追い、
 * 見出しのクリックで畳む・開く・札のクリックでその組を開く・検索の知らせ(`ALERT_REVEAL_EVENT`)で開く。戻り値で外す(印も外す)。
 * 文書(原文)には触れない。
 */
export function attachAlertVisibility(root: HTMLElement): () => void {
	const doc = root.ownerDocument;
	const alerts = [...root.querySelectorAll<HTMLElement>(ALERT_SELECTOR)].filter((el) => alertKindOfElement(el) !== null);
	if (alerts.length === 0) return () => {};
	const kindOf = new Map(alerts.map((el) => [el, alertKindOfElement(el)!] as const));
	let overrides = new Map<HTMLElement, AlertOverride>();
	let visibility = currentAlertVisibility();
	let markers: HTMLElement[] = [];

	const stateOf = (el: HTMLElement): AlertState => effectiveAlertState(visibility, kindOf.get(el)!, overrides.get(el));

	function render() {
		for (const m of markers) m.remove();
		markers = [];
		for (const el of alerts) setAlertElementState(el, kindOf.get(el)!, stateOf(el));
		const parents = new Set<Element>();
		for (const el of alerts) if (el.parentElement) parents.add(el.parentElement);
		for (const parent of parents) {
			const children = [...parent.children] as HTMLElement[];
			const kinds = children.map((child) => (kindOf.has(child) && stateOf(child) === 'hidden' ? kindOf.get(child)! : null));
			for (const group of groupHiddenAlerts(kinds, ALL_HIDDEN)) {
				const members = children.slice(group.start, group.end);
				const marker = createAlertMarker(doc, group.counts, () => {
					for (const el of members) overrides.set(el, 'shown');
					render();
				});
				parent.insertBefore(marker, members[0]!);
				markers.push(marker);
			}
		}
	}

	/** 見出しの要素(この受け手の枠のもの)なら、その枠。 */
	const alertOfTitle = (target: Element | null): HTMLElement | null => {
		if (!target || target.closest(ALERT_MARKER_LABEL_SELECTOR)) return null;
		const title = target.closest(ALERT_TITLE_SELECTOR);
		const alert = title?.closest<HTMLElement>(ALERT_SELECTOR) ?? null;
		if (!alert || !kindOf.has(alert) || alert.querySelector(ALERT_TITLE_SELECTOR) !== title) return null;
		return alert;
	};
	const toggle = (alert: HTMLElement) => {
		const next = toggledOverride(stateOf(alert));
		if (!next) return;
		overrides.set(alert, next);
		render();
	};
	const onClick = (e: MouseEvent) => {
		const alert = alertOfTitle(e.target as Element | null);
		if (!alert) return;
		// 左ボタン以外・見出しの字のドラッグ選択では畳まない
		if (e.button !== 0 || selectionTouches(alert.querySelector(ALERT_TITLE_SELECTOR)!)) return;
		toggle(alert);
	};
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== 'Enter' && e.key !== ' ') return;
		const alert = alertOfTitle(e.target as Element | null);
		if (!alert) return;
		e.preventDefault();
		toggle(alert);
	};
	const onReveal = (e: Event) => {
		const alert = e.target as HTMLElement;
		if (!kindOf.has(alert) || stateOf(alert) === 'shown') return;
		overrides.set(alert, 'shown');
		render();
	};
	const unsubscribe = subscribeAlertVisibility((next, change) => {
		const kept = overridesAfterSetting(overrides, (el) => kindOf.get(el), visibility, next, change.resetLocal);
		visibility = next;
		if (!kept) return;
		overrides = kept;
		render();
	});
	root.addEventListener('click', onClick);
	root.addEventListener('keydown', onKeyDown);
	root.addEventListener(ALERT_REVEAL_EVENT, onReveal);
	render();
	return () => {
		unsubscribe();
		root.removeEventListener('click', onClick);
		root.removeEventListener('keydown', onKeyDown);
		root.removeEventListener(ALERT_REVEAL_EVENT, onReveal);
		for (const m of markers) m.remove();
		markers = [];
	};
}
