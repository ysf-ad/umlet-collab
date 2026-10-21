// Read-only backup of projects and their diagrams on a collaboration server.
// Usage: node scripts/backup.js <baseUrl> <outFile> [projectId ...]
// The server has no list of projects (a project id is its only protection), so the ids come from the command line, or
// from ../backups/project-ids.txt (one per line) when none are given.
// Only listens: it opens each project and diagram socket, saves what the server sends on join, and never sends anything.
import WebSocket from 'ws';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const [base = 'https://umlet.yousifaldakoki.com', out = 'backup.json', ...argIds] = process.argv.slice(2);
const wsBase = base.replace(/^http/, 'ws');
const idsFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'backups', 'project-ids.txt');
const ids = argIds.length ? argIds : existsSync(idsFile) ? readFileSync(idsFile, 'utf8').split(/\s+/).filter(Boolean) : [];
if (!ids.length) throw new Error('no project ids: pass them as arguments or list them in backups/project-ids.txt');

function firstMessage(url, accept) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const timer = setTimeout(() => { ws.terminate(); reject(new Error('timeout ' + url)); }, 15000);
		ws.on('message', (raw) => { const m = JSON.parse(raw); if (accept(m)) { clearTimeout(timer); ws.close(); resolve(m); } });
		ws.on('error', (e) => { clearTimeout(timer); reject(e); });
	});
}

const backup = { at: new Date().toISOString(), base, projects: [] };
for (const id of [...new Set(ids)]) {
	const meta = await firstMessage(`${wsBase}/project?id=${id}`, (m) => m.t === 'project' || m.t === 'rejected');
	if (!meta.project) { console.log(id + ': not found (skipped)'); continue; }
	const entry = { project: meta.project, diagrams: [] };
	for (const d of meta.project.diagrams.concat(meta.project.trash || [])) {
		const hello = await firstMessage(`${wsBase}/collab?room=${encodeURIComponent(id + '/' + d.id)}`, (m) => m.t === 'hello');
		entry.diagrams.push({ id: d.id, name: d.name, hello });
		console.log(`${meta.project.name} / ${d.name}: ${(hello.elements || []).length} elements`);
	}
	backup.projects.push(entry);
}
writeFileSync(out, JSON.stringify(backup));
console.log('saved', out);
