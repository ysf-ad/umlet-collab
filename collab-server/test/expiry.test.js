// When projects expire (src/expiry.js). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert';
import { retention, sweepDecision, touchVisited, erasedAt, INACTIVE_DAYS, DELETED_DAYS } from '../src/expiry.js';

const DAY = 24 * 3600 * 1000;
const r = retention();
const NOW = Date.UTC(2026, 11, 1);

test('the default windows are 60 days unopened and 30 days deleted', () => {
	assert.strictEqual(INACTIVE_DAYS, 60);
	assert.strictEqual(DELETED_DAYS, 30);
	assert.strictEqual(r.inactiveMs, 60 * DAY);
	assert.strictEqual(r.deletedMs, 30 * DAY);
});

test('test overrides shorten the windows, junk values are ignored', () => {
	assert.deepStrictEqual(retention({ INACTIVE_MS: '3000', DELETED_MS: '4000' }), { inactiveMs: 3000, deletedMs: 4000 });
	assert.deepStrictEqual(retention({ INACTIVE_MS: 'soon', DELETED_MS: '-5' }), r);
});

test('a project without a last-opened time starts its clock instead of being deleted', () => {
	assert.strictEqual(sweepDecision({ deleted: false }, NOW, r), 'start');
	assert.strictEqual(sweepDecision({ deleted: false, lastVisitedAt: 0 }, NOW, r), 'start');
});

test('a project is deleted only once nobody opened it for 60 days', () => {
	const at = (daysAgo) => ({ deleted: false, lastVisitedAt: NOW - daysAgo * DAY });
	assert.strictEqual(sweepDecision(at(0), NOW, r), 'keep');
	assert.strictEqual(sweepDecision(at(59.9), NOW, r), 'keep');
	assert.strictEqual(sweepDecision(at(60), NOW, r), 'delete');
	assert.strictEqual(sweepDecision(at(400), NOW, r), 'delete');
});

test('a deleted project is erased only 30 days after it was deleted', () => {
	const at = (daysAgo) => ({ deleted: true, deletedAt: NOW - daysAgo * DAY, lastVisitedAt: NOW - 500 * DAY });
	assert.strictEqual(sweepDecision(at(0), NOW, r), 'keep');
	assert.strictEqual(sweepDecision(at(29.9), NOW, r), 'keep');
	assert.strictEqual(sweepDecision(at(30), NOW, r), 'purge');
});

test('a deleted project with no deletion time is never erased (nothing says how long it has been deleted)', () => {
	assert.strictEqual(sweepDecision({ deleted: true }, NOW, r), 'keep');
});

test('being unopened for a long time does not erase a project directly: it is deleted first, then waits 30 days', () => {
	const stale = { deleted: false, lastVisitedAt: NOW - 90 * DAY };
	assert.strictEqual(sweepDecision(stale, NOW, r), 'delete');
	const justDeleted = { ...stale, deleted: true, deletedAt: NOW };
	assert.strictEqual(sweepDecision(justDeleted, NOW, r), 'keep');
	assert.strictEqual(sweepDecision(justDeleted, NOW + 31 * DAY, r), 'purge');
});

test('opening a project refreshes its time, but only about hourly', () => {
	const meta = { lastVisitedAt: NOW - 30 * 60 * 1000 };
	assert.strictEqual(touchVisited(meta, NOW, r), false, 'visited half an hour ago: no write');
	assert.strictEqual(touchVisited(meta, NOW + 40 * 60 * 1000, r), true);
	assert.strictEqual(meta.lastVisitedAt, NOW + 40 * 60 * 1000);
	assert.strictEqual(touchVisited({}, NOW, r), true, 'the first visit is recorded');
});

test('when a deleted project will be erased', () => {
	assert.strictEqual(erasedAt({ deleted: true, deletedAt: NOW }, r), NOW + 30 * DAY);
	assert.strictEqual(erasedAt({ deleted: false }, r), null);
	assert.strictEqual(erasedAt({ deleted: true }, r), null);
});
