# UMLet Collab

Draw UML diagrams together, live. A fork of [UMLet](https://github.com/umlet/umlet) whose web version (UMLetino) is a real-time collaborative editor. No accounts, no sign-up: make a project, send the link, and everyone with it edits the same diagrams at the same time.

**Live:** https://umlet.yousifaldakoki.com

## What it does

- **Projects with tabs.** A project holds up to 40 diagrams. Add, rename, reorder (drag), delete and restore them.
- **Live editing.** See each other's cursors and selections. Moves, resizes and relation edits appear as they happen, and typing in the same element merges character by character.
- **Autosave and history.** Everything is saved on the server as you work, with version history per diagram. Import and export are plain `.uxf` files, plus png, pdf and svg.
- **Private by default.** Projects aren't listed anywhere. Only people who have the link can find a project, so share it with care. Each browser remembers the projects it has opened.
- **Housekeeping.** Projects nobody opens for 2 months are deleted, and deleted projects are erased for good after 30 days. Until then they can be restored from their link.

## How it works

The editor is the original UMLet GWT code, with a small bridge (`CollabBridge`) that syncs elements. Geometry uses last-writer-wins versions, and text uses [Yjs](https://yjs.dev). The server is a Cloudflare Worker with Durable Objects: one per diagram, one per project, and one directory for quotas and cleanup. It runs on the free plan. A plain Node relay (`collab-server/server.js`) is included for local use.

Details of the design, hosting limits, captcha and expiry are in [COLLAB.md](COLLAB.md).

## Run it locally

Requirements: JDK 11+ (tested with 17), Maven 3.9, Node 18+.

```bash
mvn -pl umlet-res,umlet-web -am install -DskipTests   # first build, about a minute
cd collab-server
npm install
npm run build     # assembles dist/: web files, GWT output, Yjs bundle
npm run dev       # Cloudflare Worker locally, http://localhost:8787
npm test          # server tests
```

Open the page, create a project, and open it in two browser windows.

## Deploy

```bash
cd collab-server
npm run build
npx wrangler deploy
```

Limits (5 new projects per network per 30 days, 40 diagrams per project, and so on) and the optional Turnstile captcha are described in [COLLAB.md](COLLAB.md#hosting-it-for-everyone).

## Credits and licence

Based on [UMLet](https://github.com/umlet/umlet) by the UMLet team and UMLetino at [umletino.com](https://www.umletino.com). The licence is in [LICENCE.txt](LICENCE.txt) (GPL, as upstream). The rest of the UMLet repository (Eclipse plugin, standalone app, VS Code extension) is unchanged and documented upstream.
