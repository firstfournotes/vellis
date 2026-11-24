/**
 * Keeps a dropped file from replacing the window's content (requirements.md #74 第3段 3-5).
 *
 * Tauri's drag-drop handler is turned off (src-tauri/src/lib.rs and the window builders) so that
 * drags reach WKWebView and the editing surfaces. Without it, WKWebView opens a file dropped
 * onto the page unless the page cancels the drop, and nothing else on the page does that for a
 * file: ProseMirror's handleDrop only takes text, and outside the surfaces there is no listener.
 *
 * The guard cancels `dragover` and `drop` while the drag carries files (`dataTransfer.types`
 * includes 'Files'), anywhere on the page. It listens in the capture phase so that it runs before
 * CodeMirror, which would otherwise read the file and insert its content; CodeMirror skips its own
 * handlers for an event whose default is already prevented. Drags that carry no file (text, HTML,
 * moving words inside a surface) are left alone.
 */

const GUARDED_EVENTS = ['dragover', 'drop'] as const;

/** The drag carries files. Reads `event.dataTransfer` rather than relying on `DragEvent`. */
function carriesFiles(event: Event): boolean {
	const types = (event as DragEvent).dataTransfer?.types;
	return types ? Array.from(types).includes('Files') : false;
}

/** Installs the guard on `target` and returns the function that removes it. */
export function installFileDropGuard(target: Window): () => void {
	const cancelFileDrag = (event: Event) => {
		if (carriesFiles(event)) event.preventDefault();
	};
	for (const type of GUARDED_EVENTS) target.addEventListener(type, cancelFileDrag, true);
	return () => {
		for (const type of GUARDED_EVENTS) target.removeEventListener(type, cancelFileDrag, true);
	};
}
