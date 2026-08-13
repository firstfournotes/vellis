/**
 * jsdom tests for `MermaidMounter` (`docs/mermaid.md` §9.2).
 *
 * The actual `mermaid` package is mocked via `vi.mock`. Tests assert the
 * mounter's contract: lazy import, no-op on already-rendered nodes, error
 * UI on render failure, and that documents without placeholders never
 * cause the module factory to run (acceptance criterion §9.4 #3).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const renderMock = vi.fn(async (id: string, source: string) => ({
	svg: `<svg data-test-id="${id}" data-test-source="${source}"><g></g></svg>`,
	bindFunctions: vi.fn(),
}));
const initializeMock = vi.fn();

const mermaidFactory = vi.fn(() => ({
	default: { initialize: initializeMock, render: renderMock },
}));

vi.mock('mermaid', () => mermaidFactory());

let mounterModule: typeof import('./mermaid-mounter');

beforeEach(async () => {
	vi.resetModules();
	mermaidFactory.mockClear();
	renderMock.mockClear();
	initializeMock.mockClear();
	mounterModule = await import('./mermaid-mounter');
	mounterModule.__resetMermaidMounterForTests();
	document.body.innerHTML = '';
});

afterEach(() => {
	document.body.innerHTML = '';
});

function placeholder(source: string, attrs: Record<string, string> = {}): HTMLElement {
	const div = document.createElement('div');
	div.className = 'vellis-mermaid';
	div.dataset.mermaidSource = source;
	for (const [k, v] of Object.entries(attrs)) {
		div.dataset[k] = v;
	}
	const fb = document.createElement('pre');
	fb.className = 'vellis-mermaid-fallback';
	fb.textContent = source;
	div.appendChild(fb);
	return div;
}

describe('mountMermaid — happy path', () => {
	test('replaces a placeholder with SVG and tags it as rendered', async () => {
		document.body.appendChild(placeholder('graph TD\n  A-->B'));
		await mounterModule.mountMermaid(document.body);
		expect(renderMock).toHaveBeenCalledTimes(1);
		const div = document.body.querySelector('.vellis-mermaid')!;
		expect(div.classList.contains('vellis-mermaid-rendered')).toBe(true);
		expect(div.querySelector('svg')).not.toBeNull();
	});

	test('initialises mermaid with strict security on first import', async () => {
		document.body.appendChild(placeholder('graph TD'));
		await mounterModule.mountMermaid(document.body);
		expect(initializeMock).toHaveBeenCalledTimes(1);
		const arg = initializeMock.mock.calls[0]![0];
		expect(arg).toMatchObject({
			startOnLoad: false,
			securityLevel: 'strict',
		});
	});
});

describe('mountMermaid — idempotence', () => {
	test('already-rendered placeholders are skipped on subsequent calls', async () => {
		document.body.appendChild(placeholder('graph TD'));
		await mounterModule.mountMermaid(document.body);
		expect(renderMock).toHaveBeenCalledTimes(1);
		await mounterModule.mountMermaid(document.body);
		// Second call must not re-render — the rendered class blocks the selector.
		expect(renderMock).toHaveBeenCalledTimes(1);
	});

	test('a second placeholder added later is rendered without touching the first', async () => {
		document.body.appendChild(placeholder('graph A'));
		await mounterModule.mountMermaid(document.body);
		expect(renderMock).toHaveBeenCalledTimes(1);

		document.body.appendChild(placeholder('graph B'));
		await mounterModule.mountMermaid(document.body);
		expect(renderMock).toHaveBeenCalledTimes(2);
		// And mermaid was initialised once total (cached promise).
		expect(initializeMock).toHaveBeenCalledTimes(1);
	});
});

describe('mountMermaid — lazy import (acceptance §9.4 #3)', () => {
	test('documents without placeholders never trigger the mermaid import', async () => {
		document.body.innerHTML = '<p>hello</p><pre><code>plain</code></pre>';
		await mounterModule.mountMermaid(document.body);
		// The module-factory mock counts `import('mermaid')` evaluations.
		expect(mermaidFactory).not.toHaveBeenCalled();
		expect(renderMock).not.toHaveBeenCalled();
	});

	test('the mermaid module is initialised only once across multiple mount calls', async () => {
		document.body.appendChild(placeholder('graph A'));
		await mounterModule.mountMermaid(document.body);

		// Add a second document worth of placeholders.
		document.body.appendChild(placeholder('graph B'));
		await mounterModule.mountMermaid(document.body);

		// `initialize` is invoked exactly once on first import; the second
		// mount reuses the cached module promise (`docs/mermaid.md` §6.3).
		expect(initializeMock).toHaveBeenCalledTimes(1);
		expect(renderMock).toHaveBeenCalledTimes(2);
	});
});

describe('mountMermaid — error handling', () => {
	test('mermaid.render throwing yields an error-UI placeholder, no DOM-level exception', async () => {
		renderMock.mockRejectedValueOnce(new Error('parse error: unknown shape'));
		document.body.appendChild(placeholder('garbage syntax !@#'));

		await mounterModule.mountMermaid(document.body);

		const div = document.body.querySelector('.vellis-mermaid')!;
		expect(div.classList.contains('vellis-mermaid-rendered')).toBe(true);
		expect(div.classList.contains('vellis-mermaid-error')).toBe(true);
		expect(div.querySelector('summary')!.textContent).toContain(
			'レンダーに失敗しました',
		);
		expect(div.querySelector('.vellis-mermaid-error-message')!.textContent).toContain(
			'parse error',
		);
		// Source remains visible inside the details.
		expect(div.querySelector('.vellis-mermaid-fallback')!.textContent).toBe(
			'garbage syntax !@#',
		);
	});

	test('empty mermaid block produces an error-UI placeholder without calling render', async () => {
		document.body.appendChild(placeholder(''));

		await mounterModule.mountMermaid(document.body);

		expect(renderMock).not.toHaveBeenCalled();
		const div = document.body.querySelector('.vellis-mermaid')!;
		expect(div.classList.contains('vellis-mermaid-error')).toBe(true);
		expect(div.querySelector('.vellis-mermaid-error-message')!.textContent).toContain(
			'空',
		);
	});
});
