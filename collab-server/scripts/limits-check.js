// End-to-end check of the public-hosting protections against a LOCAL Worker. Usage: node scripts/limits-check.js [baseUrl]
//   start one first:  npx wrangler dev --port 8799   (with a .dev.vars file holding Cloudflare's Turnstile test keys:
//   TURNSTILE_SECRET=1x0000000000000000000000000000000AA and TURNSTILE_SITE_KEY=1x00000000000000000000AA)
// It creates many projects, so it refuses to talk to anything but localhost. Fake client addresses are sent in the
// CF-Connecting-IP header, which the Worker only trusts because Cloudflare sets it in production.
import WebSocket from 'ws';

const base = process.argv[2] || 'http://localhost:8799';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error('local servers only');
const wsBase = base.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); if (!ok) failures++; };

const api = (path, body, ip, method = 'POST') => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(ip ? { 'CF-Connecting-IP': ip } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const create = (ip, token = 'any-token') => api('/api/projects', { name: 'check', token }, ip);

// opens a socket and collects messages for a moment
function open(url, ms = 400) {
	return new Promise((resolve) => {
		const ws = new WebSocket(url);
		const inbox = [];
		ws.on('message', (m) => inbox.push(JSON.parse(m)));
		ws.on('error', () => {});
		ws.on('open', () => setTimeout(() => resolve({ ws, inbox, send: (m) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)) }), ms));
		ws.on('close', () => setTimeout(() => resolve({ ws, inbox, closed: true }), 50));
	});
}
const room = (r) => open(`${wsBase}/collab?room=${encodeURIComponent(r)}`);

// ---- nothing is listed -------------------------------------------------------------------------
check('GET /api/projects is gone', (await fetch(base + '/api/projects')).status === 404);
check('GET /api/projects?deleted is gone', (await fetch(base + '/api/projects?deleted=1')).status === 404);

// ---- captcha ---------------------------------------------------------------------------------------
const config = await (await fetch(base + '/api/config')).json();
check('config advertises the captcha site key', !!config.turnstileSiteKey, JSON.stringify(config));
let r = await create('198.51.100.1', '');
check('no captcha token is refused with a message', r.status === 400 && (await r.json()).error === 'captcha');

// ---- the per-network quota -----------------------------------------------------------------------------
const made = [];
for (let i = 0; i < 5; i++) {
	r = await create('198.51.100.10');
	if (r.ok) made.push(await r.json());
}
check('5 projects from one network are created', made.length === 5, String(made.length));
check('new project ids are long', made[0] && made[0].id.length === 24);
r = await create('198.51.100.10');
let body = await r.json();
check('the 6th is refused with 429, the limit and when it frees up', r.status === 429 && body.error === 'project_limit' && body.limit === 5 && body.retryAt > Date.now(), JSON.stringify(body));
check('another network is not affected', (await create('198.51.100.11')).ok);
check('an IPv6 address counts per /64', (await create('2001:db8:aaaa:bbbb::1')).ok && (await create('2001:db8:aaaa:bbbb:1:2:3:4')).ok);
for (let i = 0; i < 3; i++) await create('2001:db8:aaaa:bbbb::9');
check('...and the whole /64 is limited together', (await create('2001:db8:aaaa:bbbb::77')).status === 429);

// ---- lookup: only answers for ids it is given ---------------------------------------------------------------
const found = await (await api('/api/projects/lookup', { ids: [made[0].id, made[1].id, 'nosuchproject', '../etc', 7] })).json();
check('lookup returns just the existing projects asked for', found.length === 2 && found.every((p) => p.name === 'check'), JSON.stringify(found));

// ---- diagram rooms only exist for real diagrams ----------------------------------------------------------------
const p = made[0], d = p.diagrams[0].id;
check('a real diagram connects', (await room(`${p.id}/${d}`)).inbox[0]?.t === 'hello');
check('an unknown diagram is refused with a message', (await room(`${p.id}/nosuchdiagram`)).inbox[0]?.t === 'rejected');
check('an unknown project is refused', (await room(`nosuchproject12345/${d}`)).inbox[0]?.t === 'rejected');
check('an arbitrary room name is refused (nothing is created)', (await room('just-some-name')).inbox[0]?.t === 'rejected');
check('the old default room is refused when it never held a diagram', (await room('default')).inbox[0]?.t === 'rejected');

// ---- 40 diagrams per project -------------------------------------------------------------------------------------------
const proj = await open(`${wsBase}/project?id=${p.id}`);
let errors = [];
proj.ws.on('message', (m) => { const x = JSON.parse(m); if (x.t === 'error') errors.push(x); });
for (let i = 0; i < 42; i++) { proj.send({ t: 'add' }); await sleep(40); }
await sleep(300);
const last = [...proj.inbox].reverse().find((m) => m.t === 'project');
const view = (await (await api('/api/projects/lookup', { ids: [p.id] })).json())[0];
check('a project stops at 40 diagrams', view.diagrams === 40, String(view.diagrams));
check('every add past 40 came back with an error message (3 of the 42 tries)', errors.length === 3 && /at most 40 diagrams/.test(errors[0].message), JSON.stringify(errors));
proj.ws.close();

// ---- 1500 elements per diagram --------------------------------------------------------------------------------------------
const big = await room(`${made[1].id}/${made[1].diagrams[0].id}`);
const op = (i) => ({ id: 'e' + i, type: 'UMLClass', x: 0, y: 0, w: 10, h: 10, pa: 'e' + i, aa: '', deleted: false, version: 1, nonce: 1 });
big.send({ t: 'ops', ops: Array.from({ length: 1600 }, (_, i) => op(i)) });
await sleep(500);
const limit = big.inbox.find((m) => m.t === 'limit');
check('1600 new elements: the last 100 are refused and named', limit && limit.reason === 'elements' && limit.rejected.length === 100 && limit.max === 1500, JSON.stringify(limit)?.slice(0, 120));
const again = await room(`${made[1].id}/${made[1].diagrams[0].id}`);
check('exactly 1500 were stored', again.inbox[0].elements.filter((e) => !e.deleted).length === 1500);
big.ws.close(); again.ws.close();

// ---- message size ----------------------------------------------------------------------------------------------------------------------
const huge = await room(`${made[2].id}/${made[2].diagrams[0].id}`);
huge.send(JSON.stringify({ t: 'ops', ops: [{ ...op(1), pa: 'x'.repeat(1100 * 1024) }] }));
await sleep(500);
check('a message over 1 MB is refused with an explanation', huge.inbox.some((m) => m.t === 'error' && /too large/.test(m.message)));
huge.ws.close();

// ---- 30 people per diagram -----------------------------------------------------------------------------------------------------------------
const crowd = [];
for (let i = 0; i < 30; i++) crowd.push(await room(`${made[3].id}/${made[3].diagrams[0].id}`));
const extra = await room(`${made[3].id}/${made[3].diagrams[0].id}`);
check('30 people fit', crowd.every((c) => c.inbox[0]?.t === 'hello'));
check('the 31st is told the diagram is full', extra.inbox[0]?.t === 'full' && /30 people/.test(extra.inbox[0].message), JSON.stringify(extra.inbox[0]));
crowd.forEach((c) => c.ws.close());

console.log(failures ? failures + ' check(s) FAILED' : 'all checks passed');
process.exit(failures ? 1 : 0);
