# Collaborative UMLetino

A fork of [UMLet](https://github.com/umlet/umlet) whose web version (UMLetino) supports real-time collaboration. Several people can edit the same diagram at once and see:
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

Open `http://localhost:8787/?room=demo` in two browser windows. Without `?room=` a random room is created and added to the URL, so you can share the link.

After Java changes in `umlet-gwt`/`umlet-web`, run `mvn -o -pl umlet-gwt,umlet-web install -DskipTests` and then `npm run build`. Run `npm test` in `collab-server/` for the relay and merge tests.

## Deploy to Cloudflare (free plan)

```bash
cd collab-server
npx wrangler login   # once, opens the browser to log in to your Cloudflare account
npm run deploy       # build dist/ and deploy; prints the https://umletino-collab.<you>.workers.dev URL
```

What runs where:
- **Static app** (`dist/`): Workers Static Assets. Requests for static files are free.
- **One Durable Object per room** (`src/worker.js`): relays messages over hibernatable websockets, so idle rooms cost nothing. Room state is saved to the object's SQLite storage at most once a second, and immediately when the last person leaves. Rooms therefore survive restarts and deploys.
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
| `collab-server/src/room.js` | room state and merge rules (shared by both servers) |
| `collab-server/src/worker.js`, `wrangler.jsonc` | Cloudflare Worker + Durable Object |
| `collab-server/server.js` | Node relay for local use/self-hosting (in-memory rooms) |

## Known limitations

- There is no undo/redo in UMLetino, so there is no per-user undo either.
- There is no auth: anyone with the room link can edit it.
- If two people change the same element's geometry at the same moment, one change wins; text is merged instead.
- The Node relay keeps rooms in memory only (dropped 10 minutes after the last person leaves). The Cloudflare version persists them.

## License

GPL-3.0, like UMLet itself. See `LICENCE.txt`. If you distribute it, keep the source available.
