// Projects: a named list of diagrams. Each diagram is one collaborative room named "<projectId>/<diagramId>".
// Shared by the Node relay (server.js) and the Cloudflare Durable Objects (worker.js).
//
// Project changes are rare and small, so the server is authoritative: clients send operations, the server
// applies them in order and broadcasts the whole project to everyone in it.

const MAX_NAME = 80;

export function newId() {
	return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

export function cleanName(name, fallback) {
	const n = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '';
	return n || fallback;
}

export function roomName(projectId, diagramId) {
	return projectId + '/' + diagramId;
}

export function isValidId(id) {
	return typeof id === 'string' && /^[a-z0-9]{4,32}$/i.test(id);
}

export class ProjectState {
	constructor(meta) {
		this.meta = meta; // {id, name, createdAt, updatedAt, deleted, diagrams: [{id, name, createdAt, deleted}]}
	}

	static create(id, name) {
		const now = Date.now();
		return new ProjectState({ id, name: cleanName(name, 'Untitled project'), createdAt: now, updatedAt: now, deleted: false, diagrams: [{ id: newId(), name: 'Diagram 1', createdAt: now, deleted: false }] });
	}

	/* what clients see: deleted diagrams keep their data (their rooms are untouched) and are listed in trash for restoring */
	view() {
		const m = this.meta;
		return {
			id: m.id, name: m.name, createdAt: m.createdAt, updatedAt: m.updatedAt,
			diagrams: m.diagrams.filter((d) => !d.deleted).map(({ id, name, createdAt }) => ({ id, name, createdAt })),
			trash: m.diagrams.filter((d) => d.deleted).map(({ id, name, deletedAt }) => ({ id, name, deletedAt })).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0)),
		};
	}

	summary() {
		const v = this.view();
		return { id: v.id, name: v.name, createdAt: v.createdAt, updatedAt: v.updatedAt, diagrams: v.diagrams.length, deleted: !!this.meta.deleted, deletedAt: this.meta.deletedAt || null };
	}

	visible() {
		return this.meta.diagrams.filter((d) => !d.deleted);
	}

	/**
	 * Applies a client operation. Returns {changed, reply} where reply is sent back to the sender only
	 * (e.g. the id of a new diagram so it can switch to it), or an error.
	 */
	handle(msg) {
		const diagrams = this.meta.diagrams;
		const find = (id) => diagrams.find((d) => d.id === id && !d.deleted);
		switch (msg.t) {
			case 'add': {
				const n = this.visible().length + 1;
				const d = { id: newId(), name: cleanName(msg.name, 'Diagram ' + n), createdAt: Date.now(), deleted: false };
				diagrams.push(d);
				return this.touched({ t: 'added', id: d.id, requestId: msg.requestId });
			}
			case 'rename': {
				const d = find(msg.id);
				if (!d) return { changed: false, reply: { t: 'error', message: 'Diagram not found' } };
				d.name = cleanName(msg.name, d.name);
				return this.touched();
			}
			case 'remove': {
				const d = find(msg.id);
				if (!d) return { changed: false };
				if (this.visible().length <= 1) return { changed: false, reply: { t: 'error', message: "A project needs at least one diagram" } };
				d.deleted = true;
				d.deletedAt = Date.now();
				return this.touched();
			}
			case 'restore': {
				// restored diagrams come back at the end of the tab list
				const d = diagrams.find((x) => x.id === msg.id && x.deleted);
				if (!d) return { changed: false };
				const others = this.visible();
				d.deleted = false;
				delete d.deletedAt;
				this.meta.diagrams = others.concat([d], diagrams.filter((x) => x.deleted && x !== d));
				return this.touched({ t: 'restored', id: d.id });
			}
			case 'move': {
				// index: new position among the visible diagrams
				const d = find(msg.id);
				if (!d || typeof msg.index !== 'number') return { changed: false };
				const order = this.visible().filter((x) => x !== d);
				order.splice(Math.max(0, Math.min(order.length, Math.floor(msg.index))), 0, d);
				this.meta.diagrams = order.concat(diagrams.filter((x) => x.deleted));
				return this.touched();
			}
			case 'renameProject':
				this.meta.name = cleanName(msg.name, this.meta.name);
				return this.touched();
			default:
				return { changed: false };
		}
	}

	touched(reply) {
		this.meta.updatedAt = Date.now();
		return { changed: true, reply };
	}
}

/* index of all projects for the landing page */
export class DirectoryState {
	constructor(entries = []) {
		this.projects = new Map(entries.map((p) => [p.id, p]));
	}

	upsert(summary) {
		const old = this.projects.get(summary.id);
		this.projects.set(summary.id, { ...old, ...summary, updatedAt: Math.max(summary.updatedAt || 0, old?.updatedAt || 0) });
		return this.projects.get(summary.id);
	}

	touch(id, time = Date.now()) {
		const p = this.projects.get(id);
		if (!p) return null;
		p.updatedAt = Math.max(p.updatedAt || 0, time);
		return p;
	}

	list() {
		return Array.from(this.projects.values()).filter((p) => !p.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
	}

	listDeleted() {
		return Array.from(this.projects.values()).filter((p) => p.deleted).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
	}
}
