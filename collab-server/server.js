// Node relay for collaborative UMLetino (for local development or self-hosting; production runs on Cloudflare, see worker.js).
// - serves the built app (npm run build -> dist/)
// - websocket rooms keyed by ?room=, room state in memory (see src/room.js)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomState } from './src/room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const STATIC_DIRS = (process.env.STATIC_DIRS ? process.env.STATIC_DIRS.split(path.delimiter) : [path.join(__dirname, 'dist')]).map((d) => path.resolve(d));

const MIME = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
	'.png': 'image/png', '.gif': 'image/gif', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
	'.json': 'application/json', '.txt': 'text/plain', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
	let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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
const wss = new WebSocketServer({ server, path: '/collab' });

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
		const data = JSON.stringify({ ...out, from: ws.id });
		for (const c of room.clients) if (c !== ws && c.readyState === 1) c.send(data);
	});

	ws.on('close', () => {
		room.clients.delete(ws);
		const data = JSON.stringify({ t: 'leave', from: ws.id });
		for (const c of room.clients) if (c.readyState === 1) c.send(data);
		if (room.clients.size === 0) {
			// keep the diagram for a while so a refresh doesn't lose it
			setTimeout(() => { if (room.clients.size === 0) rooms.delete(roomName); }, 10 * 60 * 1000);
		}
	});
});

server.listen(PORT, () => console.log(`collab umletino on http://localhost:${PORT}  (static: ${STATIC_DIRS.join(', ')})`));
