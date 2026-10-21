// Project logic (src/project.js) and the project API/websocket of the Node relay. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { ProjectState } from '../src/project.js';
import { LIMITS } from '../src/limits.js';

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

const lookup = async (ids) => (await fetch(`${BASE}/api/projects/lookup`, { method: 'POST', body: JSON.stringify({ ids }) })).json();

test('project changes reach everyone in the project', async () => {
	const created = await (await fetch(`${BASE}/api/projects`, { method: 'POST', body: JSON.stringify({ name: 'Shop' }) })).json();
	const a = await connect(created.id), b = await connect(created.id);
	a.send({ t: 'viewing', diagram: created.diagrams[0].id, name: 'Ann', color: '#f00' });
	a.send({ t: 'add', name: 'Orders', requestId: 'x' });
	await sleep(100);
	assert.ok(a.inbox.some((m) => m.t === 'added' && m.requestId === 'x'));
	assert.ok(!b.inbox.some((m) => m.t === 'added'), 'only the creator gets the reply');
	assert.deepStrictEqual(lastProject(b).diagrams.map((d) => d.name), ['Diagram 1', 'Orders']);
	assert.ok(b.inbox.some((m) => m.t === 'viewers' && m.viewers.some((v) => v.name === 'Ann')));
	assert.strictEqual((await lookup([created.id]))[0].diagrams, 2);
	[a, b].forEach((c) => c.ws.close());
});

test('deleted and unknown projects are reported as missing', async () => {
	const created = await (await fetch(`${BASE}/api/projects`, { method: 'POST', body: '{}' })).json();
	const a = await connect(created.id);
	await fetch(`${BASE}/api/projects/${created.id}`, { method: 'DELETE' });
	await sleep(50);
	assert.ok(a.inbox.some((m) => m.t === 'deleted'));
	const afterwards = await connect(created.id);
	await sleep(50);
	const m = afterwards.inbox.find((x) => x.t === 'project');
	assert.strictEqual(m.project, null);
	assert.strictEqual(m.deleted, true, 'a deleted project says so, so the page can offer to restore it');
	afterwards.ws.close();
	assert.strictEqual((await lookup([created.id]))[0].deleted, true);
	const unknown = await connect('doesnotexist');
	await sleep(50);
	assert.strictEqual(lastProject(unknown), null);
	assert.strictEqual(unknown.inbox.find((x) => x.t === 'project').deleted, false, 'an unknown project is not "deleted"');
	[a, unknown].forEach((c) => c.ws.close());
});

test('deleted diagrams are listed in trash and can be restored', () => {
	const p = ProjectState.create('p1', 'P');
	const { reply } = p.handle({ t: 'add', name: 'Orders' });
	p.handle({ t: 'add', name: 'Users' });
	p.handle({ t: 'remove', id: reply.id });
	assert.deepStrictEqual(p.view().trash.map((d) => d.name), ['Orders']);
	assert.ok(p.view().trash[0].deletedAt > 0);
	const restored = p.handle({ t: 'restore', id: reply.id });
	assert.deepStrictEqual(restored.reply, { t: 'restored', id: reply.id });
	assert.deepStrictEqual(names(p), ['Diagram 1', 'Users', 'Orders'], 'restored diagrams come back at the end');
	assert.deepStrictEqual(p.view().trash, []);
});

test('deleted projects stay reachable by id and can be restored', async () => {
	const created = await (await fetch(`${BASE}/api/projects`, { method: 'POST', body: JSON.stringify({ name: 'Old' }) })).json();
	await fetch(`${BASE}/api/projects/${created.id}`, { method: 'DELETE' });
	let [found] = await lookup([created.id]);
	assert.ok(found.deleted && found.deletedAt > 0);
	await fetch(`${BASE}/api/projects/${created.id}/restore`, { method: 'POST' });
	[found] = await lookup([created.id]);
	assert.ok(!found.deleted);
});

test('there is no public list of projects; lookup only answers for ids it is given', async () => {
	assert.strictEqual((await fetch(`${BASE}/api/projects`)).status, 404);
	assert.strictEqual((await fetch(`${BASE}/api/projects?deleted=1`)).status, 404);
	const a = await (await fetch(`${BASE}/api/projects`, { method: 'POST', body: JSON.stringify({ name: 'A' }) })).json();
	await (await fetch(`${BASE}/api/projects`, { method: 'POST', body: JSON.stringify({ name: 'B' }) })).json();
	assert.strictEqual(a.id.length, 24, 'new project ids are long');
	const found = await lookup([a.id, 'nosuchproject', '../x', 5, null]);
	assert.deepStrictEqual(found.map((p) => p.name), ['A']);
	assert.deepStrictEqual(await lookup('not a list'), []);
});

test('people who opened a project are counted once each, by random id, up to a cap', () => {
	const p = ProjectState.create('p1', 'P');
	assert.strictEqual(p.view().people, 0);
	assert.ok(p.addVisitor('a1b2c3d4e5f6'));
	assert.strictEqual(p.addVisitor('a1b2c3d4e5f6'), false, 'the same person again');
	for (const bad of ['short', '', null, 5, 'has spaces in it!', 'x'.repeat(40)]) assert.strictEqual(p.addVisitor(bad), false, String(bad));
	assert.ok(p.addVisitor('f6e5d4c3b2a1'));
	assert.strictEqual(p.view().people, 2);
	assert.strictEqual(p.summary().people, 2);
	for (let i = 0; i < 300; i++) p.addVisitor('visitor' + String(i).padStart(6, '0'));
	assert.strictEqual(p.view().people, 200);
});

test('the people count grows when someone new joins, and only then', async () => {
	const created = await (await fetch(`${BASE}/api/projects`, { method: 'POST', body: '{}' })).json();
	const a = await connect(created.id), b = await connect(created.id);
	const view = (c) => c.inbox.filter((m) => m.t === 'project').pop().project;
	a.send({ t: 'viewing', diagram: created.diagrams[0].id, name: 'Ann', color: '#f00', visitor: 'annannann1234' });
	await sleep(80);
	assert.strictEqual(view(b).people, 1, 'others see it too');
	a.send({ t: 'viewing', diagram: created.diagrams[0].id, name: 'Ann', color: '#f00', visitor: 'annannann1234' }); // heartbeat
	b.send({ t: 'viewing', diagram: created.diagrams[0].id, name: 'Bob', color: '#00f', visitor: 'bobbobbob5678' });
	await sleep(80);
	assert.strictEqual(view(a).people, 2);
	assert.strictEqual((await lookup([created.id]))[0].people, 2);
	[a, b].forEach((c) => c.ws.close());
});

test('a project has at most 40 diagrams, restoring respects that too, and errors say why', () => {
	const p = ProjectState.create('p1', 'P');
	for (let i = 1; i < LIMITS.maxDiagramsPerProject; i++) assert.ok(p.handle({ t: 'add' }).changed);
	assert.strictEqual(names(p).length, 40);
	const full = p.handle({ t: 'add' });
	assert.strictEqual(full.changed, false);
	assert.strictEqual(full.reply.t, 'error');
	assert.match(full.reply.message, /at most 40 diagrams/);
	assert.strictEqual(names(p).length, 40, 'nothing was added');
	// make room, delete one, fill the space again: the deleted one cannot come back over the limit
	const victim = p.view().diagrams[5].id;
	p.handle({ t: 'remove', id: victim });
	p.handle({ t: 'add' });
	const restore = p.handle({ t: 'restore', id: victim });
	assert.strictEqual(restore.changed, false);
	assert.match(restore.reply.message, /already has 40 diagrams/);
	assert.strictEqual(p.view().trash.length, 1, 'the deleted diagram is still there');
});

test('the pile of deleted diagrams is bounded, and permanently deleting makes room', () => {
	const p = ProjectState.create('p1', 'P');
	for (let i = 0; i < LIMITS.maxDeletedPerProject; i++) {
		const { reply } = p.handle({ t: 'add' });
		p.handle({ t: 'remove', id: reply.id });
	}
	const blocked = p.handle({ t: 'add' });
	assert.strictEqual(blocked.changed, false);
	assert.match(blocked.reply.message, /deleted diagrams/);
	const purged = p.handle({ t: 'purge', id: p.view().trash[0].id });
	assert.ok(purged.purged);
	assert.ok(p.handle({ t: 'add' }).changed);
});

test('a diagram room needs an existing project and diagram', async () => {
	const created = await (await fetch(`${BASE}/api/projects`, { method: 'POST', body: '{}' })).json();
	const open = (room) => new Promise((resolve) => {
		const ws = new WebSocket(`ws://localhost:${PORT}/collab?room=${encodeURIComponent(room)}`);
		const inbox = [];
		ws.on('message', (m) => { inbox.push(JSON.parse(m)); });
		ws.on('close', () => resolve(inbox));
		setTimeout(() => { ws.close(); }, 300);
	});
	const good = await open(`${created.id}/${created.diagrams[0].id}`);
	assert.strictEqual(good[0].t, 'hello');
	for (const bad of [`${created.id}/nosuchdiagram`, `nosuchproject1/${created.diagrams[0].id}`, `${created.id}/a/b`]) {
		const inbox = await open(bad);
		assert.strictEqual(inbox[0].t, 'rejected', bad);
	}
});
