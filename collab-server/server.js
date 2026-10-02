// Node relay for collaborative UMLetino (for local development or self-hosting; production runs on Cloudflare, see worker.js).
// - serves the built app (npm run build -> dist/)
// - websocket rooms keyed by ?room=, room state in memory (see src/room.js)
// - projects (/api/projects, /project?id=) in memory (see src/project.js)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomState } from './src/room.js';
import { ProjectState, DirectoryState, newId, cleanName, isValidId } from './src/project.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const STATIC_DIRS = (process.env.STATIC_DIRS ? process.env.STATIC_DIRS.split(path.delimiter) : [path.join(__dirname, 'dist')]).map((d) => path.resolve(d));

const MIME = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
	'.png': 'image/png', '.gif': 'image/gif', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
	'.json': 'application/json', '.txt': 'text/plain', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

const projects = new Map(); // id -> { state: ProjectState, clients: Set<ws> }
const directory = new DirectoryState();

function sendJson(res, data, status = 200) {
	res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
	res.end(JSON.stringify(data));
}

function handleApi(req, res, urlPath) {
	if (urlPath === '/api/projects' && req.method === 'GET') return sendJson(res, new URL(req.url, 'http://x').searchParams.has('deleted') ? directory.listDeleted() : directory.list()), true;
	if (urlPath === '/api/projects' && req.method === 'POST') {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			let name;
			try { name = JSON.parse(body || '{}').name; } catch { /* default name */ }
			const state = ProjectState.create(newId(), name);
			projects.set(state.meta.id, { state, clients: new Set() });
			directory.upsert(state.summary());
			sendJson(res, state.view());
		});
		return true;
	}
	const m = urlPath.match(/^\/api\/projects\/([a-z0-9]+)$/i);
	if (m && req.method === 'DELETE') {
		const p = projects.get(m[1]);
		if (!p) return sendJson(res, { error: 'not found' }, 404), true;
		p.state.meta.deleted = true;
		p.state.meta.deletedAt = Date.now();
		directory.upsert(p.state.summary());
		for (const c of p.clients) c.send(JSON.stringify({ t: 'deleted' }));
		return sendJson(res, { ok: true }), true;
	}
	const r = urlPath.match(/^\/api\/projects\/([a-z0-9]+)\/restore$/i);
	if (r && req.method === 'POST') {
		const p = projects.get(r[1]);
		if (!p) return sendJson(res, { error: 'not found' }, 404), true;
		p.state.meta.deleted = false;
		delete p.state.meta.deletedAt;
		p.state.meta.updatedAt = Date.now();
		directory.upsert(p.state.summary());
		return sendJson(res, p.state.view()), true;
	}
	return false;
}

const server = http.createServer((req, res) => {
	let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
	if (handleApi(req, res, urlPath)) return;
	if (urlPath === '/') urlPath = '/index.html';
	for (const dir of STATIC_DIRS) {
		const file = path.join(dir, urlPath);
		if (!file.startsWith(dir + path.sep)) continue;
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
		res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
		return fs.createReadStream(file).pipe(res);
	}
	res.writeHead(404);
	res.end('not found');
});

const rooms = new Map(); // room -> { clients: Set<ws>, state: RoomState }
const wss = new WebSocketServer({ noServer: true });
const projectWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
	const pathname = new URL(req.url, 'http://x').pathname;
	const target = pathname === '/collab' ? wss : pathname === '/project' ? projectWss : null;
	if (!target) return socket.destroy();
	target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

projectWss.on('connection', (ws, req) => {
	const id = new URL(req.url, 'http://x').searchParams.get('id');
	const p = isValidId(id) && projects.get(id);
	const viewers = (except) => (p ? Array.from(p.clients).filter((c) => c !== except && c.viewing).map((c) => c.viewing) : []);
	const message = () => ({ t: 'project', project: p && !p.state.meta.deleted ? p.state.view() : null, viewers: viewers() });
	const broadcast = (data, except) => { if (p) for (const c of p.clients) if (c !== except && c.readyState === 1) c.send(data); };
	ws.id = Math.random().toString(36).slice(2, 10);
	if (p) p.clients.add(ws);
	ws.send(JSON.stringify({ ...message(), you: ws.id }));
	ws.on('message', (raw) => {
		let msg;
		try { msg = JSON.parse(raw); } catch { return; }
		if (!p || p.state.meta.deleted) return;
		if (msg.t === 'viewing') {
			ws.viewing = { id: ws.id, diagram: String(msg.diagram || '').slice(0, 32), name: cleanName(msg.name, 'Someone'), color: String(msg.color || '#888').slice(0, 16) };
			return broadcast(JSON.stringify({ t: 'viewers', viewers: viewers() }));
		}
		const { changed, reply } = p.state.handle(msg);
		if (reply) ws.send(JSON.stringify(reply));
		if (changed) {
			directory.upsert(p.state.summary());
			broadcast(JSON.stringify(message()));
		}
	});
	ws.on('close', () => {
		if (!p) return;
		p.clients.delete(ws);
		broadcast(JSON.stringify({ t: 'viewers', viewers: viewers() }));
	});
});

wss.on('connection', (ws, req) => {
	const roomName = new URL(req.url, 'http://x').searchParams.get('room') || 'default';
	if (!rooms.has(roomName)) rooms.set(roomName, { clients: new Set(), state: new RoomState() });
	const room = rooms.get(roomName);
	ws.id = Math.random().toString(36).slice(2, 10);
	room.clients.add(ws);
	ws.send(JSON.stringify({ t: 'hello', id: ws.id, ...room.state.hello() }));

	ws.on('message', (raw) => {
		let msg;
		try { msg = JSON.parse(raw); } catch { return; }
		const out = room.state.handle(msg);
		if (!out) return;
		const projectId = roomName.includes('/') ? roomName.split('/')[0] : null;
		if (projectId && msg.t !== 'presence') directory.touch(projectId);
		const data = JSON.stringify({ ...out, from: ws.id });
		for (const c of room.clients) if (c !== ws && c.readyState === 1) c.send(data);
	});

	ws.on('close', () => {
		room.clients.delete(ws);
		const data = JSON.stringify({ t: 'leave', from: ws.id });
		for (const c of room.clients) if (c.readyState === 1) c.send(data);
		if (room.clients.size === 0 && !roomName.includes('/')) {
			// project diagrams live as long as the server; standalone rooms are kept for a while so a refresh doesn't lose them
			setTimeout(() => { if (room.clients.size === 0) rooms.delete(roomName); }, 10 * 60 * 1000);
		}
	});
});

server.listen(PORT, () => console.log(`collab umletino on http://localhost:${PORT}  (static: ${STATIC_DIRS.join(', ')})`));
