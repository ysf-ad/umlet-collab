// Read-only backup of every project and diagram on a collaboration server. Usage: node scripts/backup.js <baseUrl> <outFile>
// Only listens: it opens each project and diagram socket, saves what the server sends on join, and never sends anything.
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';

const [base = 'https://umlet.yousifaldakoki.com', out = 'backup.json'] = process.argv.slice(2);
const wsBase = base.replace(/^http/, 'ws');

function firstMessage(url, accept) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const timer = setTimeout(() => { ws.terminate(); reject(new Error('timeout ' + url)); }, 15000);
		ws.on('message', (raw) => { const m = JSON.parse(raw); if (accept(m)) { clearTimeout(timer); ws.close(); resolve(m); } });
		ws.on('error', (e) => { clearTimeout(timer); reject(e); });
	});
}

const projects = await (await fetch(base + '/api/projects')).json();
const backup = { at: new Date().toISOString(), base, projects: [] };
for (const p of projects) {
	const meta = await firstMessage(`${wsBase}/project?id=${p.id}`, (m) => m.t === 'project');
	const entry = { project: meta.project, diagrams: [] };
	for (const d of meta.project.diagrams.concat(meta.project.trash || [])) {
		const hello = await firstMessage(`${wsBase}/collab?room=${encodeURIComponent(p.id + '/' + d.id)}`, (m) => m.t === 'hello');
		entry.diagrams.push({ id: d.id, name: d.name, hello });
		console.log(`${p.name} / ${d.name}: ${(hello.elements || []).length} elements`);
	}
	backup.projects.push(entry);
}
writeFileSync(out, JSON.stringify(backup));
console.log('saved', out);
