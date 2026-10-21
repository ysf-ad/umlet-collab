// End-to-end check of project expiry against a LOCAL Worker. Usage: node scripts/expiry-check.js [baseUrl]
//   start one first, with short retention so the check takes seconds, not months:
//     .dev.vars:  INACTIVE_MS=6000  DELETED_MS=6000  (plus the dummy Turnstile keys, see limits-check.js)
//     npx wrangler dev --port 8799 --test-scheduled
// The sweep that runs hourly in production is triggered by hand through wrangler's /cdn-cgi/handler/scheduled.
import WebSocket from 'ws';

const base = process.argv[2] || 'http://localhost:8799';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error('local servers only');
const wsBase = base.replace(/^http/, 'ws');
const WINDOW_MS = 6000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : '  ' + detail)); if (!ok) failures++; };

let fakeAddress = Math.floor(Math.random() * 200) + 20; // each project comes from its own made-up network, so the creation quota stays out of the way
const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.' + fakeAddress++ + '.1' }, body: JSON.stringify(body || {}) });
const create = async (name) => (await post('/api/projects', { name, token: 'x' })).json();
const lookup = async (ids) => (await (await post('/api/projects/lookup', { ids })).json());
const sweep = async () => { const r = await fetch(base + '/cdn-cgi/handler/scheduled'); if (!r.ok) throw new Error('sweep trigger failed: ' + r.status + ' (is wrangler running with --test-scheduled?)'); await sleep(1500); };

function open(url, ms = 300) {
	return new Promise((resolve) => {
		const ws = new WebSocket(url);
		const inbox = [];
		ws.on('message', (m) => inbox.push(JSON.parse(m)));
		ws.on('error', () => {});
		ws.on('open', () => setTimeout(() => resolve({ ws, inbox, send: (m) => ws.send(JSON.stringify(m)) }), ms));
		ws.on('close', () => setTimeout(() => resolve({ ws, inbox, closed: true }), 50));
	});
}
const diagramLoads = async (projectId, diagramId) => {
	const c = await open(`${wsBase}/collab?room=${projectId}/${diagramId}`);
	const loaded = c.inbox.some((m) => m.t === 'hello');
	try { c.ws.close(); } catch { /* closed */ }
	return loaded;
};

const [a, b, c] = [await create('inactive'), await create('visited'), await create('big')];
const big = await open(`${wsBase}/project?id=${c.id}`);
for (let i = 0; i < 39; i++) { big.send({ t: 'add' }); await sleep(30); }
await sleep(300);
const first = big.inbox.filter((m) => m.t === 'project').pop().project;
for (const d of first.diagrams.slice(1, 11)) { big.send({ t: 'remove', id: d.id }); await sleep(30); } // 10 into the trash
for (let i = 0; i < 10; i++) { big.send({ t: 'add' }); await sleep(30); }
await sleep(300);
const bigView = big.inbox.filter((m) => m.t === 'project').pop().project;
const bigIds = bigView.diagrams.map((d) => d.id).concat(bigView.trash.map((d) => d.id));
check('the big project has 50 diagrams, 10 of them deleted', bigView.diagrams.length === 40 && bigView.trash.length === 10, bigView.diagrams.length + '/' + bigView.trash.length);
big.ws.close();

// b stays open and keeps announcing itself, like a real tab
const tab = await open(`${wsBase}/project?id=${b.id}`);
const beat = setInterval(() => { try { tab.send({ t: 'viewing', diagram: b.diagrams[0].id, name: 'Tab', color: '#00f', visitor: 'tabtabtab12345' }); } catch { /* closed */ } }, 1000);

await sweep();
let found = await lookup([a.id, b.id, c.id]);
check('right after creation nothing expires', found.length === 3 && found.every((p) => !p.deleted), JSON.stringify(found.map((p) => p.deleted)));

await sleep(WINDOW_MS + 1500);
await sweep();
found = Object.fromEntries((await lookup([a.id, b.id, c.id])).map((p) => [p.id, p]));
check('an unopened project is moved to recently deleted', found[a.id] && found[a.id].deleted === true, JSON.stringify(found[a.id]));
check('the deleted project says when it will be erased', found[a.id] && found[a.id].erasesAt > found[a.id].deletedAt, JSON.stringify(found[a.id]));
check('a project someone keeps open is kept', found[b.id] && found[b.id].deleted === false, JSON.stringify(found[b.id]));
check('deleting by inactivity keeps the data (restorable)', await diagramLoads(a.id, a.diagrams[0].id));

const restored = await post(`/api/projects/${a.id}/restore`);
check('an expired project can be restored from its link', restored.ok && (await lookup([a.id]))[0].deleted === false);

// c was deleted too; after the deleted window it is erased, 40 diagrams per sweep
await sleep(WINDOW_MS + 1500);
await sweep(); // c: erase starts
const afterFirst = await lookup([c.id]);
check('an erasing project is no longer listed', afterFirst.length === 0, JSON.stringify(afterFirst));
const noRestore = await post(`/api/projects/${c.id}/restore`);
check('an erasing project can no longer be restored', noRestore.status === 410 || noRestore.status === 404, String(noRestore.status));
check('its first diagrams are gone', !(await diagramLoads(c.id, bigIds[0])));
await sweep(); // the remaining 10 diagrams
check('its last diagrams are gone after the next sweep', !(await diagramLoads(c.id, bigIds[49])));
check('the erased project is really gone', (await lookup([c.id])).length === 0 && !(await post(`/api/projects/${c.id}/restore`)).ok);

found = Object.fromEntries((await lookup([a.id, b.id])).map((p) => [p.id, p]));
check('the visited project is still live after all of it', found[b.id] && found[b.id].deleted === false);
check('the restored project went back to the inactive clock (deleted again, not erased)', found[a.id] && found[a.id].deleted === true);

clearInterval(beat);
tab.ws.close();
console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
