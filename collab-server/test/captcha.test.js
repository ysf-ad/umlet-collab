// Judging Turnstile's siteverify answer (src/captcha.js). Run: npm test
import { test } from 'node:test';
import assert from 'node:assert';
import { captchaAccepted, parseHostnames, CAPTCHA_ACTION } from '../src/captcha.js';

const good = { success: true, action: CAPTCHA_ACTION, hostname: 'umlet.example.com' };
const hosts = parseHostnames(' Umlet.Example.com , other.example.org ');

test('hostnames are read from a comma separated setting', () => {
	assert.deepStrictEqual(hosts, ['umlet.example.com', 'other.example.org']);
	assert.deepStrictEqual(parseHostnames(''), []);
	assert.deepStrictEqual(parseHostnames(undefined), []);
});

test('a passed token for our action on our hostname is accepted', () => {
	assert.ok(captchaAccepted(good, hosts));
	assert.ok(captchaAccepted({ ...good, hostname: 'UMLET.example.com' }, hosts), 'hostnames compare without case');
});

test('failed, missing or malformed answers are refused', () => {
	for (const bad of [null, undefined, {}, { success: false }, { success: 'true', action: CAPTCHA_ACTION, hostname: 'umlet.example.com' }]) assert.strictEqual(captchaAccepted(bad, hosts), false);
});

test('a token earned on another hostname or for another action is refused', () => {
	assert.strictEqual(captchaAccepted({ ...good, hostname: 'evil.example.net' }, hosts), false);
	assert.strictEqual(captchaAccepted({ ...good, hostname: undefined }, hosts), false);
	assert.strictEqual(captchaAccepted({ ...good, action: 'login' }, hosts), false);
	assert.strictEqual(captchaAccepted({ success: true }, hosts), false);
});

test('without configured hostnames only success counts (local development with test keys)', () => {
	assert.ok(captchaAccepted({ success: true }, []));
	assert.strictEqual(captchaAccepted({ success: false }, []), false);
});
