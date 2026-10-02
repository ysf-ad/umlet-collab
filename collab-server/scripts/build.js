// Assembles dist/ (served by server.js locally and by Cloudflare Workers Static Assets in production):
//   - umlet-web/src/main/webapp/* (projects.html becomes the landing page index.html, the editor umletino.html
//     becomes app.html; the original umletino.com index.html is skipped)
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
	const renamed = { 'umletino.html': 'app.html', 'projects.html': 'index.html' };
	fs.cpSync(path.join(webapp, entry), path.join(dist, renamed[entry] || entry), { recursive: true });
}
const app = path.join(dist, 'app.html');
// version stamp on every script so browsers never keep running an old collab.js/projectbar.js after a deploy
const stamp = Date.now().toString(36);
fs.writeFileSync(app, fs.readFileSync(app, 'utf8')
	.replace('${build.time.urlsafe}', stamp)
	.replace(/(src|href)="(vendor\/[^"?]+|collab\.js|projectbar\.js)"/g, '$1="$2?v=' + stamp + '"'));
const index = path.join(dist, 'index.html');
fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace(/(src|href)="(vendor\/[^"?]+)"/g, '$1="$2?v=' + stamp + '"'));
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

// Shoelace (MIT) UI components for the project bar and project list: one bundle, two themes, the icons we use
const SHOELACE_ICONS = ['chevron-left', 'chevron-down', 'plus-lg', 'x-lg', 'check2', 'pencil', 'grid', 'trash3', 'arrow-counterclockwise',
	'sun', 'moon', 'link-45deg', 'folder2', 'person', 'search'];
const shoelace = path.join(root, 'node_modules', '@shoelace-style', 'shoelace', 'dist');
const shoelaceOut = path.join(dist, 'vendor', 'shoelace');
await esbuild.build({
	entryPoints: [path.join(root, 'scripts', 'shoelace-entry.js')],
	bundle: true,
	minify: true,
	format: 'iife',
	outfile: path.join(shoelaceOut, 'shoelace.js'),
	logLevel: 'warning',
});
fs.mkdirSync(path.join(shoelaceOut, 'themes'), { recursive: true });
for (const theme of ['light.css', 'dark.css']) fs.copyFileSync(path.join(shoelace, 'themes', theme), path.join(shoelaceOut, 'themes', theme));
fs.mkdirSync(path.join(shoelaceOut, 'assets', 'icons'), { recursive: true });
for (const icon of SHOELACE_ICONS) fs.copyFileSync(path.join(shoelace, 'assets', 'icons', icon + '.svg'), path.join(shoelaceOut, 'assets', 'icons', icon + '.svg'));

let files = 0;
(function check(dir) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) check(p);
		else if (++files && fs.statSync(p).size > MAX_ASSET_BYTES) throw new Error(`${p} is larger than 25 MiB`);
	}
})(dist);
console.log(`dist/ ready (${files} files)`);
