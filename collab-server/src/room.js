// Room state shared by the Node relay (server.js) and the Cloudflare Durable Object (worker.js).
//
// Two kinds of state per room:
// - elements: geometry/type records, merged per element with last-writer-wins (higher version, ties: lower nonce)
// - y: a Yjs document (as one merged update) holding the text of every element, so concurrent typing merges
import * as Y from 'yjs';

export function wins(op, cur) {
	return !cur || op.version > cur.version || (op.version === cur.version && op.nonce < cur.nonce);
}

export function toBase64(bytes) {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

export function fromBase64(b64) {
	const s = atob(b64);
	const bytes = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
	return bytes;
}

export class RoomState {
	constructor() {
		this.elements = new Map();
		this.y = null; // Uint8Array (merged Yjs update) or null
		this.dirtyElements = new Set();
		this.yDirty = false;
	}

	/* state sent to a client when it joins */
	hello() {
		return { elements: Array.from(this.elements.values()), y: this.y ? toBase64(this.y) : null };
	}

	/* returns the ops that won and must be relayed to the other clients */
	applyOps(ops) {
		if (!Array.isArray(ops)) return [];
		const accepted = ops.filter((op) => op && typeof op.id === 'string' && typeof op.version === 'number' && wins(op, this.elements.get(op.id)));
		for (const op of accepted) {
			this.elements.set(op.id, op);
			this.dirtyElements.add(op.id);
		}
		return accepted;
	}

	/* merges a base64 Yjs update; returns false if it is invalid */
	applyY(b64) {
		try {
			const update = fromBase64(b64);
			this.y = this.y ? Y.mergeUpdates([this.y, update]) : update;
			this.yDirty = true;
			return true;
		} catch (e) {
			return false;
		}
	}

	/* handles a client message; returns the message to relay to the others (or null) */
	handle(msg) {
		if (msg.t === 'ops') {
			const ops = this.applyOps(msg.ops);
			return ops.length ? { ...msg, ops } : null;
		}
		if (msg.t === 'y') return typeof msg.u === 'string' && this.applyY(msg.u) ? msg : null;
		if (msg.t === 'presence') return msg; // ephemeral: cursor + selection
		return null;
	}

	/* persistence helpers (used by the Durable Object) */
	takeDirty() {
		const elements = Array.from(this.dirtyElements, (id) => this.elements.get(id));
		const y = this.yDirty ? this.y : null;
		this.dirtyElements.clear();
		this.yDirty = false;
		return { elements, y };
	}
}
