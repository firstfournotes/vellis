/**
 * 要件#60 の受け入れテスト(docs/requirements/req-60.md)— GoToBar の配線
 * (component プロジェクト・GoToBar.svelte を JSDOM に単体マウントする)
 *
 * 判定範囲: AC-60-16(⇧⌘G で出る入力バーの構成と文言)・AC-60-17(Enter で跳ぶ・
 * Esc で閉じる・入力変化で not-found が消える)。解決と跳躍そのものは
 * src/lib/go-to-path.acceptance.test.ts(unit 側)、メニュー(⇧⌘G の発行)は
 * src-tauri/tests/acceptance_req60.rs、+page.svelte の配線(menu_go_to の受信・
 * root 未確定時は出さない・再送でフォーカス+全選択・revealPath の呼び出し)は
 * reviewer 照合、実機の見た目は人間ゲート(acceptance/acceptance.md 要件#60)。
 *
 * ## 配線に求める契約(implementer はこれに従う=オーケストレーター指定 2026-09-20)
 * - 新規 `src/components/GoToBar.svelte`。props は
 *   `onGo(input: string)`・`onClose()`・`notFound: boolean` の3つ
 * - testid = `go-to-bar` / `go-to-input` / `go-to-go` / `go-to-close` / `go-to-message`
 * - 文言は英語(要件#51): placeholder `Path`・ボタン `Go` / `Close`・aria-label は英語
 * - `notFound` が立つと表示欄に `GO_TO_NOT_FOUND_MESSAGE`
 *   (= 'File or folder not found'・$lib/go-to-path から import)を出す(契約⑥)
 * - Enter = 打った文字列を **そのまま**(trim せず)onGo へ。IME の変換確定の
 *   Enter(isComposing)は渡さない(契約①⑦・要件#48/#49/#52/#53/#54 の規約)
 * - Esc = onClose。IME の変換中(isComposing)の Esc は IME に委ねる(契約⑦)。
 *   バーは Viewer の外(+page.svelte)に置かれるので、Esc はバー自身が受ける
 *   (document の capture 段=req-60 契約⑦。本テストは入力欄からのバブルで判定
 *   するので、input の keydown で受ける実装でも document capture でも通る)
 * - not-found 表示中に入力欄の値が変わる(input イベント)と表示が消える。
 *   次の Enter を待たない(契約⑥)
 *
 * ## スタブの設計
 * - コールバックはすべて vi.fn。Tauri・ストアはマウントに不要な設計
 *   (revealPath の deps 注入と同じく、バーは値を映して操作を上へ伝えるだけ)。
 *   FindBar(要件#54)と同じ家風で、モックは他テストと共有しない
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

import GoToBar from './GoToBar.svelte';
import { GO_TO_NOT_FOUND_MESSAGE } from '$lib/go-to-path';

/** CJK を含まない=英語の判定(要件#51 の走査と同じ考え方)。 */
const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;

function mountBar(props: { notFound?: boolean } = {}) {
	const onGo = vi.fn((_input: string) => {});
	const onClose = vi.fn(() => {});
	const utils = render(GoToBar, {
		props: { onGo, onClose, notFound: props.notFound ?? false },
	});
	return { onGo, onClose, ...utils };
}

const input = () => screen.getByTestId('go-to-input') as HTMLInputElement;
const message = () => screen.getByTestId('go-to-message');

/** keydown をバブルさせて送る(document capture 実装でも input 実装でも届く)。 */
function keyOn(el: Element, key: string, init: KeyboardEventInit = {}) {
	el.dispatchEvent(
		new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, composed: true, ...init })
	);
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// AC-60-16 — バーの構成と文言(契約①⑥)
// ---------------------------------------------------------------------------

describe('AC-60-16: 入力バーの構成 — 入力欄・Go・Close・空の表示欄・文言は英語(契約①⑥)', () => {
	it('testid が固定され、入力欄・Go・Close・表示欄が出る', () => {
		mountBar();

		expect(screen.getByTestId('go-to-bar')).toBeTruthy();
		expect(input()).toBeTruthy();
		expect(screen.getByTestId('go-to-go')).toBeTruthy();
		expect(screen.getByTestId('go-to-close')).toBeTruthy();
		expect(message()).toBeTruthy();
	});

	it('placeholder は `Path`・ボタンのラベルは `Go` / `Close`(値固定・英語=要件#51)', () => {
		mountBar();

		expect(input().placeholder).toBe('Path');
		expect(screen.getByTestId('go-to-go').textContent?.trim()).toBe('Go');
		expect(screen.getByTestId('go-to-close').textContent?.trim()).toBe('Close');
	});

	it('入力欄の aria-label は空でない英語(CJK を含まない)', () => {
		mountBar();

		const label = input().getAttribute('aria-label') ?? '';
		expect(label.length).toBeGreaterThan(0);
		expect(label).not.toMatch(CJK);
	});

	it('バー全体の文言に CJK が無い(要件#51)', () => {
		mountBar({ notFound: true });

		expect(screen.getByTestId('go-to-bar').textContent ?? '').not.toMatch(CJK);
	});

	it('notFound が立つまで表示欄は空', () => {
		mountBar();

		expect(message().textContent?.trim()).toBe('');
	});

	it('notFound を立てると表示欄に `File or folder not found`(値固定)が出る', () => {
		mountBar({ notFound: true });

		expect(message().textContent?.trim()).toBe(GO_TO_NOT_FOUND_MESSAGE);
		expect(message().textContent?.trim()).toBe('File or folder not found');
	});
});

// ---------------------------------------------------------------------------
// AC-60-17 — Enter で跳ぶ・Esc で閉じる・入力変化でメッセージが消える(契約①⑥⑦)
// ---------------------------------------------------------------------------

describe('AC-60-17: Enter / Esc / 入力変化(契約①⑥⑦)', () => {
	it('入力して Enter — 打った文字列がそのまま(trim せず)onGo へ1回渡る', async () => {
		const { onGo } = mountBar();

		await fireEvent.input(input(), { target: { value: '  docs/x.md  ' } });
		keyOn(input(), 'Enter');

		expect(onGo).toHaveBeenCalledTimes(1);
		expect(onGo).toHaveBeenCalledWith('  docs/x.md  ');
	});

	it('IME の変換確定の Enter(isComposing)では渡らない', async () => {
		const { onGo } = mountBar();

		await fireEvent.input(input(), { target: { value: 'docs' } });
		keyOn(input(), 'Enter', { isComposing: true });

		expect(onGo).not.toHaveBeenCalled();
	});

	it('Go ボタンでも onGo が1回(契約①の Go=⏎)', async () => {
		const { onGo } = mountBar();

		await fireEvent.input(input(), { target: { value: 'docs/x.md' } });
		await fireEvent.click(screen.getByTestId('go-to-go'));

		expect(onGo).toHaveBeenCalledTimes(1);
		expect(onGo).toHaveBeenCalledWith('docs/x.md');
	});

	it('Esc で onClose が1回', () => {
		const { onClose } = mountBar();

		keyOn(input(), 'Escape');

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('IME の変換中(isComposing)の Esc では閉じない(IME に委ねる=契約⑦)', () => {
		const { onClose } = mountBar();

		keyOn(input(), 'Escape', { isComposing: true });

		expect(onClose).not.toHaveBeenCalled();
	});

	it('Close ボタンでも onClose が1回', async () => {
		const { onClose } = mountBar();

		await fireEvent.click(screen.getByTestId('go-to-close'));

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('not-found 表示中に入力欄の値が変わると表示が消える(次の Enter を待たない=契約⑥)', async () => {
		mountBar({ notFound: true });
		expect(message().textContent?.trim()).toBe(GO_TO_NOT_FOUND_MESSAGE);

		await fireEvent.input(input(), { target: { value: 'docs/x' } });

		expect(message().textContent ?? '').not.toContain(GO_TO_NOT_FOUND_MESSAGE);
	});

	it('メッセージが消えてもバーと入力した文字は残る(打ち直せる=契約⑥)', async () => {
		const { onClose } = mountBar({ notFound: true });

		await fireEvent.input(input(), { target: { value: 'docs/x' } });

		expect(screen.getByTestId('go-to-bar')).toBeTruthy();
		expect(input().value).toBe('docs/x');
		expect(onClose).not.toHaveBeenCalled();
	});
});
