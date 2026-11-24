/**
 * Dashboard の版表示に開発版の名前(要件87 契約2 の `dev-<開発名> #<n>(日時)`)を出す(由谷の指示 2026-11-22)。
 *
 * - 開発版(get_build_info の buildName が空でない)= 「Version <版>」の下にその名前が出る
 * - 公開版・dev ビルド(buildName が空)・buildName の欄が無い古い payload・get_build_info の失敗 = 名前の行は出ない
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('$lib/events', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('$lib/buildInfo', () => ({ getBuildInfo: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({
	open: vi.fn(async () => null),
	ask: vi.fn(async () => false),
}));

import { invoke } from '$lib/ipc';
import { getBuildInfo } from '$lib/buildInfo';
import Dashboard from './Dashboard.svelte';
import { windowState } from '../stores/window-state.svelte';

const invokeMock = invoke as unknown as Mock;
const getBuildInfoMock = getBuildInfo as unknown as Mock;

const DEV_NAME = 'dev-req-74 #3（2026-11-22 07:30 JST）';

function buildInfo(extra: Record<string, unknown>) {
	return { version: '0.7.0', buildNumber: '42', buildTime: '2026-11-22 07:30 JST', channel: 'preview', flags: {}, ...extra };
}

async function settle() {
	for (let i = 0; i < 4; i++) {
		await Promise.resolve();
		await tick();
		await new Promise<void>((r) => setTimeout(r, 0));
	}
}

async function mount() {
	const result = render(Dashboard, {
		props: {
			error: null,
			currentRoot: null,
			confirmDiscard: async () => true,
			onOpened: () => {},
			onClose: () => {},
			onPickFolder: () => {},
		},
	});
	await settle();
	return result;
}

const brandText = (container: HTMLElement) => container.querySelector('.brand')?.textContent ?? '';

beforeEach(() => {
	windowState.version = '0.7.0';
	invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
		switch (cmd) {
			case 'list_history':
			case 'list_bookmarks':
			case 'list_missing_paths':
				return [];
			case 'scan_recently_modified':
				return { generation: Number(args?.generation), files: [], folders: 0, truncated: false };
			default:
				return null;
		}
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe('Dashboard の版表示に開発版の名前を出す', () => {
	it('開発版: Version の下に版の名前が出る', async () => {
		getBuildInfoMock.mockResolvedValue(buildInfo({ buildName: DEV_NAME }));
		const { container } = await mount();

		const lines = [...container.querySelectorAll('.brand .version')].map((e) => e.textContent?.trim());
		expect(lines).toEqual(['Version 0.7.0', DEV_NAME]);
	});

	it('公開版(buildName が空): 名前の行は出ない', async () => {
		getBuildInfoMock.mockResolvedValue(buildInfo({ buildName: '', channel: 'release' }));
		const { container } = await mount();

		expect(container.querySelectorAll('.brand .version')).toHaveLength(1);
		expect(brandText(container)).not.toContain('dev-');
	});

	it('buildName の欄が無い payload: 名前の行は出ない', async () => {
		getBuildInfoMock.mockResolvedValue(buildInfo({}));
		const { container } = await mount();

		expect(container.querySelectorAll('.brand .version')).toHaveLength(1);
	});

	it('get_build_info が失敗しても Version は出て、名前の行は出ない', async () => {
		getBuildInfoMock.mockRejectedValue(new Error('unavailable'));
		const { container } = await mount();

		expect(brandText(container)).toContain('Version 0.7.0');
		expect(container.querySelectorAll('.brand .version')).toHaveLength(1);
	});
});
