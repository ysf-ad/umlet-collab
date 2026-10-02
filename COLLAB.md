# Collaborative UMLetino

A fork of [UMLet](https://github.com/umlet/umlet) whose web version (UMLetino) supports real-time collaboration: several people edit the same diagram, see each other's cursors, and see moves, resizes and text edits as they happen. Diagrams are still plain `.uxf` files.

## Run it locally

Requirements: JDK 11+ (tested with 17), Maven 3.9, Node 18+.

```bash
mvn -pl umlet-res,umlet-web -am install -DskipTests   # first build (about 1 min)
cd collab-server && npm install && npm start          # http://localhost:8080
```

Open `http://localhost:8080/?room=demo` in two browser windows. Without `?room=` a random room is created and added to the URL, so you can share the link.

After changing only Java code in `umlet-gwt`/`umlet-web`, rebuild with `mvn -o -pl umlet-gwt,umlet-web install -DskipTests`. `collab.js` and the server need no build step. Run `npm test` in `collab-server/` for the relay tests.

## How it works

Sync works like Excalidraw's: last writer wins per element, and there is no CRDT.

- **Element identity.** `CollabBridge` gives every element a random id. The id lives in memory only, so exported `.uxf` files are unchanged.
- **Detecting changes.** UMLet already calls `DrawPanelDiagram.handleFileUpdate()` after every edit (for the VS Code plugin). The fork also notifies on every redraw and during drags. Then `collab.js` takes a snapshot of all elements and diffs it against the last known state. Only changed elements are sent, so no individual mutation points needed hooking.
- **Versions.** A local change bumps the element's `version` and picks a random `nonce`. A remote record replaces the local one only if its version is higher; equal versions are decided by the lower nonce. Clients and server all use the same rule, so everyone converges. Deletions are tombstones.
- **Applying in place.** Remote changes update the existing Java objects instead of replacing the diagram. Your selection, the properties panel and the text caret survive, and an element you are dragging is never moved under your mouse.
- **Zoom and pan stay local.** UMLet has no camera: zooming, panning and canvas realignment move all elements. `DrawPanel` wraps those operations in `beginViewChange()`/`endViewChange()`. The bridge absorbs the shift into a per-user view offset and does not broadcast it. Shared coordinates are always at the default zoom level.
- **Relay.** `collab-server/server.js` is a small Node websocket server with rooms. It keeps the newest version of every element per room, so late joiners get the diagram immediately. It also serves the app.

### Where the code is

| File | Purpose |
| --- | --- |
| `umlet-web/.../collab/CollabBridge.java` | ids, normalized snapshot, apply remote records, view offset |
| `umlet-web/src/main/webapp/collab.js` | websocket client, diff + versions, cursors |
| `umlet-web/.../file/WebFileChangeNotifier.java` | GWT → JS change notifications |
| `umlet-web/.../view/WebDrawPanelDiagram.java` | announces whole-diagram replacement (import, `?uxf=`) |
| `umlet-gwt/.../view/DrawPanel.java`, `DrawPanelDiagram.java` | drag/redraw notifications, view-change hooks |
| `collab-server/` | relay server and tests |

## Known limitations

- Last writer wins per element. If two people type in the same element at once, one person's keystrokes can overwrite the other's (Yjs would fix this).
- There is no undo/redo in UMLetino, so there is no per-user undo either.
- Rooms live in server memory only and are dropped 10 minutes after the last person leaves.
- There is no auth: anyone with the room link can edit.
- Paste could not be tested in the test browser (clipboard access); it uses the same add path as the palette.

## License

GPL-3.0, like UMLet itself. See `LICENCE.txt`.
