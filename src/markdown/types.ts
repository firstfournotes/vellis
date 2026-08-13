/**
 * Shared type definitions for the Vellis Markdown rendering pipeline.
 *
 * Defined in `docs/archives/rendering-engine.md` §3.2.  Line numbers are 1-origin
 * (mdast convention), offsets are 0-origin UTF-16 code units.
 */

export interface SourcePosition {
	startLine: number;
	startColumn: number;
	startOffset: number;
	endLine: number;
	endColumn: number;
	endOffset: number;
}

export interface NodeMeta {
	id: string;
	type: string;
	position: SourcePosition;
	parentBlockId: string | null;
	headingPath: string[];
	extra?: { lang?: string; depth?: number };
}

export interface SourceIndex {
	readonly byId: ReadonlyMap<string, NodeMeta>;
	sliceOf(nodeId: string): string;
	blockAtLine(line: number): NodeMeta | null;
}
