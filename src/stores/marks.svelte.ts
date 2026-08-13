/**
 * Window-local Marks store.
 *
 * Spec: `docs/ai-collab.md` 改訂 2 §3 / §11.4.  Mirrors the
 * AnnotationStore on the backend; stays in sync via direct calls to
 * the Tauri commands and (Phase 4.2) the `marks_changed` event.
 *
 * Phase 4.1 keeps the model deliberately simple: load on demand, mutate
 * via wrappers, no event subscription yet (drift detection lands in
 * 4.2).  Each window has its own instance.
 */
import {
	addMark as ipcAddMark,
	generateInbox as ipcGenerateInbox,
	listMarks as ipcListMarks,
	rebindMarksForFile as ipcRebindMarksForFile,
	removeMark as ipcRemoveMark,
	updateMark as ipcUpdateMark,
	type AnchorInput,
	type GenerateInboxResponse,
	type Mark,
	type MarkFilter,
	type MarkId,
	type MarkPatch,
} from '../lib/annotation';

class MarksStore {
	all = $state<Mark[]>([]);
	loading = $state(false);
	lastError = $state<string | null>(null);
	/** Mark IDs that drifted in the most recent rebind.  Cleared the
	 *  next time the user interacts with the sidebar (acknowledging
	 *  the drift).  Phase 4.2 keeps this minimal — a richer toast /
	 *  per-mark badge can layer on top later. */
	recentDrift = $state<MarkId[]>([]);

	async refresh(rootUri: string, filter?: MarkFilter): Promise<void> {
		if (!rootUri) {
			this.all = [];
			return;
		}
		this.loading = true;
		this.lastError = null;
		try {
			this.all = await ipcListMarks({ rootUri, filter });
		} catch (err) {
			this.lastError = String(err);
			this.all = [];
		} finally {
			this.loading = false;
		}
	}

	async add(args: {
		rootUri: string;
		uri: string;
		anchor: AnchorInput;
		instruction: string;
	}): Promise<Mark> {
		const created = await ipcAddMark(args);
		this.all = [...this.all, created];
		return created;
	}

	async update(args: {
		rootUri: string;
		id: MarkId;
		patch: MarkPatch;
	}): Promise<Mark> {
		const updated = await ipcUpdateMark(args);
		this.all = this.all.map((m) => (m.id === args.id ? updated : m));
		return updated;
	}

	async remove(args: { rootUri: string; id: MarkId }): Promise<void> {
		await ipcRemoveMark(args);
		this.all = this.all.filter((m) => m.id !== args.id);
	}

	async generateInbox(
		rootUri: string,
		filter?: MarkFilter,
	): Promise<GenerateInboxResponse> {
		const res = await ipcGenerateInbox({ rootUri, filter });
		// Status transitions are persisted by the backend.  Refresh so the
		// UI reflects Open → SentToAgent.
		await this.refresh(rootUri);
		return res;
	}

	/**
	 * Re-anchor every mark on `uri` against `content` and merge the
	 * persisted result back into `all`.  Marks for other files are
	 * left untouched.  Newly drifted IDs are unioned into
	 * `recentDrift` so the badge stays visible even when a follow-up
	 * `file_changed` burst delivers `Unchanged` (notify can fire
	 * multiple events that all read the same post-burst content; the
	 * second/third call would otherwise reset the badge to empty).
	 */
	async rebindForFile(args: {
		rootUri: string;
		uri: string;
		content: string;
	}): Promise<void> {
		try {
			const res = await ipcRebindMarksForFile(args);
			// Replace all marks for this file with the freshly rebound
			// list; preserve marks from other files.
			const fileSet = new Set(res.marks.map((m) => m.id));
			// Order: keep original ordering by interleaving the file's
			// rebound marks at their first-seen positions.
			const merged: Mark[] = [];
			let inserted = false;
			for (const m of this.all) {
				if (fileSet.has(m.id)) {
					if (!inserted) {
						merged.push(...res.marks);
						inserted = true;
					}
				} else {
					merged.push(m);
				}
			}
			if (!inserted) merged.push(...res.marks);
			this.all = merged;

			// Cumulative drift notification: merge the latest drift IDs
			// with whatever the badge already shows.  `acknowledgeDrift`
			// (sidebar header click) clears it; `clearDocument` does
			// likewise on document switch.
			if (res.drifted_ids.length > 0) {
				const seen = new Set(this.recentDrift);
				for (const id of res.drifted_ids) seen.add(id);
				this.recentDrift = [...seen];
			}
		} catch (err) {
			// Rebind failure is non-fatal: log and keep stale view.
			this.lastError = String(err);
		}
	}

	acknowledgeDrift(): void {
		this.recentDrift = [];
	}

	clear(): void {
		this.all = [];
		this.lastError = null;
		this.recentDrift = [];
	}
}

export const marksStore = new MarksStore();
