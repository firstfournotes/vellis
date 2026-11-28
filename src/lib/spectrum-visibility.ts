/**
 * View ▸ Show Audio Spectrum: the app-wide "show the spectrum band" setting (requirements.md #91 contract 11).
 *
 * One value for the whole app in localStorage (`vellis.spectrum-shown`), like Toggle Full Width / Show Formatting
 * Toolbar / Alerts; other windows follow through the `storage` event. The menu item lives in `menu.rs`: a click is
 * sent to the focused window (`menu_show_spectrum`), which toggles the value here. Every change and every focus is
 * reported to Rust (`spectrum_state { label, shown, available }`): the check follows `shown`, and the item is grey
 * unless the front window shows a video or audio document (`available`, reported by the viewers).
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from './events';

export const SPECTRUM_SHOWN_STORAGE_KEY = 'vellis.spectrum-shown';
/** Rust → the focused window (no payload): toggle. Same spelling as `MENU_SHOW_SPECTRUM_EVENT` in menu.rs. */
export const MENU_SHOW_SPECTRUM_EVENT = 'menu_show_spectrum';
/** Window → Rust `{ label, shown, available }`. Same spelling as `SPECTRUM_STATE_EVENT` in menu.rs. */
export const SPECTRUM_STATE_EVENT = 'spectrum_state';

export function serializeSpectrumShown(shown: boolean): string {
	return shown ? '1' : '0';
}

/** '0' / 'false' hide; anything else (nothing saved, garbage) shows: the default is shown. */
export function parseSpectrumShown(raw: string | null): boolean {
	return !(raw === '0' || raw === 'false');
}

let shown = true;
/** Viewers mounted in this window that can show the spectrum (a count, so a swap of viewers never ends at zero). */
let availableViewers = 0;
const subscribers = new Set<(shown: boolean) => void>();

function setShown(next: boolean): void {
	shown = next;
	for (const fn of [...subscribers]) fn(shown);
}

export function currentSpectrumShown(): boolean {
	return shown;
}

/** Reads localStorage into the current value (no write back). */
export function loadSpectrumShown(): boolean {
	let raw: string | null = null;
	try {
		raw = localStorage.getItem(SPECTRUM_SHOWN_STORAGE_KEY);
	} catch {
		raw = null;
	}
	const next = parseSpectrumShown(raw);
	if (next !== shown) setShown(next);
	return shown;
}

/** The current value, localStorage, the subscribers and the report to Rust. */
export function applySpectrumShown(next: boolean): void {
	setShown(next);
	try {
		localStorage.setItem(SPECTRUM_SHOWN_STORAGE_KEY, serializeSpectrumShown(next));
	} catch {
		// Not saved; this window still follows it.
	}
	void announceSpectrumState();
}

export function toggleSpectrumShown(): void {
	applySpectrumShown(!shown);
}

export function subscribeSpectrumShown(fn: (shown: boolean) => void): () => void {
	subscribers.add(fn);
	return () => {
		subscribers.delete(fn);
	};
}

/** Does this window show a video / audio document (false at start). */
export function currentSpectrumAvailable(): boolean {
	return availableViewers > 0;
}

/** The viewers call it on mount (true) and on destroy (false); reported to Rust. */
export function setSpectrumAvailable(available: boolean): void {
	availableViewers = available ? availableViewers + 1 : Math.max(0, availableViewers - 1);
	void announceSpectrumState();
}

/** Reports `{ label, shown, available }` to Rust; nothing outside Tauri. */
export async function announceSpectrumState(): Promise<void> {
	try {
		const win = getCurrentWindow();
		await win.emit(SPECTRUM_STATE_EVENT, { label: win.label, shown, available: currentSpectrumAvailable() });
	} catch {
		// Outside Tauri (jsdom in tests).
	}
}

/**
 * The menu event (toggle), the other windows' choice (`storage`) and the focus (report again, so Rust greys the item
 * by the front window). One report right after registering. The return undoes everything.
 */
export async function registerSpectrumVisibilityListeners(): Promise<() => void> {
	const offs: Array<() => void> = [];
	let disposed = false;
	const keep = (off: () => void) => {
		if (disposed) off();
		else offs.push(off);
	};
	try {
		keep(await listen(MENU_SHOW_SPECTRUM_EVENT, () => toggleSpectrumShown()));
	} catch {
		// Outside Tauri: no menu.
	}
	try {
		keep(
			await getCurrentWindow().onFocusChanged((event) => {
				if (event.payload) void announceSpectrumState();
			}),
		);
	} catch {
		// Outside Tauri: no focus events.
	}
	const onStorage = (event: StorageEvent) => {
		if (event.key !== SPECTRUM_SHOWN_STORAGE_KEY) return;
		setShown(parseSpectrumShown(event.newValue));
	};
	if (typeof window !== 'undefined') {
		window.addEventListener('storage', onStorage);
		keep(() => window.removeEventListener('storage', onStorage));
	}
	void announceSpectrumState();
	return () => {
		disposed = true;
		for (const off of offs.splice(0)) off();
	};
}
