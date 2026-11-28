/**
 * Issue #831 — `getBuildInfo()` が 1 回失敗すると、再起動まで失敗を返し続ける(unit プロジェクト)。
 *
 * `src/lib/buildInfo.ts` は共有の `inflight` を成功の `.then` でしか片づけないので、`get_build_info` の invoke が 1 回 reject すると、
 * 拒否された promise がそのプロセスの間ずっと返り続ける(Dashboard の開発版の名前・featureFlags が得られない)。
 *
 * ## 固定する振る舞い(直った後)
 * - 1 回目の呼び出しが失敗したら、その失敗はその呼び出しにだけ返る。次の呼び出しは `get_build_info` をもう一度 invoke し、成功すれば返す
 * - 成功した後は今までどおりキャッシュ(それ以降 invoke しない)
 * - 同時の呼び出しが 1 回の invoke を共有するのは今までどおり(失敗も共有し、失敗の後の次の呼び出しがやり直す)
 *
 * ## 判断の記録(test-writer 2026-11-28)
 * - 失敗の「返し方」は固定しない(reject をそのまま投げ直す・`.finally` で片づけるなど実装の自由)。固定するのは「次の呼び出しで invoke を
 *   やり直す」ことと「invoke の回数」だけ
 * - モジュールの状態(cached / inflight)を毎ケース初期化するため `vi.resetModules()` の後に `$lib/ipc` と `./buildInfo` を一緒に import し直す
 *   (同じ registry から取る=同じ `invoke` のモックを見る)
 *
 * ## 修正前に赤になる理由
 * - 2 回目の `getBuildInfo()` が 1 回目と同じ拒否された promise を返す(invoke は 1 回のまま・成功が返らない)
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('$lib/ipc', () => ({ invoke: vi.fn() }));

const INFO = { version: '0.7.3', buildNumber: 'abc1234', buildTime: '2026-11-28 10:00 JST', buildName: '', channel: 'release', flags: {} };

/** 状態を持たない新しい `buildInfo` モジュールと、それが見る `invoke` のモック。 */
async function fresh() {
	vi.resetModules();
	const ipc = await import('$lib/ipc');
	const mod = await import('./buildInfo');
	const invokeMock = ipc.invoke as unknown as Mock;
	invokeMock.mockReset();
	return { getBuildInfo: mod.getBuildInfo, invokeMock };
}

function deferred<T>() {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('Issue #831: get_build_info の 1 回の失敗を、そのプロセスの間ずっと返し続けない', () => {
	it('1 回目が失敗しても、2 回目は invoke をやり直して成功を返す。成功の後はキャッシュ', async () => {
		const { getBuildInfo, invokeMock } = await fresh();
		invokeMock.mockRejectedValueOnce(new Error('IPC not ready')).mockResolvedValueOnce(INFO);

		await expect(getBuildInfo(), '1 回目はその失敗を返す').rejects.toThrow('IPC not ready');
		await expect(getBuildInfo(), '2 回目はやり直して成功を返す').resolves.toEqual(INFO);
		expect(invokeMock).toHaveBeenCalledTimes(2);
		expect(invokeMock.mock.calls.every(([cmd]) => cmd === 'get_build_info')).toBe(true);

		await expect(getBuildInfo(), '成功の後はキャッシュ').resolves.toEqual(INFO);
		expect(invokeMock).toHaveBeenCalledTimes(2);
	});

	it('続けて 2 回失敗しても、3 回目で成功すれば返る(失敗のたびにやり直す)', async () => {
		const { getBuildInfo, invokeMock } = await fresh();
		invokeMock.mockRejectedValueOnce('first').mockRejectedValueOnce('second').mockResolvedValueOnce(INFO);

		await expect(getBuildInfo()).rejects.toBe('first');
		await expect(getBuildInfo()).rejects.toBe('second');
		await expect(getBuildInfo()).resolves.toEqual(INFO);
		expect(invokeMock).toHaveBeenCalledTimes(3);
	});

	it('同時の呼び出しは 1 回の invoke を共有し(今までどおり)、その失敗の後の次の呼び出しはやり直す', async () => {
		const { getBuildInfo, invokeMock } = await fresh();
		const first = deferred<typeof INFO>();
		invokeMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce(INFO);

		const a = getBuildInfo();
		const b = getBuildInfo();
		expect(invokeMock, '同時の呼び出しは 1 回の invoke').toHaveBeenCalledTimes(1);
		first.reject(new Error('race at startup'));
		await expect(a).rejects.toThrow('race at startup');
		await expect(b).rejects.toThrow('race at startup');

		await expect(getBuildInfo(), '失敗の後はやり直す').resolves.toEqual(INFO);
		expect(invokeMock).toHaveBeenCalledTimes(2);
	});

	it('成功の道は変わらない: 同時の呼び出しは 1 回の invoke・その後はキャッシュ', async () => {
		const { getBuildInfo, invokeMock } = await fresh();
		invokeMock.mockResolvedValue(INFO);

		const [a, b] = await Promise.all([getBuildInfo(), getBuildInfo()]);
		expect(a).toEqual(INFO);
		expect(b).toEqual(INFO);
		await getBuildInfo();
		expect(invokeMock).toHaveBeenCalledTimes(1);
	});
});
