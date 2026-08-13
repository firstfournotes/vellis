/**
 * File-type classification and the display dispatch built on it (要件#2).
 *
 * 「表示可能なテキストファイルはプレーンテキストとしてそのまま表示する」
 *
 * Classification uses only the last extension of the final `/` segment, so a
 * path, a bare base name and a `file://` URI all behave the same and dots in
 * directory names (`/home/user.name/Makefile`) are never mistaken for one.
 *
 * Unknown extensions fall back to `text`: the read layer (`open_document`)
 * already rejects non-UTF-8 payloads (`FsError::InvalidUtf8`) and files over
 * 10MB (`FileTooLarge`), so it — not this table — has the final say on whether
 * a file is displayable. The binary list below is a block list of formats that
 * are known to be pointless (or noisy) to open as text.
 */
import { render } from '../markdown/renderer';
import type { SourceIndex } from '../markdown/types';
import { buildSrcdoc } from './html-viewer';
import { toAssetUri } from './uri';

export type FileType = 'markdown' | 'html' | 'text' | 'image' | 'binary';

/** Rendered by the Markdown pipeline. Mirrors `looks_like_markdown` (Rust). */
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);

/**
 * Shown rendered in a sandboxed iframe instead of as source (要件#8).
 * Only these two: `xhtml` stays text.
 */
const HTML_EXTENSIONS = new Set(['html', 'htm']);

/**
 * Shown as a rendered image instead of source or a placeholder (要件#16).
 *
 * The eight raster formats plus `svg`: every one of them is drawable by
 * WKWebView / WebView2 / WebKitGTK alike. `tiff` / `tif` / `heic` stay in the
 * binary list on purpose — macOS draws them, other platforms do not, and this
 * table should not carry platform-dependent entries (docs/image-viewing.md §4.1).
 */
const IMAGE_EXTENSIONS = new Set([
	'png',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'avif',
	'bmp',
	'ico',
	// SVG is both an image and UTF-8 XML source: it is shown as an image by
	// default and can be toggled to its source (要件#16 ③).
	'svg',
]);

/** Never opened as text. Everything not listed here is treated as text. */
const BINARY_EXTENSIONS = new Set([
	// image formats no WebView draws portably — deliberately kept out of the
	// image list above (要件#16 / docs/image-viewing.md §4.1)
	'tiff',
	'tif',
	'heic',
	// documents / archives
	'pdf',
	'zip',
	'gz',
	'bz2',
	'xz',
	'7z',
	'rar',
	'tar',
	'doc',
	'docx',
	'xls',
	'xlsx',
	'ppt',
	'pptx',
	// executables / objects
	'exe',
	'dll',
	'so',
	'dylib',
	'bin',
	'wasm',
	'class',
	'jar',
	'pyc',
	// fonts
	'woff',
	'woff2',
	'ttf',
	'otf',
	'eot',
	// media
	'mp3',
	'mp4',
	'wav',
	'flac',
	'ogg',
	'm4a',
	'mov',
	'avi',
	'mkv',
	'webm',
	// databases / disk images
	'sqlite',
	'db',
	'dmg',
	'iso',
]);

/**
 * Lowercased last extension of the final path segment, or `''` when there is
 * none (`Makefile`) or the only dot is the leading one (`.gitignore`).
 */
function extensionOf(nameOrUri: string): string {
	const segment = nameOrUri.slice(nameOrUri.lastIndexOf('/') + 1);
	const dot = segment.lastIndexOf('.');
	if (dot <= 0) return '';
	return segment.slice(dot + 1).toLowerCase();
}

/** Classify a base name, path or URI for display purposes. */
export function detectFileType(nameOrUri: string): FileType {
	const ext = extensionOf(nameOrUri);
	if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
	if (HTML_EXTENSIONS.has(ext)) return 'html';
	if (IMAGE_EXTENSIONS.has(ext)) return 'image';
	if (BINARY_EXTENSIONS.has(ext)) return 'binary';
	return 'text';
}

const ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
};

function escapeHtml(source: string): string {
	return source.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * Verbatim plain-text body: one escaped `<pre>` block, no Markdown parsing.
 * The newline right after `<pre>` is dropped by the HTML parser, so a source
 * that itself starts with a newline still round-trips through `textContent`.
 */
function renderPlainText(content: string): string {
	return `<pre class="vellis-plaintext">\n${escapeHtml(content)}</pre>`;
}

/** Shown instead of the body for files that are not displayable as text. */
const BINARY_PLACEHOLDER =
	'<p class="vellis-unsupported">このファイルは表示できません(バイナリ形式)。</p>';

export interface DisplayResult {
	html: string;
	/** Non-null only for Markdown: plain text has no source map. */
	index: SourceIndex | null;
	/**
	 * Present only for HTML files: the body of the sandboxed preview iframe
	 * (要件#8). Its presence is what tells the page to use `HtmlViewer`.
	 */
	srcdoc?: string;
	/**
	 * Present only for image files: the `vellis-asset:` URI to put on `<img src>`
	 * (要件#16). Its presence is what tells the page to use `ImageViewer`, the
	 * same way `srcdoc` selects `HtmlViewer`.
	 */
	imageSrc?: string;
}

/**
 * Produce the viewer body for a document, dispatching on its file type:
 * Markdown goes through the unified pipeline, HTML is handed to the sandboxed
 * iframe instead of the `{@html}` path, images are handed to `<img>` as an
 * asset URI, text is shown as-is, and binary content is withheld (never
 * thrown — the caller may still hold the payload).
 */
export async function renderForDisplay(uri: string, content: string): Promise<DisplayResult> {
	switch (detectFileType(uri)) {
		case 'markdown':
			return await render(content, uri);
		case 'html':
			return { html: '', index: null, srcdoc: buildSrcdoc(content, uri) };
		case 'image':
			// The body never carries the file itself: the protocol handler reads the
			// bytes when `<img>` fetches the asset URI (要件#16 ②⑦). SVG source is
			// still in `content` — `ImageViewer` shows it on the source toggle —
			// but it does not go through the `{@html}` path either.
			// `toImageSrc` is this same conversion, imported straight from `uri.ts`
			// to keep `image-viewing.ts` off this module's import cycle.
			return { html: '', index: null, imageSrc: toAssetUri(uri) };
		case 'binary':
			return { html: BINARY_PLACEHOLDER, index: null };
		default:
			return { html: renderPlainText(content), index: null };
	}
}
