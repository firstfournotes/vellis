/**
 * Annotation IPC wrappers.
 *
 * Spec: `docs/ai-collab.md` 改訂 2 §8.  These wrap the Tauri commands
 * exposed by `src-tauri/src/commands/annotation.rs`.  Camel-case keys
 * on the wire match the Rust `#[serde(rename_all = "camelCase")]`
 * applied to the input structs.  The backend ignores extra fields, so
 * passing a richer `BuiltAnchor` (with `nodeId` / `nodeType`) is safe —
 * only the persisted `Anchor` fields end up in `marks.jsonl`.
 */
import { invoke } from './ipc';

/** SHA-256 of `text` as lowercase hex.  Used for `Anchor.fileHash`. */
export async function sha256(text: string): Promise<string> {
	const buf = new TextEncoder().encode(text);
	const hash = await crypto.subtle.digest('SHA-256', buf);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export type MarkStatus =
	| 'open'
	| 'sent_to_agent'
	| 'changed_by_agent'
	| 'resolved'
	| 'stale';

export type MarkId = string;

export interface AnchorInput {
	startLine: number;
	endLine: number;
	startOffset: number;
	endOffset: number;
	selectedText: string;
	selectedMarkdown: string;
	headingPath: string[];
	contextBefore: string;
	contextAfter: string;
	fileHash: string;
}

/**
 * Mark as returned by the backend (Rust struct serialised with serde
 * defaults — fields are snake_case in the wire JSON because no
 * `rename_all` is set on the response shape).
 */
export interface Mark {
	id: MarkId;
	file: string;
	anchor: {
		start_line: number;
		end_line: number;
		start_offset: number;
		end_offset: number;
		selected_text: string;
		selected_markdown: string;
		heading_path: string[];
		context_before: string;
		context_after: string;
		file_hash: string;
	};
	instruction: string;
	status: MarkStatus;
	created_at: string;
	updated_at: string;
	schema_version: number;
}

export interface MarkFilter {
	file?: string;
	status?: MarkStatus;
}

export interface MarkPatch {
	instruction?: string;
	status?: MarkStatus;
}

export interface GenerateInboxResponse {
	path: string;
	mark_ids: MarkId[];
}

export interface RebindResponse {
	marks: Mark[];
	drifted_ids: MarkId[];
}

export type HunkKind = 'equal' | 'insert' | 'delete';

export interface Hunk {
	kind: HunkKind;
	before_lines: [number, number] | null;
	after_lines: [number, number] | null;
	text: string;
}

export interface DiffResponse {
	before: string;
	after: string;
	hunks: Hunk[];
	snapshot_id: string;
	file: string;
}

export interface Manifest {
	snapshot_id: string;
	created_at: string;
	files: string[];
	mark_ids: MarkId[];
}

export function addMark(args: {
	rootUri: string;
	uri: string;
	anchor: AnchorInput;
	instruction: string;
}): Promise<Mark> {
	return invoke<Mark>('add_mark', args as unknown as Record<string, unknown>);
}

export function listMarks(args: {
	rootUri: string;
	filter?: MarkFilter;
}): Promise<Mark[]> {
	return invoke<Mark[]>(
		'list_marks',
		args as unknown as Record<string, unknown>,
	);
}

export function updateMark(args: {
	rootUri: string;
	id: MarkId;
	patch: MarkPatch;
}): Promise<Mark> {
	return invoke<Mark>(
		'update_mark',
		args as unknown as Record<string, unknown>,
	);
}

export function removeMark(args: {
	rootUri: string;
	id: MarkId;
}): Promise<void> {
	return invoke<void>(
		'remove_mark',
		args as unknown as Record<string, unknown>,
	);
}

export function generateInbox(args: {
	rootUri: string;
	filter?: MarkFilter;
}): Promise<GenerateInboxResponse> {
	return invoke<GenerateInboxResponse>(
		'generate_inbox',
		args as unknown as Record<string, unknown>,
	);
}

export function rebindMarksForFile(args: {
	rootUri: string;
	uri: string;
	content: string;
}): Promise<RebindResponse> {
	return invoke<RebindResponse>(
		'rebind_marks_for_file',
		args as unknown as Record<string, unknown>,
	);
}

export function listSnapshots(args: {
	rootUri: string;
}): Promise<Manifest[]> {
	return invoke<Manifest[]>(
		'list_snapshots',
		args as unknown as Record<string, unknown>,
	);
}

export function diffAgainstSnapshot(args: {
	rootUri: string;
	uri: string;
	snapshotId?: string;
}): Promise<DiffResponse> {
	return invoke<DiffResponse>(
		'diff_against_snapshot',
		args as unknown as Record<string, unknown>,
	);
}

export function revertToSnapshot(args: {
	rootUri: string;
	snapshotId: string;
	files: string[];
}): Promise<void> {
	return invoke<void>(
		'revert_to_snapshot',
		args as unknown as Record<string, unknown>,
	);
}
