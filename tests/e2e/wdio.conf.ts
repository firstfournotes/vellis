import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const binary =
	process.env.VELLIS_E2E_BINARY ??
	path.join(repoRoot, 'src-tauri', 'target', 'debug', 'vellis');

export const config: WebdriverIO.Config = {
	runner: 'local',
	specs: [path.join(here, 'specs', '**', '*.e2e.ts')],
	maxInstances: 1,
	capabilities: [
		{
			// `tauri:options.application` tells the Choochmeque/tauri-
			// webdriver Intermediary Node which binary to spawn.
			// `args` is documented but ignored in v0.1.1, so initial
			// root selection is done by setting the cwd of the
			// Intermediary Node itself (see `scripts/e2e.sh`).
			'tauri:options': {
				application: binary,
			},
		} as WebdriverIO.Capabilities,
	],
	hostname: '127.0.0.1',
	port: 4444,
	path: '/',
	logLevel: 'warn',
	framework: 'mocha',
	reporters: ['spec'],
	mochaOpts: {
		ui: 'bdd',
		timeout: 60_000,
	},
	// Fixtures + the launch cwd are owned by `scripts/e2e.sh` because
	// tauri-webdriver v0.1.1 ignores `tauri:options.args` and inherits
	// the cwd of its parent for the spawned app.  Keeping setup in the
	// shell wrapper avoids a race where wdio's onPrepare runs after
	// tauri-webdriver has already started.
};
