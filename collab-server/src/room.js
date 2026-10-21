// Room state shared by the Node relay (server.js) and the Cloudflare Durable Object (worker.js).
//
// Two kinds of state per room:
// - elements: geometry/type records, merged per element with last-writer-wins (higher version, ties: lower nonce)
// - y: a Yjs document (as one merged update) holding the text of every element, so concurrent typing merges
import * as Y from 'yjs';
import { LIMITS } from './limits.js';

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

// Version history: the diagram as it was before editing resumed, at most once an hour (only if it changed), plus
// a version right before any change that deletes a lot at once (File Import replacing the diagram, select-all +
// delete, restoring an old version). Versions are stored as .uxf text.
export const VERSION_INTERVAL_MS = 60 * 60 * 1000;
export const MAX_VERSIONS = 60;
const LARGE_DELETE_MIN = 5;      // deleting at least this many elements in one go...
const LARGE_DELETE_SHARE = 0.5;  // ...or at least half of the diagram (when it has 2+ elements)

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class RoomState {
	constructor() {
		this.elements = new Map();
		this.y = null; // Uint8Array (merged Yjs update) or null
		this.dirtyElements = new Set();
		this.yDirty = false;
		this.lastVersion = null; // {at, uxf} of the newest saved version
	}

	/* the current diagram as a .uxf file (texts come from the Yjs document, falling back to the element records) */
	toUxf() {
		const texts = new Map();
		if (this.y) {
			const doc = new Y.Doc();
			Y.applyUpdate(doc, this.y);
			doc.getMap('texts').forEach((t, id) => texts.set(id, t.toString()));
		}
		const live = Array.from(this.elements.values()).filter((e) => !e.deleted && e.id !== '_diagram' && e.type);
		const help = texts.get('_diagram') ?? this.elements.get('_diagram')?.pa ?? '';
		const parts = ['<?xml version="1.0" encoding="UTF-8" standalone="no"?>', '<diagram program="umlet" version="15.1">', '  <zoom_level>10</zoom_level>'];
		if (help) parts.push('  <help_text>' + esc(help) + '</help_text>');
		for (const e of live) {
			parts.push('  <element>', '    <id>' + esc(e.type) + '</id>', '    <coordinates>',
				'      <x>' + (e.x | 0) + '</x>', '      <y>' + (e.y | 0) + '</y>', '      <w>' + (e.w | 0) + '</w>', '      <h>' + (e.h | 0) + '</h>',
				'    </coordinates>', '    <panel_attributes>' + esc(texts.get(e.id) ?? e.pa ?? '') + '</panel_attributes>',
				'    <additional_attributes>' + esc(e.aa ?? '') + '</additional_attributes>', '  </element>');
		}
		parts.push('</diagram>', '');
		return { uxf: parts.join('\n'), count: live.length };
	}

	liveCount() {
		let n = 0;
		for (const e of this.elements.values()) if (!e.deleted && e.id !== '_diagram') n++;
		return n;
	}

	/* does this message delete a lot of the diagram at once? */
	isLargeDelete(msg) {
		if (msg.t !== 'ops' || !Array.isArray(msg.ops)) return false;
		let n = 0;
		for (const op of msg.ops) {
			const cur = op && this.elements.get(op.id);
			if (op && op.deleted && cur && !cur.deleted && op.id !== '_diagram' && typeof op.version === 'number' && wins(op, cur)) n++;
		}
		const live = this.liveCount();
		return n >= LARGE_DELETE_MIN || (live >= 2 && n >= live * LARGE_DELETE_SHARE);
	}

	/* a version of the diagram as it is now (e.g. before restoring an old version), unless it equals the newest one */
	versionNow(reason, now = Date.now()) {
		if (!this.liveCount()) return null;
		const { uxf, count } = this.toUxf();
		if (this.lastVersion && this.lastVersion.uxf === uxf) return null;
		this.lastVersion = { at: now, uxf };
		return { at: now, reason, uxf, count };
	}

	/**
	 * Call before handling a change. Returns a version {at, reason, uxf, count} to store, or null: the diagram as it
	 * is now, if an hour has passed since the last version or the change deletes a lot, and it differs from that version.
	 */
	versionBefore(msg, now = Date.now()) {
		if (msg.t !== 'ops' && msg.t !== 'y') return null;
		const large = this.isLargeDelete(msg);
		if (!large && this.lastVersion && now - this.lastVersion.at < VERSION_INTERVAL_MS) return null;
		if (!this.liveCount()) return null; // nothing worth keeping yet
		const { uxf, count } = this.toUxf();
		if (this.lastVersion && this.lastVersion.uxf === uxf) {
			if (!large) this.lastVersion.at = now; // unchanged: wait another hour
			return null;
		}
		this.lastVersion = { at: now, uxf };
		return { at: now, reason: large ? 'before a large change' : 'hourly', uxf, count };
	}

	/* state sent to a client when it joins */
	hello() {
		return { elements: Array.from(this.elements.values()), y: this.y ? toBase64(this.y) : null };
	}

	/**
	 * Keeps a diagram within LIMITS before an 'ops' message is applied. Changes to elements the diagram already has
	 * are always accepted (so a diagram at its limit can still be edited and emptied); only new or revived elements
	 * beyond the limit are refused. Returns {msg, rejected, reason}: msg without the refused ops, their ids, and why
	 * ('elements': too many elements, 'records': too much remembered history).
	 */
	enforceLimits(msg) {
		if (msg.t !== 'ops' || !Array.isArray(msg.ops)) return { msg, rejected: [], reason: null };
		let live = this.liveCount();
		let total = this.elements.size;
		const keep = [], rejected = [];
		let reason = null;
		for (const op of msg.ops) {
			if (!op || typeof op.id !== 'string') { keep.push(op); continue; } // not valid: applyOps drops it
			const cur = this.elements.get(op.id);
			if (!cur && op.deleted) continue; // deleting something this diagram never had: nothing to keep
			const revives = !op.deleted && op.id !== '_diagram' && (!cur || cur.deleted);
			if (!cur && total >= LIMITS.maxRecordsPerDiagram) { rejected.push(op.id); reason = reason || 'records'; continue; }
			if (revives && live >= LIMITS.maxElementsPerDiagram) { rejected.push(op.id); reason = 'elements'; continue; }
			keep.push(op);
			if (!cur) total++;
			if (revives && wins(op, cur)) live++;
		}
		return { msg: { ...msg, ops: keep }, rejected, reason };
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
