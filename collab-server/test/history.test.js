// Version history (src/room.js) and permanent deletion of diagrams (src/project.js). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert';
import * as Y from 'yjs';
import { RoomState, VERSION_INTERVAL_MS, toBase64 } from '../src/room.js';
import { ProjectState } from '../src/project.js';

const HOUR = VERSION_INTERVAL_MS;
let v = 1;
const add = (id, extra = {}) => ({ id, type: 'UMLClass', x: 10, y: 20, w: 120, h: 60, pa: id, aa: '', deleted: false, version: v++, nonce: 1, ...extra });
const del = (id) => ({ id, deleted: true, version: v++, nonce: 1 });

function room(ids) {
	const r = new RoomState();
	r.handle({ t: 'ops', ops: ids.map((id) => add(id)) });
	return r;
}

// the client sends edits as messages; this applies one the way the servers do (version first, then the change)
function edit(r, msg, now) {
	const version = r.versionBefore(msg, now);
	r.handle(msg);
	return version;
}

test('an hourly version is the diagram before editing resumed, only if it changed', () => {
	const r = room(['A', 'B']);
	const first = edit(r, { t: 'ops', ops: [add('C')] }, 0);
	assert.ok(first, 'first edit with content saves a version');
	assert.strictEqual(first.reason, 'hourly');
	assert.strictEqual(first.count, 2); // A and B: the state before C was added
	assert.ok(!first.uxf.includes('<panel_attributes>C<'));

	assert.strictEqual(edit(r, { t: 'ops', ops: [add('D')] }, HOUR / 2), null, 'not again within the hour');
	const second = edit(r, { t: 'ops', ops: [add('E')] }, HOUR + 1);
	assert.ok(second);
	assert.strictEqual(second.count, 4); // A, B, C, D

	// an hour later with no change since the last version: nothing new is stored
	const r2 = room(['A']);
	edit(r2, { t: 'ops', ops: [add('A2', { x: 99 })] }, 0);
	r2.lastVersion.uxf = r2.toUxf().uxf; // pretend the version already matches the current diagram
	assert.strictEqual(edit(r2, { t: 'presence' }, 2 * HOUR), null);
	assert.strictEqual(r2.versionBefore({ t: 'ops', ops: [] }, 2 * HOUR), null);
});

test('a version is saved right before a large delete (e.g. File Import replacing the diagram)', () => {
	const r = room(['A', 'B', 'C', 'D']);
	edit(r, { t: 'ops', ops: [add('E')] }, 0); // hourly version taken
	assert.strictEqual(edit(r, { t: 'ops', ops: [del('A')] }, 1000), null, 'deleting one of five is not large');
	const before = edit(r, { t: 'ops', ops: [del('B'), del('C'), del('D'), del('E'), add('NEW')] }, 2000);
	assert.ok(before);
	assert.strictEqual(before.reason, 'before a large change');
	assert.strictEqual(before.count, 4); // B, C, D, E still there
	for (const id of ['B', 'C', 'D', 'E']) assert.ok(before.uxf.includes('<panel_attributes>' + id + '</panel_attributes>'));
});

test('versions are valid .uxf with the texts from the shared Yjs document', () => {
	const r = room(['A']);
	const doc = new Y.Doc();
	const texts = doc.getMap('texts');
	texts.set('A', new Y.Text('Order\n--\n-id: int <PK> & more'));
	texts.set('_diagram', new Y.Text('help text'));
	r.handle({ t: 'y', u: toBase64(Y.encodeStateAsUpdate(doc)) });
	const { uxf, count } = r.toUxf();
	assert.strictEqual(count, 1);
	assert.match(uxf, /<zoom_level>10<\/zoom_level>/);
	assert.match(uxf, /<help_text>help text<\/help_text>/);
	assert.match(uxf, /<panel_attributes>Order\n--\n-id: int &lt;PK&gt; &amp; more<\/panel_attributes>/);
	assert.match(uxf, /<x>10<\/x>\s*<y>20<\/y>\s*<w>120<\/w>\s*<h>60<\/h>/);
});

test('only deleted diagrams can be permanently deleted', () => {
	const p = ProjectState.create('p1', 'P');
	p.handle({ t: 'add' });
	const [a, b] = p.meta.diagrams;
	assert.strictEqual(p.handle({ t: 'purge', id: a.id }).changed, false, 'a visible diagram is not purged');
	p.handle({ t: 'remove', id: b.id });
	assert.strictEqual(p.view().trash.length, 1);
	const res = p.handle({ t: 'purge', id: b.id });
	assert.strictEqual(res.purged, b.id);
	assert.strictEqual(p.view().trash.length, 0);
	assert.strictEqual(p.meta.diagrams.length, 1);
	assert.strictEqual(p.handle({ t: 'restore', id: b.id }).changed, false, 'gone for good');
});

test('a checkpoint keeps the current diagram before a restore, unless it is already the newest version', () => {
	const r = room(['A']);
	const v1 = r.versionNow('before a restore', 5);
	assert.ok(v1);
	assert.strictEqual(v1.count, 1);
	assert.strictEqual(r.versionNow('before a restore', 6), null);
	assert.strictEqual(new RoomState().versionNow('before a restore', 7), null, 'empty diagrams are not kept');
});
