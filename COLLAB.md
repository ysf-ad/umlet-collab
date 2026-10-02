# Collaborative UMLetino

A fork of [UMLet](https://github.com/umlet/umlet) whose web version (UMLetino) supports real-time collaboration.

**Projects.** The landing page lists every project. A project holds several diagrams, shown as tabs above the editor. Anyone can:
- add a diagram (+)
- rename a diagram or the project (double-click)
- reorder diagrams (drag a tab)
- delete a diagram (×)

The tab bar also shows a coloured dot for each person viewing a diagram. Everything is public to whoever has the link; there are no accounts.

**In each diagram**, several people can edit at once and see:
- each other's cursors and selections
- moves, resizes and relation edits as they happen
- concurrent typing in the same element merged character by character

Diagrams are still plain `.uxf` files.

## Run it locally

Requirements: JDK 11+ (tested with 17), Maven 3.9, Node 18+.

```bash
mvn -pl umlet-res,umlet-web -am install -DskipTests   # first build (about 1 min)
cd collab-server
npm install
npm run build        # assembles dist/: webapp files + GWT output + Yjs bundle
npm run dev          # Cloudflare Worker locally (wrangler dev), http://localhost:8787
# or: npm start      # plain Node relay, http://localhost:8080
```

Open `http://localhost:8787/`, create a project and open it in two browser windows. Single diagrams without a project still work: `app.html?room=<name>`.

On Windows, `wrangler dev` can crash with `SQLITE_BUSY` when the repository is inside a synced folder (OneDrive). That is the local dev storage only; just restart it.

After Java changes in `umlet-gwt`/`umlet-web`, run `mvn -o -pl umlet-gwt,umlet-web install -DskipTests` and then `npm run build`. Run `npm test` in `collab-server/` for the relay and merge tests.

## Deploy to Cloudflare (free plan)

```bash
cd collab-server
npx wrangler login   # once, opens the browser to log in to your Cloudflare account
npm run deploy       # build dist/ and deploy; prints the https://umletino-collab.<you>.workers.dev URL
```

What runs where:
- **Static app** (`dist/`): Workers Static Assets. Requests for static files are free. `index.html` is the project list and `app.html` is the editor.
- **Project** Durable Object, one per project: holds the diagram list, broadcasts changes and tracks who views which tab. **Directory** Durable Object, a single instance: the project list for the landing page.
- **One Durable Object per diagram room** (`<projectId>/<diagramId>`) (`src/worker.js`): relays messages over hibernatable websockets, so idle rooms cost nothing. Room state is saved to the object's SQLite storage at most once a second, and immediately when the last person leaves. Rooms therefore survive restarts and deploys.
- **Free plan limits:** 100k Durable Object requests/day, with incoming websocket messages counted 20:1, and 100k storage rows written/day. That is plenty for demos and small teams. On the free plan, going over a limit makes requests fail until the next day; it never charges you.

## How it works

| What | How it syncs |
| --- | --- |
| Geometry, type, relation points | Per element `{version, nonce}`, last writer wins (like Excalidraw). Higher version wins; ties go to the lower nonce. Clients and server use the same rule (`src/room.js`), so everyone converges. Deletions are tombstones. |
| Element text | One `Y.Text` per element in a shared Yjs document, so concurrent typing merges. The local caret is shifted through remote edits. A keystroke that is still in flight is merged, not overwritten. |
| Cursors, selections | Ephemeral `presence` messages, never stored. Remote selections are drawn as dashed boxes in the other user's colour. |

- **Element identity.** `CollabBridge` gives every element a random id. The id lives in memory only, so exported `.uxf` files are unchanged.
- **Detecting changes.** UMLet already calls `DrawPanelDiagram.handleFileUpdate()` after edits (for the VS Code plugin). The fork also notifies on every redraw and during drags. `collab.js` then takes a snapshot of all elements and diffs it against the last known state. Only changes are sent, so no individual mutation points needed hooking.
- **Applying in place.** Remote changes update the existing Java objects. Your selection, the properties panel and the caret survive, and an element you are dragging is never moved under your mouse.
- **Zoom and pan stay local.** UMLet has no camera: zooming, panning and canvas realignment move all elements. `DrawPanel` wraps those operations in `beginViewChange()`/`endViewChange()`. The bridge absorbs the shift into a per-user view offset and does not broadcast it. Shared coordinates are always at the default zoom level.
- **Offline.** If the connection drops, edits continue locally. Text merges on reconnect; geometry is diffed against the last known state and sent.

### Where the code is

| File | Purpose |
| --- | --- |
| `umlet-web/.../collab/CollabBridge.java` | ids, normalized snapshot, apply remote records, view offset, selection/rect lookups |
| `umlet-web/src/main/webapp/collab.js` | websocket client, diff + versions, Yjs text, cursors and selections |
| `umlet-web/.../file/WebFileChangeNotifier.java` | GWT → JS change notifications |
| `umlet-web/.../view/WebDrawPanelDiagram.java` | announces whole-diagram replacement (import, `?uxf=`) |
| `umlet-gwt/.../view/DrawPanel.java`, `DrawPanelDiagram.java` | drag/redraw notifications, view-change hooks |
| `umlet-web/src/main/webapp/projectbar.js` | project tab bar (add/rename/reorder/delete diagrams, who is where) |
| `umlet-web/src/main/webapp/projects.html` | landing page: project list, create/delete projects |
| `collab-server/src/room.js` | room state and merge rules (shared by both servers) |
| `collab-server/src/project.js` | project and directory logic (shared by both servers) |
| `collab-server/src/worker.js`, `wrangler.jsonc` | Cloudflare Worker + Durable Object |
| `collab-server/server.js` | Node relay for local use/self-hosting (in-memory rooms) |

## Known limitations

- There is no undo/redo in UMLetino, so there is no per-user undo either.
- There is no auth (by design for an internal tool): anyone with the URL can see every project and edit or delete it.
- Deleting a diagram or project only hides it; the data stays in storage, but there is no restore button yet.
- If two people change the same element's geometry at the same moment, one change wins; text is merged instead.
- The Node relay keeps rooms in memory only (dropped 10 minutes after the last person leaves). The Cloudflare version persists them.

## License

GPL-3.0, like UMLet itself. See `LICENCE.txt`. If you distribute it, keep the source available.
