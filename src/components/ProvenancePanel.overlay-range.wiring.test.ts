/**
 * 要件#40 追補a(2026-10-26・Issue #619)の受け入れテスト AC-40-追a (c)
 * (docs/requirements/req-40.md「追補a」。component プロジェクト・`ProvenancePanel.svelte` を
 * JSDOM にマウントする)
 *
 * 幅 0・負のオーバーレイを含む map を読ませると、警告の帯(`.warnings[role="status"]`)に
 * 契約(追補a)2 の文言が出る。既存の 2 つの警告と並ぶときは 3 番目。正しいオーバーレイだけの
 * map では帯そのものが出ない(今までどおり)。
 *
 * ## 確定契約(implementer はこれに従う)
 * - `ProvenancePanel.svelte` の `WARNING_TEXT` に `'overlay-empty-range'` の文言(英語・値固定)
 *   `Some overlays in the map end at or before their start, so they are never shown.` を足す
 * - 帯の作り(`.warnings` > `.warning` × 警告の数・`role="status"`)と既存 2 つの文言は変えない
 * - 判定は `$lib/video-provenance` の `provenanceWarnings`(純関数)で行い、パネルは描くだけ
 *   (要件#40 契約⑪の家風。純関数の判定は `video-provenance.overlay-range.acceptance.test.ts`)
 *
 * ## スタブの設計(ui-language.wiring.test.ts の AC-51-7 スモークの家風)
 * - $lib/ipc / plugin-opener: import を成立させるだけ(本テストはクリックしない)
 * - map は `load: { state: 'ok', text }` で直接渡す(取得はパネルの外=VideoViewer の持ち場)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('$lib/ipc', () => ({
	invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-opener', () => ({
	openPath: vi.fn(async () => undefined),
	revealItemInDir: vi.fn(async () => undefined),
}));

import ProvenancePanel from './ProvenancePanel.svelte';

const OVERLAY_EMPTY_RANGE_TEXT =
	'Some overlays in the map end at or before their start, so they are never shown.';
const VIDEO_NAME_MISMATCH_TEXT =
	'The map refers to a different video name than the one that is open. It may belong to another video.';
const DURATION_MISMATCH_TEXT =
	'The map duration differs from the actual video duration by more than 0.05 seconds. The map may be from before the video was rebuilt.';

const VIDEO = 'file:///Users/a/movies/final.mp4';
const OTHER_VIDEO = 'file:///Users/a/movies/other.mp4';
const MAP_DURATION = 5.5;

/** テロップのオーバーレイ(vedit-map v1 の JSON の形)。 */
function textOverlayRaw(index: number, startSec: number, endSec: number) {
	return {
		index,
		kind: 'text',
		start: { sec: startSec, frame: Math.round(startSec * 30) },
		end: { sec: endSec, frame: Math.round(endSec * 30) },
		path: null,
		scenario_path: null,
		text: `caption ${index}`,
		fps: null,
		extract: null,
		loop: false,
	};
}

/** 1 区間だけの正しい map に overlays を差し替えた JSON テキスト。 */
function mapJson(overlays: unknown[]): string {
	return JSON.stringify({
		format: 'vedit-map',
		version: 1,
		scenario: { path: '../final.vedit.json' },
		video: { path: 'final.mp4', scenario_path: 'out/final.mp4' },
		fps: { num: 30, den: 1 },
		duration: { sec: MAP_DURATION, frame: 165 },
		inputs: {
			raw: {
				path: '../media/raw.mov',
				scenario_path: 'media/raw.mov',
				fps: { num: 30, den: 1 },
				duration: { sec: 10.0, frame: 300 },
			},
		},
		segments: [
			{
				kind: 'clip',
				start: { sec: 0.0, frame: 0 },
				end: { sec: MAP_DURATION, frame: 165 },
				sources: [
					{
						input: 'raw',
						clip: 'opening',
						mode: 'extract',
						speed: 1,
						from: { sec: 2.0, frame: 60 },
						to: { sec: 7.5, frame: 225 },
					},
				],
			},
		],
		overlays,
	});
}

const VALID = textOverlayRaw(0, 1.0, 4.0);
const ZERO_WIDTH = textOverlayRaw(1, 2.0, 2.0);
const NEGATIVE = textOverlayRaw(2, 3.0, 2.0);

function mountPanel(overlays: unknown[], videoUri = VIDEO, actualDurationSec: number | null = MAP_DURATION) {
	const { container } = render(ProvenancePanel, {
		props: {
			videoUri,
			load: { state: 'ok' as const, text: mapJson(overlays) },
			position: 2.0,
			actualDurationSec,
			onSeekSegment: () => {},
			onClose: () => {},
		},
	});
	return container;
}

function warningTexts(container: HTMLElement): string[] {
	return Array.from(container.querySelectorAll('.warnings .warning')).map((el) => el.textContent?.trim() ?? '');
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe('AC-40-追a (c): the warning band shows the overlay-empty-range text (contract 2)', () => {
	it('a width-0 overlay → one warning with the fixed English text', () => {
		const container = mountPanel([VALID, ZERO_WIDTH]);
		const band = container.querySelector('.warnings');
		expect(band, '.warnings band').not.toBeNull();
		expect(band?.getAttribute('role')).toBe('status');
		expect(warningTexts(container)).toEqual([OVERLAY_EMPTY_RANGE_TEXT]);
		expect(screen.getByText(OVERLAY_EMPTY_RANGE_TEXT)).toBeTruthy();
	});

	it('a negative overlay → the same single warning', () => {
		const container = mountPanel([VALID, NEGATIVE]);
		expect(warningTexts(container)).toEqual([OVERLAY_EMPTY_RANGE_TEXT]);
	});

	it('several empty-range overlays → still one line of that text', () => {
		const container = mountPanel([ZERO_WIDTH, NEGATIVE, textOverlayRaw(3, 5.0, 5.0)]);
		expect(warningTexts(container)).toEqual([OVERLAY_EMPTY_RANGE_TEXT]);
	});

	it('with the name and duration warnings it is the third line, after the two existing texts', () => {
		const container = mountPanel([VALID, ZERO_WIDTH, NEGATIVE], OTHER_VIDEO, MAP_DURATION + 0.5);
		expect(warningTexts(container)).toEqual([
			VIDEO_NAME_MISMATCH_TEXT,
			DURATION_MISMATCH_TEXT,
			OVERLAY_EMPTY_RANGE_TEXT,
		]);
	});

	it('the panel keeps rendering the map (no degradation notice) while the band is shown', () => {
		const container = mountPanel([VALID, ZERO_WIDTH]);
		expect(screen.getByRole('heading', { name: 'Sources' })).toBeTruthy();
		expect(container.querySelector('.notice')).toBeNull();
	});
});

describe('AC-40-追a (c): valid-only and no-overlay maps show no band (unchanged)', () => {
	it('valid overlays only → no .warnings band and the text is absent', () => {
		const container = mountPanel([VALID]);
		expect(container.querySelector('.warnings')).toBeNull();
		expect(screen.queryByText(OVERLAY_EMPTY_RANGE_TEXT)).toBeNull();
	});

	it('no overlays → no .warnings band', () => {
		const container = mountPanel([]);
		expect(container.querySelector('.warnings')).toBeNull();
	});

	it('valid overlays with the name warning → only the existing text (band unchanged)', () => {
		const container = mountPanel([VALID], OTHER_VIDEO);
		expect(warningTexts(container)).toEqual([VIDEO_NAME_MISMATCH_TEXT]);
	});
});

describe('AC-40-追a (c): WARNING_TEXT in ProvenancePanel.svelte carries the fixed text (source scan)', () => {
	it("'overlay-empty-range' maps to the English sentence", () => {
		const src = readFileSync(resolve(__dirname, 'ProvenancePanel.svelte'), 'utf-8');
		expect(src).toMatch(/['"]overlay-empty-range['"]\s*:/);
		expect(src).toContain(OVERLAY_EMPTY_RANGE_TEXT);
	});
});
