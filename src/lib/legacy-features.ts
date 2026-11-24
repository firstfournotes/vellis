/**
 * 今の AI 連携を出すかの判定(requirements.md #84 契約3)。
 *
 * 正本は Rust のレジストリ(`features::is_enabled`)。フロントは `get_build_info` の
 * `flags` を `featureFlags`(`$lib/flags.svelte`)で受け、その `isEnabled` をここに渡して
 * 1 回だけ判定を作る(`+page.svelte` の `$derived`)。メニューのイベント・マークの付け直し・
 * `show_marks`・Viewer の props・マーク一覧と差分表示と指示のダイアログの描画は、すべて
 * この判定を見る。
 *
 * フラグが届く前(`featureFlags.ready` が偽)は `isEnabled` が偽を返すので、閉じた側になる
 * ((r) 決定)。配布版(release チャンネル・dev-features なしのビルド)では偽。
 * 今の編集のフラグは要件#74 契約21 の撤去で外した(編集は通常の機能)。
 */

/** 今の AI 連携(機能一覧 #48〜#51)。Rust の `features::AI_MARKS` と同じ綴り。 */
export const AI_MARKS_FLAG = 'ai_marks';

/** ページが閉じる入口の判定。 */
export interface LegacyUi {
	/** Add Instruction・Marks・マーク一覧・差分表示・マークの付け直し・`--marks`(契約5)。 */
	ai: boolean;
}

/** `isEnabled` に `ai_marks` だけを聞き、その真偽をそのまま返す。 */
export function legacyUi(isEnabled: (name: string) => boolean): LegacyUi {
	return {
		ai: isEnabled(AI_MARKS_FLAG),
	};
}
