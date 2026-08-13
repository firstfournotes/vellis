import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
	resolve: {
		alias: {
			$lib: path.resolve(__dirname, 'src/lib'),
		},
	},
	test: {
		environment: 'jsdom',
		globals: false,
		include: ['src/**/*.{test,spec}.ts'],
		// Node 25(.nvmrc / CI の NODE_VERSION が指す版)は Web Storage を組み込みで
		// 持ち、`globalThis.localStorage` を自前で定義する。vitest の jsdom 環境は
		// 「既に global にある名前」を上書きしない(getWindowKeys の
		// `if (k in global) return keysArray.includes(k)` — localStorage は vitest の
		// 既知キー一覧に無い)ため、jsdom の Storage が注入されず、テストからは
		// Node 側の非機能スタブが見える(`--localstorage-file` 未指定のため
		// setItem / getItem / clear すら生えていない)。組み込み Web Storage を切って
		// jsdom の localStorage を使わせる。
		//
		// 置き場所に注意: vitest 4 の execArgv は test 直下(poolOptions.forks の下では
		// 読まれない)。ワーカー(既定 pool = forks)の node 起動引数として渡る。
		execArgv: ['--no-experimental-webstorage'],
	},
});
