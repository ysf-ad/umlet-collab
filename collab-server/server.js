// Tiny relay for collaborative UMLetino.
// - serves the compiled umlet-web app (static files)
// - websocket rooms keyed by ?room=, relays messages to everyone else in the room
// - keeps the latest diagram per room so late joiners get it immediately
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
// html/css live in src/main/webapp, the GWT-compiled js lands in target/umlet-web-<version>/
const WEB = path.join(__dirname, '..', 'umlet-web');
const targetDir = (fs.readdirSync(path.join(WEB, 'target')).find((d) => /^umlet-web-[\d.]+(-SNAPSHOT)?$/.test(d)) || '');
const STATIC_DIRS = (process.env.STATIC_DIRS ? process.env.STATIC_DIRS.split(path.delimiter) : [path.join(WEB, 'src', 'main', 'webapp'), path.join(WEB, 'target', targetDir)]).map((d) => path.resolve(d));

const MIME = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
	'.png': 'image/png', '.gif': 'image/gif', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
	'.json': 'application/json', '.txt': 'text/plain', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
	let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
	if (urlPath === '/') urlPath = '/umletino.html';
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

const rooms = new Map(); // room -> { clients: Set<ws>, doc: string|null }

const wss = new WebSocketServer({ server, path: '/collab' });
let nextId = 1;

wss.on('connection', (ws, req) => {
	const roomName = new URL(req.url, 'http://x').searchParams.get('room') || 'default';
	if (!rooms.has(roomName)) rooms.set(roomName, { clients: new Set(), doc: null });
	const room = rooms.get(roomName);
	ws.id = nextId++;
	room.clients.add(ws);
	ws.send(JSON.stringify({ t: 'hello', id: ws.id, doc: room.doc }));

	ws.on('message', (raw) => {
		let msg;
		try { msg = JSON.parse(raw); } catch { return; }
		msg.from = ws.id;
		if (msg.t === 'doc') room.doc = msg.xml;
		const out = JSON.stringify(msg);
		for (const c of room.clients) if (c !== ws && c.readyState === 1) c.send(out);
	});

	ws.on('close', () => {
		room.clients.delete(ws);
		const out = JSON.stringify({ t: 'leave', from: ws.id });
		for (const c of room.clients) if (c.readyState === 1) c.send(out);
		if (room.clients.size === 0 && !process.env.KEEP_EMPTY_ROOMS) {
			// keep doc for a while so a refresh doesn't lose the diagram
			setTimeout(() => { if (room.clients.size === 0) rooms.delete(roomName); }, 10 * 60 * 1000);
		}
	});
});

server.listen(PORT, () => console.log(`collab umletino on http://localhost:${PORT}  (static: ${STATIC_DIRS.join(', ')})`));
