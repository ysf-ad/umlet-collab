// Assembles dist/ (served by server.js locally and by Cloudflare Workers Static Assets in production):
//   - umlet-web/src/main/webapp/* (umletino.html becomes index.html, the umletino.com landing page is skipped)
//   - the GWT-compiled app from umlet-web/target/umlet-web-<version>/umletweb (run the Maven build first)
//   - vendor/yjs.js: Yjs bundled as a browser global (window.Y) for collab.js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, '..', 'umlet-web');
const dist = path.join(root, 'dist');
const MAX_ASSET_BYTES = 25 * 1024 * 1024; // Cloudflare static asset limit per file

const target = path.join(web, 'target');
const versionDir = fs.existsSync(target) && fs.readdirSync(target).find((d) => /^umlet-web-[\d.]+(-SNAPSHOT)?$/.test(d));
const gwtOut = versionDir && path.join(target, versionDir, 'umletweb');
if (!gwtOut || !fs.existsSync(gwtOut)) {
	console.error('GWT output not found. Build it first: mvn -pl umlet-res,umlet-web -am install -DskipTests');
	process.exit(1);
}

// empty dist/ instead of deleting it: a running `wrangler dev` keeps the directory itself locked on Windows
fs.mkdirSync(dist, { recursive: true });
for (const entry of fs.readdirSync(dist)) fs.rmSync(path.join(dist, entry), { recursive: true, force: true });

const webapp = path.join(web, 'src', 'main', 'webapp');
for (const entry of fs.readdirSync(webapp)) {
	if (entry === 'WEB-INF' || entry === 'index.html') continue;
	fs.cpSync(path.join(webapp, entry), path.join(dist, entry === 'umletino.html' ? 'index.html' : entry), { recursive: true });
}
const index = path.join(dist, 'index.html');
fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace('${build.time.urlsafe}', Date.now().toString(36)));
fs.cpSync(gwtOut, path.join(dist, 'umletweb'), { recursive: true });

await esbuild.build({
	stdin: { contents: "export * from 'yjs';", resolveDir: root },
	bundle: true,
	minify: true,
	format: 'iife',
	globalName: 'Y',
	outfile: path.join(dist, 'vendor', 'yjs.js'),
	logLevel: 'warning',
});

let files = 0;
(function check(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) check(p);
		else if (++files && fs.statSync(p).size > MAX_ASSET_BYTES) throw new Error(`${p} is larger than 25 MiB`);
	}
})(dist);
console.log(`dist/ ready (${files} files)`);
