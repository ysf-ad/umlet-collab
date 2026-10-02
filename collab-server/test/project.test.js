// Project logic (src/project.js) and the project API/websocket of the Node relay. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { ProjectState, DirectoryState } from '../src/project.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 19080 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
let server;

before(async () => {
	server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), STATIC_DIRS: __dirname } });
	await new Promise((resolve) => server.stdout.once('data', resolve));
});
after(() => server.kill());

const names = (p) => p.view().diagrams.map((d) => d.name);

test('a new project starts with one diagram', () => {
	const p = ProjectState.create('p1', '  My   project ');
	assert.strictEqual(p.meta.name, 'My project');
	assert.deepStrictEqual(names(p), ['Diagram 1']);
});

test('add, rename, move and remove diagrams', () => {
	const p = ProjectState.create('p1', 'P');
	const { reply } = p.handle({ t: 'add', requestId: 'r1' });
	assert.strictEqual(reply.requestId, 'r1');
	p.handle({ t: 'add', name: 'Sequence' });
	assert.deepStrictEqual(names(p), ['Diagram 1', 'Diagram 2', 'Sequence']);
	p.handle({ t: 'rename', id: reply.id, name: 'Classes' });
	p.handle({ t: 'move', id: reply.id, index: 0 });
	assert.deepStrictEqual(names(p), ['Classes', 'Diagram 1', 'Sequence']);
	p.handle({ t: 'move', id: reply.id, index: 2 });
	assert.deepStrictEqual(names(p), ['Diagram 1', 'Sequence', 'Classes']);
	p.handle({ t: 'remove', id: reply.id });
	assert.deepStrictEqual(names(p), ['Diagram 1', 'Sequence']);
	assert.strictEqual(p.meta.diagrams.length, 3, 'removed diagrams are kept (soft delete)');
});

test('the last diagram cannot be removed', () => {
	const p = ProjectState.create('p1', 'P');
	const { changed, reply } = p.handle({ t: 'remove', id: p.view().diagrams[0].id });
	assert.strictEqual(changed, false);
	assert.strictEqual(reply.t, 'error');
});

test('directory lists projects by last edit and hides deleted ones', () => {
	const d = new DirectoryState();
	d.upsert({ id: 'a', name: 'A', updatedAt: 1 });
	d.upsert({ id: 'b', name: 'B', updatedAt: 2 });
	d.touch('a', 3);
	assert.deepStrictEqual(d.list().map((p) => p.id), ['a', 'b']);
	d.upsert({ id: 'b', deleted: true });
	assert.deepStrictEqual(d.list().map((p) => p.id), ['a']);
});

function connect(projectId) {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://localhost:${PORT}/project?id=${projectId}`);
		const inbox = [];
		ws.on('message', (m) => inbox.push(JSON.parse(m)));
		ws.on('open', () => resolve({ ws, inbox, send: (msg) => ws.send(JSON.stringify(msg)) }));
	});
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastProject = (c) => c.inbox.filter((m) => m.t === 'project').pop().project;

test('project changes reach everyone in the project and the directory', async () => {
	const created = await (await fetch(`${BASE}/api/projects`, { method: 'POST', body: JSON.stringify({ name: 'Shop' }) })).json();
	const a = await connect(created.id), b = await connect(created.id);
	a.send({ t: 'viewing', diagram: created.diagrams[0].id, name: 'Ann', color: '#f00' });
	a.send({ t: 'add', name: 'Orders', requestId: 'x' });
	await sleep(100);
	assert.ok(a.inbox.some((m) => m.t === 'added' && m.requestId === 'x'));
	assert.ok(!b.inbox.some((m) => m.t === 'added'), 'only the creator gets the reply');
	assert.deepStrictEqual(lastProject(b).diagrams.map((d) => d.name), ['Diagram 1', 'Orders']);
	assert.ok(b.inbox.some((m) => m.t === 'viewers' && m.viewers.some((v) => v.name === 'Ann')));
	const listed = await (await fetch(`${BASE}/api/projects`)).json();
	assert.strictEqual(listed.find((p) => p.id === created.id).diagrams, 2);
	[a, b].forEach((c) => c.ws.close());
});

test('deleted and unknown projects are reported as missing', async () => {
	const created = await (await fetch(`${BASE}/api/projects`, { method: 'POST', body: '{}' })).json();
	const a = await connect(created.id);
	await fetch(`${BASE}/api/projects/${created.id}`, { method: 'DELETE' });
	await sleep(50);
	assert.ok(a.inbox.some((m) => m.t === 'deleted'));
	const listed = await (await fetch(`${BASE}/api/projects`)).json();
	assert.ok(!listed.some((p) => p.id === created.id));
	const unknown = await connect('doesnotexist');
	await sleep(50);
	assert.strictEqual(lastProject(unknown), null);
	[a, unknown].forEach((c) => c.ws.close());
});
