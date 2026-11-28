/**
 * GitHub Alerts の表示の設定(要件#90 契約1・2・3・7)。
 *
 * 全部・種類ごとの「出す / 隠す」はアプリ全体で 1 値=localStorage(キー `vellis.alerts`)に持ち、他の窓は `storage` イベントで追う
 * (View ▸ Toggle Full Width・Show Formatting Toolbar と同じ「窓の見た目の好み」の流儀)。View ▸ Alerts の項目は `menu.rs` が前面の窓へ
 * `emit_to` し、ここが listen して設定を変える。変えたら `alerts_state` で Rust に知らせ、チェック印と Show All / Hide All の有効を合わせる。
 *
 * 1 つずつ畳んだ・札で開いたのは面の中だけ(ここには持たない=契約7)。面(ProseMirror)と読み取り専用の描画は
 * `subscribeAlertVisibility` で設定を追い、印・畳んだ形の DOM は `src/lib/alert-dom.ts` と `src/editor/alert-visibility-plugin.ts`。
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from './events';

// --- 種類と設定の形(契約1・7。true = 出す) ------------------------------------

/** 要件15 の 5 種・この順(`menu.rs` の `ALERT_KINDS` と同じ)。 */
export const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export type AlertVisibility = Readonly<Record<AlertKind, boolean>>;

/** 既定=全部出す。 */
export const ALL_ALERTS_SHOWN: AlertVisibility = Object.freeze({
	note: true,
	tip: true,
	important: true,
	warning: true,
	caution: true,
});

export function isAlertKind(value: unknown): value is AlertKind {
	return typeof value === 'string' && (ALERT_KINDS as readonly string[]).includes(value);
}

/** 札の種類名(大文字)。 */
export function alertKindLabel(kind: AlertKind): string {
	return kind.toUpperCase();
}

function build(shown: (kind: AlertKind) => boolean): AlertVisibility {
	const out = {} as Record<AlertKind, boolean>;
	for (const kind of ALERT_KINDS) out[kind] = shown(kind);
	return out;
}

export function isHidden(v: AlertVisibility, kind: AlertKind): boolean {
	return !v[kind];
}

export function anyShown(v: AlertVisibility): boolean {
	return ALERT_KINDS.some((kind) => v[kind]);
}

export function allHidden(v: AlertVisibility): boolean {
	return !anyShown(v);
}

export function showAll(): AlertVisibility {
	return build(() => true);
}

export function hideAll(): AlertVisibility {
	return build(() => false);
}

/** どれか 1 種類でも出ていれば全部を隠し、全部が隠れていれば全部を出す(契約1)。 */
export function toggleAll(v: AlertVisibility): AlertVisibility {
	return anyShown(v) ? hideAll() : showAll();
}

/** その種類だけ反転(ほかは不変・入力は変えない)。 */
export function toggleKind(v: AlertVisibility, kind: AlertKind): AlertVisibility {
	return build((k) => (k === kind ? !v[k] : v[k]));
}

export function sameAlertVisibility(a: AlertVisibility, b: AlertVisibility): boolean {
	return ALERT_KINDS.every((kind) => a[kind] === b[kind]);
}

// --- 保存の形(契約7) ---------------------------------------------------------

export const ALERT_VISIBILITY_STORAGE_KEY = 'vellis.alerts';
/**
 * Show All / Hide All の知らせ(値は毎回変わる印)。他の窓も 1 つずつの開き・畳みを全部捨てる。設定の値そのものは
 * `vellis.alerts` だけに置く(5 キーの形は変えない)。
 */
export const ALERT_VISIBILITY_RESET_STORAGE_KEY = 'vellis.alerts-reset';

/** JSON の 5 キー(ALERT_KINDS の順)。 */
export function serializeAlertVisibility(v: AlertVisibility): string {
	return JSON.stringify(build((kind) => v[kind]));
}

/** 読めない値は全部出す。キーが無い・boolean でない種類は出す。余分なキーは捨てる。 */
export function parseAlertVisibility(raw: string | null): AlertVisibility {
	if (raw === null) return ALL_ALERTS_SHOWN;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return ALL_ALERTS_SHOWN;
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return ALL_ALERTS_SHOWN;
	const record = value as Record<string, unknown>;
	return build((kind) => (typeof record[kind] === 'boolean' ? (record[kind] as boolean) : true));
}

// --- イベント名(src-tauri/src/menu.rs の同名 pub const と同綴り) -------------------

export const MENU_ALERTS_SHOW_ALL_EVENT = 'menu_alerts_show_all';
export const MENU_ALERTS_HIDE_ALL_EVENT = 'menu_alerts_hide_all';
export const MENU_ALERTS_TOGGLE_KIND_EVENT = 'menu_alerts_toggle_kind';
export const ALERTS_STATE_EVENT = 'alerts_state';

// --- 印(契約2)の純関数 -------------------------------------------------------

export const ALERT_MARKER_CLASS = 'vellis-alert-marker';

export interface HiddenAlertGroup {
	start: number;
	end: number;
	counts: ReadonlyArray<readonly [AlertKind, number]>;
}

/**
 * `kinds[i]` = ブロック i のアラートの種類(アラートでないブロックは null)。隠す種類の枠が続く区間(間に null も出ている枠も無い)
 * を 1 つの印にまとめる。`[start, end)` はブロックの番号。counts はその区間で最初に現れた順。
 */
export function groupHiddenAlerts(kinds: ReadonlyArray<AlertKind | null>, v: AlertVisibility): HiddenAlertGroup[] {
	const groups: HiddenAlertGroup[] = [];
	let start = -1;
	let counts: Array<[AlertKind, number]> = [];
	const close = (end: number) => {
		if (start >= 0) groups.push({ start, end, counts });
		start = -1;
		counts = [];
	};
	kinds.forEach((kind, i) => {
		if (kind === null || !isHidden(v, kind)) {
			close(i);
			return;
		}
		if (start < 0) start = i;
		const entry = counts.find(([k]) => k === kind);
		if (entry) entry[1] += 1;
		else counts.push([kind, 1]);
	});
	close(kinds.length);
	return groups;
}

/** 'NOTE 2' / 'NOTE 1 · WARNING 1'。 */
export function markerLabel(counts: HiddenAlertGroup['counts']): string {
	return counts.map(([kind, n]) => `${alertKindLabel(kind)} ${n}`).join(' · ');
}

/** 'note:2' / 'note:1,warning:1'(data-alert-counts の値)。 */
export function markerCounts(counts: HiddenAlertGroup['counts']): string {
	return counts.map(([kind, n]) => `${kind}:${n}`).join(',');
}

// --- 畳んだ形(契約3)の要約 ----------------------------------------------------

export const ALERT_SUMMARY_MAX_CHARS = 60;

/** 空白を 1 つに潰して trim。60 字を超えるなら語の境目で切って '…' を足す。 */
export function alertSummary(bodyText: string): string {
	const text = bodyText.replace(/\s+/g, ' ').trim();
	if (text.length <= ALERT_SUMMARY_MAX_CHARS) return text;
	const head = text.slice(0, ALERT_SUMMARY_MAX_CHARS + 1);
	const cut = head.lastIndexOf(' ');
	// 語の境目が無い(60 字を超える 1 語)ときは字数で切る
	const kept = (cut > 0 ? head.slice(0, cut) : text.slice(0, ALERT_SUMMARY_MAX_CHARS)).trimEnd();
	return `${kept}…`;
}

// --- 覚える・配る(契約7) -----------------------------------------------------

/**
 * 購読者への知らせ。`resetLocal` = Show All / Hide All(とショートカット)=全部の種類を当て直し、1 つずつの開き(札・検索)と
 * 畳みを全部捨てる。種類ごとのチェックでは偽(変わった種類の分だけ捨てる)。
 */
export interface AlertVisibilityChange {
	resetLocal: boolean;
}
export type AlertVisibilityListener = (v: AlertVisibility, change: AlertVisibilityChange) => void;

let current: AlertVisibility = ALL_ALERTS_SHOWN;
const subscribers = new Set<AlertVisibilityListener>();
let resetSeq = 0;

function readStorage(): string | null {
	try {
		return localStorage.getItem(ALERT_VISIBILITY_STORAGE_KEY);
	} catch {
		return null;
	}
}

function writeStorage(v: AlertVisibility): void {
	try {
		localStorage.setItem(ALERT_VISIBILITY_STORAGE_KEY, serializeAlertVisibility(v));
	} catch {
		// 保存できなくても今の窓には当たっている
	}
}

function writeResetMark(): void {
	try {
		localStorage.setItem(ALERT_VISIBILITY_RESET_STORAGE_KEY, `${Date.now()}-${++resetSeq}`);
	} catch {
		// 他の窓には値の変化だけが届く(変わった種類の分だけ捨てる)
	}
}

function setCurrent(next: AlertVisibility, resetLocal = false): void {
	current = build((kind) => next[kind]);
	const change: AlertVisibilityChange = { resetLocal };
	for (const fn of [...subscribers]) fn(current, change);
}

export function currentAlertVisibility(): AlertVisibility {
	return current;
}

/** localStorage を読んで今の値にして返す(保存はし直さない)。 */
export function loadAlertVisibility(): AlertVisibility {
	const next = parseAlertVisibility(readStorage());
	if (!sameAlertVisibility(next, current)) setCurrent(next);
	return current;
}

/**
 * 今の値にして localStorage に書き、購読者に知らせ、Rust に知らせる。`resetLocal`(Show All / Hide All)は 1 つずつの開き・畳みも
 * 全部捨てさせ、他の窓にも同じ知らせを置く。
 */
export function applyAlertVisibility(next: AlertVisibility, options: { resetLocal?: boolean } = {}): void {
	const resetLocal = options.resetLocal === true;
	setCurrent(next, resetLocal);
	writeStorage(current);
	if (resetLocal) writeResetMark();
	void announceAlertVisibility(current);
}

export function subscribeAlertVisibility(fn: AlertVisibilityListener): () => void {
	subscribers.add(fn);
	return () => {
		subscribers.delete(fn);
	};
}

/** View ▸ Alerts のチェック印と Show All / Hide All の有効のために Rust に知らせる。Tauri の外では何もしない。 */
export async function announceAlertVisibility(v: AlertVisibility): Promise<void> {
	try {
		const win = getCurrentWindow();
		await win.emit(ALERTS_STATE_EVENT, { label: win.label, visibility: v });
	} catch {
		// Tauri の外(テストの jsdom など)
	}
}

/**
 * メニューの 3 つのイベントと、他の窓の選択(storage イベント)を受ける。登録の直後に今の値を 1 回知らせる(起動時のチェック印)。
 * 戻り値は全部を解除する関数。
 */
export async function registerAlertVisibilityListeners(): Promise<() => void> {
	const offs: Array<() => void> = [];
	let disposed = false;
	const keep = (off: () => void) => {
		if (disposed) off();
		else offs.push(off);
	};
	const subscribe = async (event: string, handler: (payload: unknown) => void) => {
		try {
			keep(await listen<unknown>(event, (e) => handler(e.payload)));
		} catch {
			// Tauri の外。メニューからは来ない
		}
	};
	await Promise.all([
		// Show All / Hide All は全部の種類を当て直し、1 つずつの開き・畳みも捨てる
		subscribe(MENU_ALERTS_SHOW_ALL_EVENT, () => applyAlertVisibility(showAll(), { resetLocal: true })),
		subscribe(MENU_ALERTS_HIDE_ALL_EVENT, () => applyAlertVisibility(hideAll(), { resetLocal: true })),
		subscribe(MENU_ALERTS_TOGGLE_KIND_EVENT, (payload) => {
			if (!isAlertKind(payload)) return;
			applyAlertVisibility(toggleKind(current, payload));
		}),
	]);
	const onStorage = (e: StorageEvent) => {
		if (e.key === ALERT_VISIBILITY_STORAGE_KEY) setCurrent(parseAlertVisibility(e.newValue));
		// 他の窓の Show All / Hide All(値の知らせの後に届く)
		else if (e.key === ALERT_VISIBILITY_RESET_STORAGE_KEY && e.newValue !== null) setCurrent(current, true);
	};
	if (typeof window !== 'undefined') {
		window.addEventListener('storage', onStorage);
		keep(() => window.removeEventListener('storage', onStorage));
	}
	void announceAlertVisibility(current);
	return () => {
		disposed = true;
		for (const off of offs.splice(0)) off();
	};
}
