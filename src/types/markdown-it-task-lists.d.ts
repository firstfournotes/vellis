// Ambient module declaration for `markdown-it-task-lists`.
// No DefinitelyTyped package exists on npm; this stub is enough for the
// default-export plugin signature that markdown-it expects.
declare module 'markdown-it-task-lists' {
	import type { PluginWithOptions } from 'markdown-it';

	interface TaskListsOptions {
		enabled?: boolean;
		label?: boolean;
		labelAfter?: boolean;
	}

	const taskLists: PluginWithOptions<TaskListsOptions>;
	export default taskLists;
}
