// Load test for the collaboration server. Usage: node scripts/load-test.js <baseUrl> [diagrams] [clientsPerDiagram] [elements] [seconds]
//   e.g. node scripts/load-test.js http://localhost:8788 20 3 50 40
// Creates a throwaway project with <diagrams> diagrams. Per diagram, <clients> websocket clients join; one fills the
// diagram with <elements> elements, then every client drags random elements at ~4 changes/s. Latency is measured on a
// probe element: client 0 stamps it, the other clients of the diagram note when they receive it.
// Only talk to a server you may load (use a local `wrangler dev` or `node server.js`, not a shared production one).
import WebSocket from 'ws';

const [base = 'http://localhost:8788', D = '5', C = '3', E = '50', S = '30'] = process.argv.slice(2);
const diagrams = +D, clients = +C, elements = +E, seconds = +S;
const wsBase = base.replace(/^http/, 'ws');
const rand = () => Math.floor(Math.random() * 2147483647);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stats = { sent: 0, received: 0, errors: 0, closed: 0, latencies: [], timeline: [] };
const started = Date.now();

async function api(path, body) {
	const r = await fetch(base + path, { method: 'POST', body: JSON.stringify(body || {}) });
	return r.json();
}

function projectSocket(id) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`${wsBase}/project?id=${id}`);
		ws.on('open', () => resolve(ws));
		ws.on('error', reject);
	});
}

function client(room, index) {
	return new Promise((resolve) => {
		const ws = new WebSocket(`${wsBase}/collab?room=${encodeURIComponent(room)}`);
		const c = { ws, version: 1, mine: [], ready: false };
		ws.on('message', (raw) => {
			const msg = JSON.parse(raw);
			stats.received++;
			if (msg.t === 'hello') { c.ready = true; resolve(c); }
			if (msg.t === 'ops' && index !== 0) {
				for (const op of msg.ops) if (op.id === 'probe' && op.pa && op.pa.startsWith('ts:')) { const l = Date.now() - +op.pa.slice(3); stats.latencies.push(l); stats.timeline.push([Math.floor((Date.now() - started) / 1000), l]); }
			}
		});
		ws.on('error', () => stats.errors++);
		ws.on('close', () => stats.closed++);
	});
}

function op(c, id, extra) {
	return { id, type: 'UMLClass', x: 10, y: 10, w: 120, h: 60, pa: id, aa: '', deleted: false, version: c.version++, nonce: rand(), ...extra };
}
function send(c, ops) { c.ws.send(JSON.stringify({ t: 'ops', ops })); stats.sent += ops.length; }

const project = await api('/api/projects', { name: 'load-test ' + new Date().toISOString() });
console.log(`project ${project.id}; adding ${diagrams} diagrams`);
const control = await projectSocket(project.id);
const roomIds = [project.diagrams[0].id];
control.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'project' && m.project) for (const d of m.project.diagrams) if (!roomIds.includes(d.id)) roomIds.push(d.id); });
for (let i = 1; i < diagrams; i++) { control.send(JSON.stringify({ t: 'add' })); await sleep(60); }
await sleep(1000);
console.log(`diagrams created: ${roomIds.length}`);

const t0 = Date.now();
const all = [];
for (const d of roomIds) {
	const room = `${project.id}/${d}`;
	const cs = [];
	for (let i = 0; i < clients; i++) cs.push(await client(room, i));
	all.push(cs);
	// fill the diagram (a bulk import of <elements> elements in one message)
	send(cs[0], Array.from({ length: elements }, (_, i) => op(cs[0], 'e' + i, { x: (i % 10) * 140, y: Math.floor(i / 10) * 80 })));
}
console.log(`joined ${roomIds.length * clients} clients and filled ${roomIds.length * elements} elements in ${Date.now() - t0} ms`);

// dragging phase
const end = Date.now() + seconds * 1000;
const timers = [];
for (const cs of all) for (const [index, c] of cs.entries()) {
	timers.push(setInterval(() => {
		const id = 'e' + Math.floor(Math.random() * elements);
		send(c, [op(c, id, { x: Math.floor(Math.random() * 1500), y: Math.floor(Math.random() * 600) })]);
	}, 250));
	if (index === 0) timers.push(setInterval(() => send(c, [op(c, 'probe', { pa: 'ts:' + Date.now() })]), 1000));
}
await sleep(Math.max(0, end - Date.now()));
timers.forEach(clearInterval);
await sleep(3000); // let the last messages arrive

const lat = stats.latencies.sort((a, b) => a - b);
const pct = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : NaN;
console.log(JSON.stringify({
	diagrams: roomIds.length, clients: roomIds.length * clients, elementsPerDiagram: elements, seconds,
	opsSent: stats.sent, messagesReceived: stats.received, errors: stats.errors, unexpectedCloses: stats.closed,
	probeSamples: lat.length, latencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: lat[lat.length - 1] },
}, null, 1));

// worst probe latency per 5 s window: shows whether delays are a start-up burst, steady, or growing
const win = {}; for (const [sec, l] of stats.timeline) { const k = Math.floor(sec / 5) * 5; win[k] = Math.max(win[k] || 0, l); }
console.log('worst latency (ms) by 5 s window:', JSON.stringify(win));

// each room's stored state must now match what the clients last sent: reconnect fresh clients and count elements
let wrong = 0;
for (const d of roomIds.slice(0, 5)) {
	const n = await new Promise((resolve) => { const ws = new WebSocket(`${wsBase}/collab?room=${encodeURIComponent(project.id + '/' + d)}`); ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'hello') { resolve(m.elements.filter((e) => !e.deleted).length); ws.close(); } }); });
	if (n !== elements + 1) wrong++; // + the probe element
}
console.log(`fresh clients saw all ${elements} elements + the probe in ${5 - wrong} of 5 sampled diagrams`);
all.flat().forEach((c) => c.ws.close());
control.close();
process.exit(0);
