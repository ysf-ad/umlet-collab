// When projects expire. Shared by the Worker (worker.js) and the tests.
//
// - A project nobody has opened for INACTIVE_DAYS is deleted: it moves to "recently deleted", where its link still shows
//   a Restore button.
// - A deleted project (deleted by hand or by this rule) is erased for good DELETED_DAYS after it was deleted.
// "Opened" means someone had it open (its tab sends a heartbeat) or edited a diagram in it. Projects that existed before
// this rule have no last-opened time yet; their clock starts at the first sweep, so nothing is erased the day this ships.
//
// The windows can be shortened for testing with INACTIVE_MS and DELETED_MS in .dev.vars; they are not set in production.
export const INACTIVE_DAYS = 60;
export const DELETED_DAYS = 30;
const DAY_MS = 24 * 3600 * 1000;

export function retention(env = {}) {
	const ms = (value, days) => (Number(value) > 0 ? Number(value) : days * DAY_MS);
	return { inactiveMs: ms(env.INACTIVE_MS, INACTIVE_DAYS), deletedMs: ms(env.DELETED_MS, DELETED_DAYS) };
}

/**
 * What the sweep does with a project: 'keep', 'start' (give a project without a last-opened time one), 'delete'
 * (inactive: move to recently deleted) or 'purge' (deleted long enough: erase).
 */
export function sweepDecision(meta, now, { inactiveMs, deletedMs }) {
	if (meta.deleted) return meta.deletedAt && now - meta.deletedAt >= deletedMs ? 'purge' : 'keep';
	if (!meta.lastVisitedAt) return 'start';
	return now - meta.lastVisitedAt >= inactiveMs ? 'delete' : 'keep';
}

/* records that the project was just opened or edited, at most once per refresh interval; true if the stored value changed */
export function touchVisited(meta, now, { inactiveMs }) {
	const refreshMs = Math.min(3600 * 1000, inactiveMs / 4);
	if (meta.lastVisitedAt && now - meta.lastVisitedAt < refreshMs) return false;
	meta.lastVisitedAt = now;
	return true;
}

/* when a deleted project will be erased (a time in ms), or null if it is not deleted */
export function erasedAt(meta, { deletedMs }) {
	return meta.deleted && meta.deletedAt ? meta.deletedAt + deletedMs : null;
}
