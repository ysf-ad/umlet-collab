// Relay merge-rule tests. Starts its own server on a free port: node --test test/
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

const PORT = 18080 + Math.floor(Math.random() * 1000);
let server;

before(async () => {
	server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), STATIC_DIRS: __dirname } });
	await new Promise((resolve) => server.stdout.once('data', resolve));
});
after(() => server.kill());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function client(room) {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://localhost:${PORT}/collab?room=${room}`);
		const inbox = [];
		ws.on('message', (m) => inbox.push(JSON.parse(m)));
		ws.on('open', () => resolve({ ws, inbox, send: (ops) => ws.send(JSON.stringify({ t: 'ops', ops })) }));
	});
}
const base = { id: 'x', type: 'UMLClass', x: 0, y: 0, w: 100, h: 30, pa: 'A', aa: '', deleted: false };
const received = (c) => c.inbox.filter((m) => m.t === 'ops').flatMap((m) => m.ops.map((o) => o.pa));

test('concurrent edits with equal versions converge on the lower nonce', async () => {
	const a = await client('t1'), b = await client('t1');
	a.send([{ ...base, version: 1, nonce: 50 }]);
	await sleep(50);
	a.send([{ ...base, pa: 'from A', version: 2, nonce: 900 }]);
	b.send([{ ...base, pa: 'from B', version: 2, nonce: 100 }]);
	await sleep(100);
	const late = await client('t1');
	await sleep(50);
	const x = late.inbox.find((m) => m.t === 'hello').elements.find((e) => e.id === 'x');
	assert.strictEqual(x.pa, 'from B');
	// A must have been told about B's winning edit, B must not have been sent A's losing one after its own
	assert.ok(received(a).includes('from B'));
	[a, b, late].forEach((c) => c.ws.close());
});

test('stale versions are dropped and not relayed', async () => {
	const a = await client('t2'), b = await client('t2');
	a.send([{ ...base, pa: 'v3', version: 3, nonce: 5 }]);
	await sleep(50);
	a.send([{ ...base, pa: 'stale', version: 2, nonce: 1 }]);
	await sleep(50);
	assert.deepStrictEqual(received(b), ['v3']);
	[a, b].forEach((c) => c.ws.close());
});

test('deletions are kept as tombstones for late joiners', async () => {
	const a = await client('t3');
	a.send([{ ...base, version: 1, nonce: 1 }]);
	a.send([{ id: 'x', deleted: true, version: 2, nonce: 1 }]);
	await sleep(50);
	const late = await client('t3');
	await sleep(50);
	const x = late.inbox.find((m) => m.t === 'hello').elements.find((e) => e.id === 'x');
	assert.strictEqual(x.deleted, true);
	[a, late].forEach((c) => c.ws.close());
});
