import { defineConfig, type Plugin } from 'vitest/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * テストファイル内の `import.meta.url` を、そのファイルの実体を指す URL 文字列に
 * 置き換える(テストファイルのみ・`enforce: 'pre'`)。
 *
 * Vite は `new URL(\`./dir/${name}\`, import.meta.url)` という形を見つけると
 * 「バンドル後のアセット URL」への参照に書き換える(glob + `?url` インポート)。
 * ブラウザ向けには正しいが、その値は base 起点の `/src/lib/…` なので、
 * テストが同じ形で **ディスク上の** フィクスチャを読むとき
 * (`readFileSync(fileURLToPath(...))` = model-parse.acceptance.test.ts)
 * `file:///src/lib/__fixtures__/…` になって ENOENT で落ちる。
 *
 * 置き換えを先に済ませればこの書き換えの条件に当たらず、テストは Node の
 * 素の解決(= 実行環境そのもの)を得る。対象はテストファイルに限るので、
 * アプリのソースの挙動は変わらない(ビルドは vite.config.js が担当)。
 */
function nodeImportMetaUrlInTests(): Plugin {
	return {
		name: 'vellis:node-import-meta-url-in-tests',
		enforce: 'pre',
		transform(code, id) {
			const file = id.split('?')[0];
			if (!/\.(test|spec)\.ts$/.test(file) || !code.includes('import.meta.url')) return null;
			return {
				code: code.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(file).href)),
				map: null,
			};
		},
	};
}

export default defineConfig({
	plugins: [nodeImportMetaUrlInTests()],
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
