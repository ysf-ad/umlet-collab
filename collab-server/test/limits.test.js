// Limits that protect a public deployment (src/limits.js, RoomState.enforceLimits). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert';
import { RoomState } from '../src/room.js';
import { LIMITS, takeQuota, networkOf } from '../src/limits.js';

let version = 1;
const op = (id, extra) => ({ id, type: 'UMLClass', x: 0, y: 0, w: 10, h: 10, pa: id, aa: '', deleted: false, version: version++, nonce: 1, ...extra });
const send = (room, ops) => {
	const { msg, rejected, reason } = room.enforceLimits({ t: 'ops', ops });
	room.handle(msg);
	return { rejected, reason };
};

test('new elements beyond the element limit are refused, the others are kept', () => {
	const room = new RoomState();
	const ids = Array.from({ length: LIMITS.maxElementsPerDiagram + 25 }, (_, i) => 'e' + i);
	const { rejected, reason } = send(room, ids.map((id) => op(id)));
	assert.strictEqual(room.liveCount(), LIMITS.maxElementsPerDiagram);
	assert.deepStrictEqual(rejected, ids.slice(LIMITS.maxElementsPerDiagram));
	assert.strictEqual(reason, 'elements');
});

test('a diagram at its limit can still be edited, deleted from, and refilled', () => {
	const room = new RoomState();
	send(room, Array.from({ length: LIMITS.maxElementsPerDiagram }, (_, i) => op('e' + i)));
	assert.strictEqual(send(room, [op('e0', { x: 99 })]).rejected.length, 0, 'moving an existing element is fine');
	assert.strictEqual(room.elements.get('e0').x, 99);
	assert.strictEqual(send(room, [op('new1')]).rejected.length, 1, 'adding is refused');
	send(room, [op('e1', { deleted: true })]);
	assert.strictEqual(send(room, [op('new2')]).rejected.length, 0, 'a freed slot can be used');
	assert.strictEqual(send(room, [op('e1')]).rejected.length, 1, 'bringing the deleted element back needs a free slot too');
	assert.strictEqual(room.liveCount(), LIMITS.maxElementsPerDiagram);
});

test('the diagram text record never counts as an element', () => {
	const room = new RoomState();
	send(room, Array.from({ length: LIMITS.maxElementsPerDiagram }, (_, i) => op('e' + i)));
	assert.strictEqual(send(room, [op('_diagram', { type: '_diagram', pa: 'help' })]).rejected.length, 0);
});

test('deleting an element the diagram never had leaves no record behind', () => {
	const room = new RoomState();
	send(room, Array.from({ length: 50 }, (_, i) => op('ghost' + i, { deleted: true })));
	assert.strictEqual(room.elements.size, 0);
});

test('remembered deletions are bounded too', () => {
	const room = new RoomState();
	for (let i = 0; i < LIMITS.maxRecordsPerDiagram; i++) room.elements.set('old' + i, op('old' + i, { deleted: true }));
	const { rejected, reason } = send(room, [op('fresh')]);
	assert.deepStrictEqual(rejected, ['fresh']);
	assert.strictEqual(reason, 'records');
});

test('messages that are not ops pass through untouched', () => {
	const room = new RoomState();
	const msg = { t: 'presence', x: 1 };
	assert.strictEqual(room.enforceLimits(msg).msg, msg);
});

test('the quota allows the limit, then says when it frees up, and counts only the window', () => {
	const day = 24 * 3600 * 1000, window = 30 * day;
	let stamps = [];
	for (let i = 0; i < 5; i++) {
		const r = takeQuota(stamps, i * day, 5, window);
		assert.ok(r.ok);
		stamps = r.stamps;
	}
	const denied = takeQuota(stamps, 6 * day, 5, window);
	assert.strictEqual(denied.ok, false);
	assert.strictEqual(denied.retryAt, 0 + window, 'frees up when the oldest use leaves the window');
	assert.strictEqual(denied.stamps.length, 5, 'a refused try is not recorded');
	assert.ok(takeQuota(stamps, window + 1, 5, window).ok, 'the oldest use has expired');
});

test('IPv6 visitors are counted per /64, IPv4 per address', () => {
	assert.strictEqual(networkOf('203.0.113.7'), '203.0.113.7');
	assert.strictEqual(networkOf('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), networkOf('2001:db8:1:2::1'));
	assert.notStrictEqual(networkOf('2001:db8:1:2::1'), networkOf('2001:db8:1:3::1'));
});
