// Cloudflare Worker for collaborative UMLetino.
// - static app files are served by Workers Static Assets (dist/, see wrangler.toml)
// - /collab?room=<name> is routed to one Durable Object per room, which relays messages over hibernatable websockets
// - room state is kept in memory and persisted to the Durable Object's SQLite storage in batches
//   (an alarm FLUSH_MS after the first unsaved change), so live drags don't cost one storage write per mouse move
import { DurableObject } from 'cloudflare:workers';
import { RoomState, toBase64, fromBase64 } from './room.js';

const FLUSH_MS = 1000;
const MAX_ROOM_NAME = 64;

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === '/collab') {
			if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
			const room = (url.searchParams.get('room') || 'default').slice(0, MAX_ROOM_NAME);
			return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
		}
		return env.ASSETS.fetch(request);
	},
};

export class Room extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.state = new RoomState();
		// runs again after hibernation, so the room is restored from storage before any message is handled
		ctx.blockConcurrencyWhile(async () => {
			const stored = await ctx.storage.list({ prefix: 'e:' });
			for (const record of stored.values()) this.state.elements.set(record.id, record);
			const y = await ctx.storage.get('y');
			if (y) this.state.y = fromBase64(y);
		});
	}

	async fetch() {
		const [client, server] = Object.values(new WebSocketPair());
		const id = crypto.randomUUID().slice(0, 8);
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ id });
		server.send(JSON.stringify({ t: 'hello', id, ...this.state.hello() }));
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws, raw) {
		let msg;
		try { msg = JSON.parse(raw); } catch { return; }
		const out = this.state.handle(msg);
		if (!out) return;
		if (msg.t !== 'presence') await this.scheduleFlush();
		this.broadcast(JSON.stringify({ ...out, from: ws.deserializeAttachment().id }), ws);
	}

	async webSocketClose(ws) {
		this.broadcast(JSON.stringify({ t: 'leave', from: ws.deserializeAttachment().id }), ws);
		if (this.ctx.getWebSockets().length <= 1) await this.flush(); // last one out saves immediately
	}

	async webSocketError(ws) {
		await this.webSocketClose(ws);
	}

	async alarm() {
		await this.flush();
	}

	broadcast(data, except) {
		for (const ws of this.ctx.getWebSockets()) {
			if (ws === except) continue;
			try { ws.send(data); } catch { /* closing */ }
		}
	}

	async scheduleFlush() {
		if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + FLUSH_MS);
	}

	async flush() {
		const { elements, y } = this.state.takeDirty();
		const entries = {};
		for (const e of elements) entries['e:' + e.id] = e;
		if (y) entries.y = toBase64(y);
		const keys = Object.keys(entries);
		for (let i = 0; i < keys.length; i += 128) { // put() takes at most 128 keys
			const batch = {};
			for (const k of keys.slice(i, i + 128)) batch[k] = entries[k];
			await this.ctx.storage.put(batch);
		}
	}
}
