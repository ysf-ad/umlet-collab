// Cloudflare Worker for collaborative UMLetino.
// - static files (landing page, app) are served by Workers Static Assets (dist/, see wrangler.jsonc)
// - GET/POST /api/projects, DELETE /api/projects/<id>   project directory (landing page)
// - /project?id=<projectId>   websocket to the project's Durable Object (diagram list, who views what)
// - /collab?room=<name>       websocket to one Durable Object per diagram room (element sync, see room.js)
// Everything is public: whoever has a link can edit (internal tool, no accounts).
import { DurableObject } from 'cloudflare:workers';
import { RoomState, toBase64, fromBase64 } from './room.js';
import { ProjectState, DirectoryState, newId, cleanName, isValidId } from './project.js';

const FLUSH_MS = 1000;            // room state is saved at most once per second
const TOUCH_INTERVAL_MS = 60000;  // "last edited" in the directory is updated at most once per minute per room
const MAX_ROOM_NAME = 80;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const directory = (env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'));
const project = (env, id) => env.PROJECTS.get(env.PROJECTS.idFromName(id));

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const path = url.pathname;

		if (path === '/collab' || path === '/project') {
			if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
			if (path === '/collab') {
				const room = (url.searchParams.get('room') || 'default').slice(0, MAX_ROOM_NAME);
				return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
			}
			const id = url.searchParams.get('id');
			if (!isValidId(id)) return new Response('bad project id', { status: 400 });
			return project(env, id).fetch(new Request('https://do/ws', request));
		}

		if (path === '/api/projects' && request.method === 'GET') return directory(env).fetch('https://do/list');
		if (path === '/api/projects' && request.method === 'POST') {
			const body = await request.json().catch(() => ({}));
			const id = newId();
			return project(env, id).fetch('https://do/init', { method: 'POST', body: JSON.stringify({ id, name: body.name }) });
		}
		const m = path.match(/^\/api\/projects\/([a-z0-9]+)$/i);
		if (m && request.method === 'DELETE') return project(env, m[1]).fetch('https://do/delete', { method: 'POST' });

		return env.ASSETS.fetch(request);
	},
};

/* one per diagram: relays element changes, Yjs text and presence; persists the diagram */
export class Room extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.state = new RoomState();
		this.lastTouch = 0;
		// runs again after hibernation, so the room is restored from storage before any message is handled
		ctx.blockConcurrencyWhile(async () => {
			const stored = await ctx.storage.list({ prefix: 'e:' });
			for (const record of stored.values()) this.state.elements.set(record.id, record);
			const y = await ctx.storage.get('y');
			if (y) this.state.y = fromBase64(y);
			this.name = await ctx.storage.get('name');
		});
	}

	async fetch(request) {
		if (!this.name) {
			this.name = new URL(request.url).searchParams.get('room') || '';
			await this.ctx.storage.put('name', this.name);
		}
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
		broadcast(this.ctx, JSON.stringify({ ...out, from: ws.deserializeAttachment().id }), ws);
	}

	async webSocketClose(ws) {
		broadcast(this.ctx, JSON.stringify({ t: 'leave', from: ws.deserializeAttachment().id }), ws);
		if (this.ctx.getWebSockets().length <= 1) await this.flush(); // last one out saves immediately
	}

	async webSocketError(ws) {
		await this.webSocketClose(ws);
	}

	async alarm() {
		await this.flush();
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
		// diagram rooms belong to a project: keep its "last edited" time in the directory current
		const projectId = this.name && this.name.includes('/') ? this.name.split('/')[0] : null;
		if (keys.length && projectId && Date.now() - this.lastTouch > TOUCH_INTERVAL_MS) {
			this.lastTouch = Date.now();
			await directory(this.env).fetch('https://do/touch', { method: 'POST', body: JSON.stringify({ id: projectId }) });
		}
	}
}

/* one per project: the list of diagrams, live to everyone in the project, plus who is viewing which diagram */
export class Project extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.state = null;
		ctx.blockConcurrencyWhile(async () => {
			const meta = await ctx.storage.get('meta');
			if (meta) this.state = new ProjectState(meta);
		});
	}

	async fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === '/init') {
			if (!this.state) {
				const { id, name } = await request.json();
				this.state = ProjectState.create(id, name);
				await this.save();
			}
			return json(this.state.view());
		}
		if (path === '/delete') {
			if (!this.state) return json({ error: 'not found' }, 404);
			this.state.meta.deleted = true;
			await this.save();
			broadcast(this.ctx, JSON.stringify({ t: 'deleted' }));
			return json({ ok: true });
		}
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		const you = crypto.randomUUID().slice(0, 8);
		server.serializeAttachment({ id: you, diagram: null });
		server.send(JSON.stringify({ ...this.message(), you }));
		return new Response(null, { status: 101, webSocket: client });
	}

	message(except) {
		const exists = this.state && !this.state.meta.deleted;
		return { t: 'project', project: exists ? this.state.view() : null, viewers: this.viewers(except) };
	}

	viewers(except) {
		return this.ctx.getWebSockets().filter((ws) => ws !== except).map((ws) => ws.deserializeAttachment()).filter((a) => a && a.diagram);
	}

	async webSocketMessage(ws, raw) {
		let msg;
		try { msg = JSON.parse(raw); } catch { return; }
		if (msg.t === 'viewing') {
			const a = ws.deserializeAttachment();
			ws.serializeAttachment({ id: a.id, diagram: String(msg.diagram || '').slice(0, 32), name: cleanName(msg.name, 'Someone'), color: String(msg.color || '#888').slice(0, 16) });
			broadcast(this.ctx, JSON.stringify({ t: 'viewers', viewers: this.viewers() }));
			return;
		}
		if (!this.state || this.state.meta.deleted) return;
		const { changed, reply } = this.state.handle(msg);
		if (reply) ws.send(JSON.stringify(reply));
		if (changed) {
			await this.save();
			broadcast(this.ctx, JSON.stringify(this.message()));
		}
	}

	async webSocketClose(ws) {
		broadcast(this.ctx, JSON.stringify({ t: 'viewers', viewers: this.viewers(ws) }), ws);
	}

	async webSocketError(ws) {
		await this.webSocketClose(ws);
	}

	async save() {
		await this.ctx.storage.put('meta', this.state.meta);
		await directory(this.env).fetch('https://do/upsert', { method: 'POST', body: JSON.stringify(this.state.summary()) });
	}
}

/* single instance: index of all projects for the landing page */
export class Directory extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			this.state = new DirectoryState(Array.from((await ctx.storage.list({ prefix: 'p:' })).values()));
		});
	}

	async fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === '/list') return json(this.state.list());
		const body = await request.json();
		const entry = path === '/upsert' ? this.state.upsert(body) : path === '/touch' ? this.state.touch(body.id) : null;
		if (entry) await this.ctx.storage.put('p:' + entry.id, entry);
		return json({ ok: !!entry });
	}
}

function broadcast(ctx, data, except) {
	for (const ws of ctx.getWebSockets()) {
		if (ws === except) continue;
		try { ws.send(data); } catch { /* closing */ }
	}
}
