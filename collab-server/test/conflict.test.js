// Relay tests: merge rules (via the Node relay, same RoomState as the Durable Object) and Yjs text merging.
// Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { RoomState, toBase64, fromBase64 } from '../src/room.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

test('presence is relayed but never stored', async () => {
	const a = await client('t4'), b = await client('t4');
	a.ws.send(JSON.stringify({ t: 'presence', x: 1, y: 2, sel: ['x'] }));
	await sleep(50);
	assert.ok(b.inbox.some((m) => m.t === 'presence' && m.sel[0] === 'x'));
	const late = await client('t4');
	await sleep(50);
	assert.deepStrictEqual(late.inbox.find((m) => m.t === 'hello').elements, []);
	[a, b, late].forEach((c) => c.ws.close());
});

test('concurrent typing in the same text merges (both edits survive)', () => {
	const room = new RoomState();
	const docA = new Y.Doc(), docB = new Y.Doc();
	const relay = (doc) => doc.on('update', (u) => room.applyY(toBase64(u)));
	relay(docA);
	relay(docB);
	docA.getMap('texts').set('x', new Y.Text('Use case'));
	Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
	// both users type at the same time without seeing each other's edit
	docA.getMap('texts').get('x').insert(0, 'My ');
	docB.getMap('texts').get('x').insert(8, ' 1');
	// a late joiner gets the merged state from the room
	const late = new Y.Doc();
	Y.applyUpdate(late, fromBase64(room.hello().y));
	assert.strictEqual(late.getMap('texts').get('x').toString(), 'My Use case 1');
});
