// Cloudflare Worker for collaborative UMLetino.
// - static files (landing page, app) are served by Workers Static Assets (dist/, see wrangler.jsonc)
// - POST /api/projects (create: captcha and per-network quota), POST /api/projects/lookup (details of the projects a
//   browser already knows the ids of), DELETE /api/projects/<id>, POST /api/projects/<id>/restore, GET /api/config
// - /project?id=<projectId>   websocket to the project's Durable Object (diagram list, who views what)
// - /collab?room=<name>       websocket to one Durable Object per diagram room (element sync, version history, see room.js)
// There are no accounts: whoever has a project's link can edit it, so the project id is the secret. That is why there is
// no list of projects anywhere, rooms only exist for diagrams that a project has, and limits.js bounds what one visitor can create.
import { DurableObject } from 'cloudflare:workers';
import { RoomState, toBase64, fromBase64, MAX_VERSIONS } from './room.js';
import { ProjectState, newProjectId, cleanName, isValidId, roomName } from './project.js';
import { LIMITS, takeQuota, networkOf } from './limits.js';
import { captchaAccepted, parseHostnames } from './captcha.js';
import { retention, sweepDecision, touchVisited, erasedAt } from './expiry.js';

const FLUSH_MS = 1000;            // room state is saved at most once per second
const TOUCH_INTERVAL_MS = 60000;  // a project's "last edited" time is updated at most once per minute per room
const MAX_ROOM_NAME = 80;
const SWEEP_BATCH = 40;           // projects checked per sweep, and diagrams erased per call (a request may make 50 subrequests)
const VIEWER_TIMEOUT_MS = 120000; // project viewers re-announce every 30 s

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const directory = (env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'));
const project = (env, id) => env.PROJECTS.get(env.PROJECTS.idFromName(id));

/* a websocket that delivers one message and closes: how a refusal reaches the page (a plain HTTP error would look like a lost connection) */
function refuseSocket(message, type = 'rejected', code = 1008) {
	const [client, server] = Object.values(new WebSocketPair());
	server.accept();
	server.send(JSON.stringify({ t: type, message }));
	server.close(code, type);
	return new Response(null, { status: 101, webSocket: client });
}

async function hashNetwork(network, salt) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('umlet-quota:' + (salt || '') + ':' + network));
	return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/* true: passed, false: failed, null: could not be checked */
async function checkCaptcha(env, token, ip) {
	if (typeof token !== 'string' || !token || token.length > 2048) return false;
	try {
		const form = new FormData();
		form.append('secret', env.TURNSTILE_SECRET);
		form.append('response', token);
		if (ip) form.append('remoteip', ip);
		const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form, signal: AbortSignal.timeout(10000) });
		if (!r.ok) return null;
		return captchaAccepted(await r.json(), parseHostnames(env.TURNSTILE_HOSTNAMES));
	} catch {
		return null;
	}
}

async function createProject(request, env) {
	const body = await request.json().catch(() => ({}));
	const ip = request.headers.get('CF-Connecting-IP'); // always set by Cloudflare; absent in local development, where nothing is limited
	if (env.TURNSTILE_SECRET) { // the captcha is switched on by setting its secret
		const passed = await checkCaptcha(env, body.token, ip);
		if (passed === null) return json({ error: 'captcha_unavailable', message: 'Couldn’t check the captcha right now. Try again in a moment.' }, 503);
		if (!passed) return json({ error: 'captcha', message: 'The captcha check failed. Reload the page and try again.' }, 400);
	}
	if (ip) {
		const limit = Number(env.MAX_PROJECTS_PER_IP) || LIMITS.maxProjectsPerIp;
		const asked = await directory(env).fetch('https://do/quota', {
			method: 'POST',
			body: JSON.stringify({ key: await hashNetwork(networkOf(ip), env.QUOTA_SALT), limit, windowMs: LIMITS.quotaDays * 24 * 3600 * 1000 }),
		});
		const quota = await asked.json();
		if (!quota.ok) return json({ error: 'project_limit', limit, days: LIMITS.quotaDays, retryAt: quota.retryAt, message: 'You can create up to ' + limit + ' projects per ' + LIMITS.quotaDays + ' days from one network.' }, 429);
	}
	const id = newProjectId();
	const created = await project(env, id).fetch('https://do/init', { method: 'POST', body: JSON.stringify({ id, name: body.name }) });
	await directory(env).fetch('https://do/register', { method: 'POST', body: JSON.stringify({ id }) }); // so the expiry sweep finds it
	return created;
}

/* details of the projects whose ids the caller already has (what the landing page shows); unknown ids are skipped */
async function lookupProjects(request, env) {
	const body = await request.json().catch(() => ({}));
	const ids = (Array.isArray(body.ids) ? body.ids : []).filter(isValidId).slice(0, LIMITS.maxLookupIds);
	const found = await Promise.all(ids.map((id) => project(env, id).fetch('https://do/summary').then((r) => (r.ok ? r.json() : null)).catch(() => null)));
	return json(found.filter(Boolean));
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const path = url.pathname;

		if (path === '/collab' || path === '/project') {
			if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
			if (path === '/project') {
				const id = url.searchParams.get('id');
				if (!isValidId(id)) return refuseSocket('This project link is not valid.');
				return project(env, id).fetch(new Request('https://do/ws', request));
			}
			const room = (url.searchParams.get('room') || 'default').slice(0, MAX_ROOM_NAME);
			if (room.includes('/')) { // a project's diagram: the project must exist and have it (permanently deleted ones are gone)
				const [projectId, diagramId, ...rest] = room.split('/');
				if (rest.length || !isValidId(projectId) || !isValidId(diagramId)) return refuseSocket('This diagram link is not valid.');
				const has = await project(env, projectId).fetch('https://do/has?diagram=' + diagramId);
				if (!has.ok) return refuseSocket('This diagram doesn’t exist (anymore).');
			}
			return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
		}

		if (path === '/api/config' && request.method === 'GET') return json({ turnstileSiteKey: env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY ? env.TURNSTILE_SITE_KEY : null });
		if (path === '/api/projects' && request.method === 'POST') return createProject(request, env);
		if (path === '/api/projects/lookup' && request.method === 'POST') return lookupProjects(request, env);
		const m = path.match(/^\/api\/projects\/([a-z0-9]+)$/i);
		if (m && request.method === 'DELETE') return project(env, m[1]).fetch('https://do/delete', { method: 'POST' });
		const r = path.match(/^\/api\/projects\/([a-z0-9]+)\/restore$/i);
		if (r && request.method === 'POST') return project(env, r[1]).fetch('https://do/restore', { method: 'POST' });
		if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);

		return env.ASSETS.fetch(request);
	},

	// hourly (see wrangler.jsonc): delete projects nobody opened for 60 days, erase projects deleted 30 days ago
	async scheduled(event, env, ctx) {
		ctx.waitUntil(directory(env).fetch('https://do/sweep', { method: 'POST' }));
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
			const newest = await ctx.storage.list({ prefix: 'vu:', reverse: true, limit: 1 });
			for (const [key, uxf] of newest) this.state.lastVersion = { at: Number(key.slice(3)), uxf };
		});
	}

	async fetch(request) {
		if (new URL(request.url).pathname === '/purge') { // the diagram was permanently deleted from its project
			for (const ws of this.ctx.getWebSockets()) try { ws.close(1000, 'deleted'); } catch { /* closed */ }
			await this.ctx.storage.deleteAlarm();
			await this.ctx.storage.deleteAll();
			this.state = new RoomState();
			return json({ ok: true });
		}
		if (!this.name) {
			const requested = new URL(request.url).searchParams.get('room') || '';
			// a project's diagram was checked by the Worker. An older standalone room is only served if it already holds a diagram.
			if (!requested.includes('/') && !this.state.elements.size && !this.state.y) return refuseSocket('This diagram doesn’t exist. Create a project from the home page.');
			this.name = requested;
			await this.ctx.storage.put('name', this.name);
		}
		if (this.ctx.getWebSockets().length >= LIMITS.maxPeersPerDiagram) return refuseSocket('This diagram already has ' + LIMITS.maxPeersPerDiagram + ' people editing. Trying again shortly.', 'full', 1013);
		const [client, server] = Object.values(new WebSocketPair());
		const id = crypto.randomUUID().slice(0, 8);
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ id });
		server.send(JSON.stringify({ t: 'hello', id, ...this.state.hello() }));
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws, raw) {
		if ((typeof raw === 'string' ? raw.length : raw.byteLength) > LIMITS.maxMessageBytes) return ws.send(JSON.stringify({ t: 'error', message: 'That change was too large to send (over 1 MB).' }));
		let msg;
		try { msg = JSON.parse(raw); } catch { return; }
		if (msg.t === 'versions') return ws.send(JSON.stringify({ t: 'versions', versions: await this.listVersions() }));
		if (msg.t === 'version') {
			const uxf = await this.ctx.storage.get(versionKey('vu:', msg.at));
			return ws.send(JSON.stringify({ t: 'version', at: msg.at, uxf: uxf || null }));
		}
		if (msg.t === 'ops') { // new elements beyond the limits are refused (the sender is told which, to take them back)
			const limited = this.state.enforceLimits(msg);
			if (limited.rejected.length) ws.send(JSON.stringify({ t: 'limit', reason: limited.reason, max: LIMITS.maxElementsPerDiagram, rejected: limited.rejected }));
			msg = limited.msg;
		}
		const version = msg.t === 'checkpoint' ? this.state.versionNow('before a restore') : this.state.versionBefore(msg);
		if (version) await this.saveVersion(version);
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

	async listVersions() {
		return Array.from((await this.ctx.storage.list({ prefix: 'vm:', reverse: true })).values());
	}

	async saveVersion({ at, reason, uxf, count }) {
		await this.ctx.storage.put({ [versionKey('vm:', at)]: { at, reason, count }, [versionKey('vu:', at)]: uxf });
		const all = await this.ctx.storage.list({ prefix: 'vm:', reverse: true });
		const old = Array.from(all.keys()).slice(MAX_VERSIONS);
		if (old.length) await this.ctx.storage.delete(old.flatMap((k) => [k, 'vu:' + k.slice(3)]));
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
		// diagram rooms belong to a project: keep its "last edited" time current
		const projectId = this.name && this.name.includes('/') ? this.name.split('/')[0] : null;
		if (keys.length && projectId && Date.now() - this.lastTouch > TOUCH_INTERVAL_MS) {
			this.lastTouch = Date.now();
			await project(this.env, projectId).fetch('https://do/touch', { method: 'POST' });
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
		const url = new URL(request.url);
		const path = url.pathname;
		if (path === '/summary') return this.state && !this.state.meta.purging ? json({ ...this.state.summary(), erasesAt: erasedAt(this.state.meta, retention(this.env)) }) : json({ error: 'not found' }, 404);
		if (path === '/sweep') return this.sweep();
		if (path === '/has') return this.state && this.state.hasDiagram(url.searchParams.get('diagram') || '') ? json({ ok: true }) : json({ error: 'not found' }, 404);
		if (path === '/touch') {
			if (this.state && !this.state.meta.deleted) {
				this.state.meta.updatedAt = Date.now();
				touchVisited(this.state.meta, Date.now(), retention(this.env));
				await this.save();
			}
			return json({ ok: true });
		}
		if (path === '/init') {
			if (!this.state) {
				const { id, name } = await request.json();
				this.state = ProjectState.create(id, name);
				this.state.meta.lastVisitedAt = Date.now();
				await this.save();
			}
			return json(this.state.view());
		}
		if (path === '/delete') {
			if (!this.state) return json({ error: 'not found' }, 404);
			this.state.meta.deleted = true;
			this.state.meta.deletedAt = Date.now();
			delete this.state.meta.deletedReason;
			await this.save();
			broadcast(this.ctx, JSON.stringify({ t: 'deleted' }));
			return json({ ok: true });
		}
		if (path === '/restore') {
			if (!this.state) return json({ error: 'not found' }, 404);
			if (this.state.meta.purging) return json({ error: 'erased', message: 'This project was erased for good and can’t be restored.' }, 410);
			this.state.meta.deleted = false;
			delete this.state.meta.deletedAt;
			delete this.state.meta.deletedReason;
			this.state.meta.updatedAt = Date.now();
			this.state.meta.lastVisitedAt = Date.now();
			await this.save();
			broadcast(this.ctx, JSON.stringify(this.message()));
			return json(this.state.view());
		}
		if (this.ctx.getWebSockets().length >= LIMITS.maxViewersPerProject) return refuseSocket('This project already has ' + LIMITS.maxViewersPerProject + ' people connected. Trying again shortly.', 'full', 1013);
		const [client, server] = Object.values(new WebSocketPair());
		this.ctx.acceptWebSocket(server);
		const you = crypto.randomUUID().slice(0, 8);
		server.serializeAttachment({ id: you, diagram: null });
		server.send(JSON.stringify({ ...this.message(), you }));
		return new Response(null, { status: 101, webSocket: client });
	}

	message(except) {
		const exists = this.state && !this.state.meta.deleted;
		const meta = this.state && this.state.meta;
		return {
			t: 'project', project: exists ? this.state.view() : null, deleted: !!(meta && meta.deleted), viewers: this.viewers(except),
			deletedAt: meta && meta.deleted ? meta.deletedAt || null : null, erasesAt: meta ? erasedAt(meta, retention(this.env)) : null,
			deletedReason: meta && meta.deleted ? meta.deletedReason || null : null,
		};
	}

	viewers(except) {
		// a viewer whose socket died without closing stops sending heartbeats ('viewing' every 30 s) and drops off
		const cutoff = Date.now() - VIEWER_TIMEOUT_MS;
		return this.ctx.getWebSockets().filter((ws) => ws !== except).map((ws) => ws.deserializeAttachment())
			.filter((a) => a && a.diagram && (a.seen || 0) > cutoff).map(({ id, diagram, name, color }) => ({ id, diagram, name, color }));
	}

	async webSocketMessage(ws, raw) {
		if ((typeof raw === 'string' ? raw.length : raw.byteLength) > LIMITS.maxMessageBytes) return;
		let msg;
		try { msg = JSON.parse(raw); } catch { return; }
		if (msg.t === 'viewing') {
			const a = ws.deserializeAttachment();
			const before = JSON.stringify(this.viewers());
			ws.serializeAttachment({ id: a.id, diagram: String(msg.diagram || '').slice(0, 32), name: cleanName(msg.name, 'Someone'), color: String(msg.color || '#888').slice(0, 16), seen: Date.now() });
			const after = this.viewers();
			if (JSON.stringify(after) !== before) broadcast(this.ctx, JSON.stringify({ t: 'viewers', viewers: after })); // heartbeats change nothing
			if (this.state && !this.state.meta.deleted) {
				const newPerson = this.state.addVisitor(msg.visitor);
				const visited = touchVisited(this.state.meta, Date.now(), retention(this.env)); // keeps the project from expiring
				if (newPerson || visited) await this.save();
				if (newPerson) broadcast(this.ctx, JSON.stringify(this.message())); // everyone sees the count grow
			}
			return;
		}
		if (!this.state || this.state.meta.deleted) return;
		const { changed, reply, purged } = this.state.handle(msg);
		if (reply) ws.send(JSON.stringify(reply));
		if (purged) await this.env.ROOMS.get(this.env.ROOMS.idFromName(roomName(this.state.meta.id, purged))).fetch('https://do/purge', { method: 'POST' });
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
	}

	/* called by the Directory's sweep: delete the project if nobody opened it for long, erase it once it has been deleted long enough.
	   Returns {gone: true} once nothing of it is left. */
	async sweep() {
		if (!this.state) return json({ gone: true });
		const meta = this.state.meta, now = Date.now();
		if (!meta.purging) {
			const action = sweepDecision(meta, now, retention(this.env));
			if (action === 'start') { // from before projects expired: the clock starts now
				meta.lastVisitedAt = now;
				await this.save();
			} else if (action === 'delete') {
				meta.deleted = true;
				meta.deletedAt = now;
				meta.deletedReason = 'inactive';
				await this.save();
				broadcast(this.ctx, JSON.stringify({ t: 'deleted' }));
			} else if (action === 'purge') {
				meta.purging = true; // from here on it can't be restored
				await this.save();
				for (const ws of this.ctx.getWebSockets()) try { ws.close(1000, 'erased'); } catch { /* closed */ }
			}
		}
		if (!meta.purging) return json({ gone: false });
		// a few diagrams at a time, so a big project never exceeds the per-request limits; the next sweep continues
		const batch = meta.diagrams.slice(0, SWEEP_BATCH);
		await Promise.all(batch.map((d) => this.env.ROOMS.get(this.env.ROOMS.idFromName(roomName(meta.id, d.id))).fetch('https://do/purge', { method: 'POST' })));
		meta.diagrams = meta.diagrams.slice(batch.length);
		if (meta.diagrams.length) {
			await this.save();
			return json({ gone: false });
		}
		await this.ctx.storage.deleteAll();
		this.state = null;
		return json({ gone: true });
	}
}

/* single instance: how many projects each network created lately (keys are hashes, never the address itself).
   Older versions also kept a list of all projects here ("p:" entries); nothing reads or serves it any more. */
export class Directory extends DurableObject {
	async fetch(request) {
		const path = new URL(request.url).pathname;
		if (path === '/register') { // a new project, to be swept
			const { id } = await request.json();
			if (isValidId(id)) await this.ctx.storage.put('r:' + id, 1);
			return json({ ok: true });
		}
		if (path === '/sweep') return json(await this.expire());
		if (path !== '/quota') return json({ error: 'not found' }, 404);
		const { key, limit, windowMs } = await request.json();
		const now = Date.now();
		const taken = takeQuota((await this.ctx.storage.get('q:' + key)) || [], now, limit, windowMs);
		if (taken.ok) await this.ctx.storage.put('q:' + key, taken.stamps);
		await this.sweep(now, windowMs);
		return json({ ok: taken.ok, retryAt: taken.retryAt });
	}

	/* checks the next batch of registered projects (a stored cursor continues where the last sweep stopped).
	   Projects created before the registry existed are taken from the old "p:" entries once. */
	async expire() {
		if (!(await this.ctx.storage.get('backfilled'))) {
			const old = await this.ctx.storage.list({ prefix: 'p:' });
			const keys = Array.from(old.keys(), (key) => 'r:' + key.slice(2));
			for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.put(Object.fromEntries(keys.slice(i, i + 128).map((k) => [k, 1])));
			await this.ctx.storage.put('backfilled', Date.now());
		}
		const after = await this.ctx.storage.get('cursor');
		const batch = Array.from((await this.ctx.storage.list({ prefix: 'r:', ...(after ? { startAfter: after } : {}), limit: SWEEP_BATCH })).keys());
		const gone = [];
		await Promise.all(batch.map(async (key) => {
			try {
				const r = await project(this.env, key.slice(2)).fetch('https://do/sweep', { method: 'POST' });
				if ((await r.json()).gone) gone.push(key);
			} catch { /* try again next time */ }
		}));
		if (gone.length) await this.ctx.storage.delete(gone);
		if (batch.length < SWEEP_BATCH) await this.ctx.storage.delete('cursor');
		else await this.ctx.storage.put('cursor', batch[batch.length - 1]);
		return { checked: batch.length, erased: gone.length };
	}

	/* once a day: forget networks whose last project is older than the window */
	async sweep(now, windowMs) {
		if (now - ((await this.ctx.storage.get('swept')) || 0) < 24 * 3600 * 1000) return;
		await this.ctx.storage.put('swept', now);
		const expired = [];
		for (const [k, stamps] of await this.ctx.storage.list({ prefix: 'q:' })) if (!stamps.some((t) => now - t < windowMs)) expired.push(k);
		for (let i = 0; i < expired.length; i += 128) await this.ctx.storage.delete(expired.slice(i, i + 128));
	}
}

// sortable storage key for a version timestamp
function versionKey(prefix, at) {
	return prefix + String(Math.floor(Number(at)) || 0).padStart(15, '0');
}

function broadcast(ctx, data, except) {
	for (const ws of ctx.getWebSockets()) {
		if (ws === except) continue;
		try { ws.send(data); } catch { /* closing */ }
	}
}
