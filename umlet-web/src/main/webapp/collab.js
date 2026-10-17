// Collaboration client for UMLetino.
//
// GWT side (see CollabBridge.java / WebFileChangeNotifier.java):
//   umletCollab.onLocalChange(live)        called by GWT after every local change (live=true: on redraw/drag, maybe nothing changed; throttled)
//   umletCollabSnapshot()                  -> [{id, type, x, y, w, h, pa, aa}] all elements at default zoom
//   umletCollabApply(records, replaceAll)  applies remote records in place
//   umletCollabView()                      -> {zoom, x, y}: zoom level (grid size, default 10) and local view offset in px
//   umletCollabSelection()                 -> ids of the selected elements
//   umletCollabPropertiesId()              -> id of the element shown in the properties panel ('_diagram' if none)
//   umletCollabRect(id)                    -> local canvas rectangle {x, y, w, h} of an element
//   umletCollabCanvas()                    -> the diagram's <canvas> element
//
// Sync model:
// - geometry/type/relation points: per element {version, nonce}, last writer wins (Excalidraw style). A remote record
//   replaces the local one only if its version is higher (ties: lower nonce), so all clients converge.
// - element text (panel attributes): one Y.Text per element in a shared Yjs document, so concurrent typing merges.
// - presence (cursor + selection): ephemeral, never stored.
//
// Rooms: ?room=<name> joins that room. In a project (?project=..., see projectbar.js) the project bar picks the
// room per diagram tab and calls umletCollab.switchRoom(); switching keeps the page (no GWT reload).
(function () {
	var DEFAULT_ZOOM = 10;
	var LIVE_INTERVAL_MS = 33; // ~30 Hz for drags, cursors and selection
	var REMOTE = 'remote';     // Yjs transaction origin for updates received from the server

	// without ?room= (a standalone diagram) the project bar chooses the room, or sends the user to the project list
	var room = new URLSearchParams(location.search).get('room');

	// display name and colour are remembered per browser (storage may be unavailable, e.g. in private windows)
	function stored(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
	function store(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* not remembered */ } }
	// distinct colours that keep white labels readable; the project bar makes sure people in a project don't share one
	var COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0aa4c2', '#f032e6', '#469990', '#9a6324', '#800000', '#808000', '#000075'];
	var me = {
		id: null,
		color: stored('umletcollab.color') || COLORS[Math.floor(Math.random() * COLORS.length)],
		name: stored('umletcollab.name') || 'User ' + Math.floor(Math.random() * 90 + 10)
	};
	store('umletcollab.color', me.color);

	var ws = null;
	var ready = false;        // GWT exported its functions
	var serverState = null;   // element records from the last 'hello' that are not applied yet (Map)
	var synced = false;       // initial state has been exchanged; local changes may be sent
	var everSynced = false;
	var applying = false;     // true while applying remote changes (prevents echo)
	var known = new Map();    // id -> record incl. version, nonce, deleted
	// id -> {rec, c}: how an applied record looks in the local snapshot. Placing an element can nudge it (autoresize
	// re-centers actors on the grid of the local zoom level), and that nudge must not be sent back as an edit, or the
	// element drifts a grid step every time the diagram is opened. Only changes from this local look are edits.
	var applied = new Map();
	var liveTimer = null;
	var lastLiveFlush = 0;
	var offlineChanges = false; // local edits made while disconnected that the server hasn't received yet

	var ydoc, texts; // texts: element id -> Y.Text (one document per room, see initDoc)

	function rand() { return Math.floor(Math.random() * 2147483647); }
	// text is synced through Yjs, so it is not part of the last-writer-wins content
	function content(r) { return JSON.stringify([r.type, r.x, r.y, r.w, r.h, r.aa, !!r.deleted]); }
	function wins(op, cur) {
		return !cur || op.version > cur.version || (op.version === cur.version && op.nonce < cur.nonce);
	}
	function textOf(id) {
		var t = texts.get(id);
		return t ? t.toString() : null;
	}
	function withText(rec) {
		var text = textOf(rec.id);
		if (text === null || rec.deleted) return rec;
		var copy = {};
		for (var k in rec) copy[k] = rec[k];
		copy.pa = text;
		return copy;
	}
	function toBase64(bytes) {
		var s = '';
		for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		return btoa(s);
	}
	function fromBase64(b64) {
		var s = atob(b64), bytes = new Uint8Array(s.length);
		for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
		return bytes;
	}
	// smallest edit (common prefix/suffix) that turns the Y.Text into value, so concurrent edits elsewhere survive
	function setText(ytext, value) {
		var old = ytext.toString();
		if (old === value) return;
		var start = 0;
		while (start < old.length && start < value.length && old[start] === value[start]) start++;
		var end = 0;
		while (end < old.length - start && end < value.length - start && old[old.length - 1 - end] === value[value.length - 1 - end]) end++;
		if (old.length - start - end > 0) ytext.delete(start, old.length - start - end);
		if (value.length - start - end > 0) ytext.insert(start, value.slice(start, value.length - end));
	}

	function send(msg) {
		if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
	}


	// ---- local -> remote -------------------------------------------------------
	// While offline (after the first sync) text edits still go into the Yjs document, so they merge with the
	// others' edits on reconnect. Geometry changes are diffed against the last known state when reconnected.
	function flush() {
		if (!(synced || (everSynced && ready)) || applying) return;
		clearTimeout(liveTimer);
		liveTimer = null;
		lastLiveFlush = Date.now();
		var snapshot = window.umletCollabSnapshot();
		var ops = [];
		var present = new Set();
		ydoc.transact(function () {
			for (var i = 0; i < snapshot.length; i++) {
				var r = snapshot[i];
				present.add(r.id);
				var cur = known.get(r.id);
				var t = texts.get(r.id);
				if (t) setText(t, r.pa);
				else if (!cur || cur.deleted || cur.pa !== r.pa) texts.set(r.id, new Y.Text(r.pa));
				if (!synced || (cur && !cur.deleted && (content(cur) === content(r) || appliedLook(r.id, cur) === content(r)))) continue;
				// pa is included so a late joiner can create the element even before its text arrives
				var op = { id: r.id, type: r.type, x: r.x, y: r.y, w: r.w, h: r.h, pa: r.pa, aa: r.aa, deleted: false, version: (cur ? cur.version : 0) + 1, nonce: rand() };
				known.set(op.id, op);
				ops.push(op);
			}
			if (synced) known.forEach(function (cur, id) {
				if (!cur.deleted && !present.has(id)) {
					var op = { id: id, deleted: true, version: cur.version + 1, nonce: rand() };
					known.set(id, op);
					ops.push(op);
					texts.delete(id);
				}
			});
		});
		if (ops.length) send({ t: 'ops', ops: ops });
		sendPresence(false);
		scheduleRender();
	}

	function appliedLook(id, rec) {
		var a = applied.get(id);
		return a && a.rec === rec ? a.c : null;
	}

	function onLocalChange(live) {
		scheduleRender();
		if (applying || !everSynced) return;
		if (!synced) offlineChanges = true;
		if (!live) return flush();
		// always async, so GWT finishes the current operation first (e.g. palette double click adds, then moves the element)
		if (!liveTimer) liveTimer = setTimeout(flush, Math.max(0, LIVE_INTERVAL_MS - (Date.now() - lastLiveFlush)));
	}

	// ---- remote -> local -------------------------------------------------------
	function focusedTextarea() {
		var ae = document.activeElement;
		return ae && ae.tagName === 'TEXTAREA' ? ae : null;
	}

	// caretDelta: Yjs delta of a remote edit to the text being edited locally, used to shift the caret like a real editor
	function applyRecords(records, replaceAll, caretDelta) {
		var ta = focusedTextarea();
		var caret = ta ? { start: ta.selectionStart, end: ta.selectionEnd, value: ta.value } : null;
		applying = true;
		try { window.umletCollabApply(records, replaceAll); } finally { applying = false; }
		var snapshot = window.umletCollabSnapshot();
		var ids = new Set(records.map(function (r) { return r.id; }));
		snapshot.forEach(function (r) {
			var rec = known.get(r.id);
			if (ids.has(r.id) && rec && !rec.deleted) applied.set(r.id, { rec: rec, c: content(r) });
		});
		if (caret && ta.value !== caret.value) {
			var start = caret.start, end = caret.end;
			if (caretDelta) {
				start = transformIndex(start, caretDelta);
				end = transformIndex(end, caretDelta);
			}
			var len = ta.value.length;
			ta.focus();
			ta.setSelectionRange(Math.min(start, len), Math.min(end, len));
		}
		// applying may make GWT realign elements (redraw(true)); propagate that like any other local change
		onLocalChange(true);
	}

	// ---- insert a .uxf file into the current diagram (merge, unlike File Import which replaces it) ------------
	// Elements get fresh ids and are placed as a group to the right of what is already there, then added like a
	// remote change; the next flush() sees them as new local elements and sends them to everyone.
	var DEFAULT_ZOOM = 10;
	function newId() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
	function childText(node, name) {
		var c = node.getElementsByTagName(name)[0];
		return c ? c.textContent : '';
	}
	function parseUxf(text) {
		var doc = new DOMParser().parseFromString(text, 'application/xml');
		if (doc.getElementsByTagName('parsererror').length || !doc.getElementsByTagName('diagram').length) throw new Error('not a UMLet (.uxf) file');
		var zoom = parseInt(childText(doc.documentElement, 'zoom_level'), 10) || DEFAULT_ZOOM;
		var f = DEFAULT_ZOOM / zoom; // records are at the default zoom level
		var out = [];
		out.help = childText(doc.documentElement, 'help_text');
		var els = doc.getElementsByTagName('element');
		for (var i = 0; i < els.length; i++) {
			var e = els[i];
			var type = childText(e, 'id');
			var aa = childText(e, 'additional_attributes');
			// relation points are stored at the file's zoom level, like the coordinates
			if (type === 'Relation' && f !== 1) aa = aa.split(';').map(function (v) { var n = parseFloat(v); return isNaN(n) ? v : String(Math.round(n * f * 10) / 10); }).join(';');
			out.push({
				id: newId(), type: type,
				x: Math.round(parseInt(childText(e, 'x'), 10) * f), y: Math.round(parseInt(childText(e, 'y'), 10) * f),
				w: Math.round(parseInt(childText(e, 'w'), 10) * f), h: Math.round(parseInt(childText(e, 'h'), 10) * f),
				pa: childText(e, 'panel_attributes'), aa: aa
			});
		}
		return out;
	}
	function bounds(records) {
		var b = null;
		records.forEach(function (r) {
			if (r.id === '_diagram') return;
			if (!b) b = { x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h };
			else { b.x1 = Math.min(b.x1, r.x); b.y1 = Math.min(b.y1, r.y); b.x2 = Math.max(b.x2, r.x + r.w); b.y2 = Math.max(b.y2, r.y + r.h); }
		});
		return b;
	}
	// returns the number of inserted elements
	function insertUxf(text) {
		if (!ready) throw new Error('the editor is still loading');
		var records = parseUxf(text);
		if (!records.length) return 0;
		var have = bounds(window.umletCollabSnapshot());
		var add = bounds(records);
		if (have) {
			// to the right of the existing diagram, top-aligned, snapped to the grid
			var dx = Math.ceil((have.x2 + 60 - add.x1) / DEFAULT_ZOOM) * DEFAULT_ZOOM;
			var dy = Math.round((have.y1 - add.y1) / DEFAULT_ZOOM) * DEFAULT_ZOOM;
			records.forEach(function (r) { r.x += dx; r.y += dy; });
		}
		applyRecords(records, false);
		return records.length;
	}

	// ---- version history (kept by the server, see collab-server/src/room.js) ----------------------------------
	var pending = {}; // reply type -> [resolve]
	function ask(msg, replyType) {
		return new Promise(function (resolve, reject) {
			if (!ws || ws.readyState !== 1) return reject(new Error('not connected'));
			(pending[replyType] = pending[replyType] || []).push(resolve);
			send(msg);
			setTimeout(function () { reject(new Error('no answer from the server')); }, 10000);
		});
	}
	function answer(msg) {
		var waiting = pending[msg.t] || [];
		pending[msg.t] = [];
		waiting.forEach(function (resolve) { resolve(msg); });
	}
	function listVersions() { return ask({ t: 'versions' }, 'versions').then(function (m) { return m.versions || []; }); }
	function getVersion(at) {
		return ask({ t: 'version', at: at }, 'version').then(function (m) {
			if (!m.uxf) throw new Error('that version no longer exists');
			return m.uxf;
		});
	}
	// the current diagram as a .uxf file (same format as the server's versions)
	function currentUxf() {
		var esc = function (v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
		var records = window.umletCollabSnapshot();
		var parts = ['<?xml version="1.0" encoding="UTF-8" standalone="no"?>', '<diagram program="umlet" version="15.1">', '  <zoom_level>10</zoom_level>'];
		records.forEach(function (r) {
			if (r.id === '_diagram') { if (r.pa) parts.push('  <help_text>' + esc(r.pa) + '</help_text>'); return; }
			parts.push('  <element>', '    <id>' + esc(r.type) + '</id>', '    <coordinates>',
				'      <x>' + r.x + '</x>', '      <y>' + r.y + '</y>', '      <w>' + r.w + '</w>', '      <h>' + r.h + '</h>',
				'    </coordinates>', '    <panel_attributes>' + esc(r.pa) + '</panel_attributes>',
				'    <additional_attributes>' + esc(r.aa) + '</additional_attributes>', '  </element>');
		});
		parts.push('</diagram>', '');
		return parts.join('\n');
	}

	// replaces the whole diagram with a .uxf file for everyone (the server keeps the replaced state as a version)
	function replaceWithUxf(text) {
		if (!ready) throw new Error('the editor is still loading');
		var records = parseUxf(text);
		records.push({ id: '_diagram', type: '_diagram', pa: records.help || '' });
		send({ t: 'checkpoint' }); // the server keeps the diagram as it is now, so the restore can be undone
		applyRecords(records, true);
		flush();
		return records.length - 1;
	}

	function transformIndex(index, delta) {
		var pos = 0;
		for (var i = 0; i < delta.length; i++) {
			var d = delta[i];
			if (d.retain) pos += d.retain;
			else if (d.insert) {
				var n = typeof d.insert === 'string' ? d.insert.length : 1;
				if (pos <= index) index += n;
				pos += n;
			}
			else if (d.delete) {
				if (pos < index) index -= Math.min(d.delete, index - pos);
			}
			if (pos > index) break;
		}
		return index;
	}

	function onRemoteOps(ops) {
		if (!synced) {
			// not applied yet: fold into the pending room state (if there is none, the next 'hello' contains them)
			if (serverState) ops.forEach(function (op) { if (wins(op, serverState.get(op.id))) serverState.set(op.id, op); });
			return;
		}
		var accepted = [];
		for (var i = 0; i < ops.length; i++) {
			var op = ops[i];
			if (wins(op, known.get(op.id))) {
				known.set(op.id, op);
				accepted.push(withText(op));
			}
		}
		if (accepted.length) applyRecords(accepted, false);
	}

	// make sure a keystroke that is in the textarea but not yet in the model (keyup pending) is merged, not overwritten
	function captureTypingInProgress() {
		var ta = focusedTextarea();
		if (!ta || !ready || !synced) return;
		var t = texts.get(window.umletCollabPropertiesId());
		if (t && t.toString() !== ta.value) ydoc.transact(function () { setText(t, ta.value); });
	}

	function onRemoteY(u) {
		captureTypingInProgress();
		Y.applyUpdate(ydoc, fromBase64(u), REMOTE);
	}

	function initDoc() {
		if (ydoc) ydoc.destroy();
		ydoc = new Y.Doc();
		texts = ydoc.getMap('texts');
		ydoc.on('update', function (update, origin) {
			if (origin !== REMOTE && synced) send({ t: 'y', u: toBase64(update) });
		});
		texts.observeDeep(onRemoteTexts);
	}

	function onRemoteTexts(events, tr) {
		if (tr.origin !== REMOTE || !synced) return;
		var ids = new Set();
		var editedId = window.umletCollabPropertiesId();
		var caretDelta = null;
		events.forEach(function (e) {
			if (e.target === texts) e.changes.keys.forEach(function (change, key) { ids.add(key); });
			else {
				var id = e.path[0];
				ids.add(id);
				if (id === editedId) caretDelta = e.delta;
			}
		});
		var records = [];
		ids.forEach(function (id) {
			var rec = known.get(id);
			if (rec && !rec.deleted) records.push(withText(rec));
		});
		if (records.length) applyRecords(records, false, caretDelta);
	}
	initDoc();

	function trySync() {
		if (!ready || serverState === null) return;
		var elements = Array.from(serverState.values());
		serverState = null;
		if (!everSynced) {
			// first join: the room's diagram replaces the local one; an empty room is seeded with the local diagram
			known = new Map();
			elements.forEach(function (e) { known.set(e.id, e); });
			if (elements.some(function (e) { return !e.deleted; })) applyRecords(elements.map(withText), true);
		}
		synced = true;
		if (everSynced) {
			// reconnect: merge geometry, show texts merged with what others typed meanwhile, then push local changes
			onRemoteOps(elements);
			applyRecords(Array.from(known.values()).filter(function (r) { return !r.deleted; }).map(withText), false);
		}
		everSynced = true;
		send({ t: 'y', u: toBase64(Y.encodeStateAsUpdate(ydoc)) }); // text edits made while offline (no-op if none)
		flush();
		offlineChanges = false;
		announcePresence();
	}

	var offline = false; // debugging aid: umletCollab.debug.setOffline(true) simulates a lost connection
	var generation = 0;  // increases with every room switch; events of older sockets are ignored

	function connect() {
		if (offline || !room) return;
		var gen = generation;
		var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		ws = new WebSocket(proto + '//' + location.host + '/collab?room=' + encodeURIComponent(room));
		ws.onmessage = function (e) {
			if (gen !== generation) return;
			var msg = JSON.parse(e.data);
			if (msg.t === 'hello') {
				me.id = msg.id;
				serverState = new Map();
				(msg.elements || []).forEach(function (r) { serverState.set(r.id, r); });
				if (msg.y) Y.applyUpdate(ydoc, fromBase64(msg.y), REMOTE);
				trySync();
			}
			else if (msg.t === 'ops') onRemoteOps(msg.ops);
			else if (msg.t === 'y') onRemoteY(msg.u);
			else if (msg.t === 'presence') onPresence(msg);
			else if (msg.t === 'leave') removePeer(msg.from);
			else if (msg.t === 'versions' || msg.t === 'version') answer(msg);
		};
		ws.onclose = function () {
			if (gen !== generation) return;
			synced = false;
			if (!offline) setTimeout(function () { if (gen === generation) connect(); }, 1000);
		};
	}

	// leaves the current room and joins another one, starting with an empty diagram (used by the project tabs)
	function switchRoom(newRoom) {
		if (newRoom === room) return;
		if (synced) flush(); // send anything still pending to the room we are leaving
		generation++;
		if (ws) { ws.onclose = null; ws.close(); ws = null; }
		clearTimeout(liveTimer);
		liveTimer = null;
		Object.keys(peers).forEach(removePeer);
		synced = false;
		everSynced = false;
		serverState = null;
		known = new Map();
		applied = new Map();
		initDoc();
		if (ready) {
			applying = true;
			try { window.umletCollabApply([{ id: '_diagram', type: '_diagram', pa: '' }], true); } finally { applying = false; }
		}
		room = newRoom;
		connect();
	}

	window.umletCollab = {
		get room() { return room; },
		me: me,
		switchRoom: switchRoom,
		// asked before the page closes: only warn if something really hasn't reached the server
		// (the server persists what it received within a second, even if everyone leaves)
		hasUnsavedChanges: function () {
			if (!room) return false;
			if (liveTimer) flush(); // a pending drag/redraw change: send it now
			return offlineChanges || (!!ws && ws.bufferedAmount > 0);
		},
		colors: COLORS,
		setColor: function (color) {
			me.color = color;
			store('umletcollab.color', me.color);
			announcePresence(); // cursors and selections switch colour for the others
		},
		setName: function (name) {
			me.name = String(name).trim().slice(0, 40) || me.name;
			store('umletcollab.name', me.name);
			announcePresence(); // with the new name
		},
		onReady: function () { ready = true; trySync(); },
		onLocalChange: onLocalChange,
		insertUxf: insertUxf,
		replaceWithUxf: replaceWithUxf,
		currentUxf: currentUxf,
		listVersions: listVersions,
		getVersion: getVersion,
		debug: {
			state: function () {
				return { synced: synced, elements: Array.from(known.values()), texts: texts.toJSON(), peers: Object.keys(peers).map(function (id) { return { id: id, name: peers[id].name, sel: peers[id].sel }; }) };
			},
			setOffline: function (value) {
				offline = value;
				if (offline && ws) ws.close();
				if (!offline) connect();
			}
		}
	};

	// ---- presence: cursors and selections ----------------------------------------
	// positions are sent in shared diagram coordinates (default zoom, without the local view offset)
	function diagramCanvas() {
		return ready ? window.umletCollabCanvas() : null; // not the palette's canvas, which can be the larger one
	}

	// the scrolling viewport around the diagram canvas; overlays are clipped to it
	function diagramViewport(canvas) {
		for (var el = canvas.parentElement; el && el !== document.body; el = el.parentElement) {
			var cs = getComputedStyle(el);
			if (/(auto|scroll|hidden)/.test(cs.overflow + cs.overflowX + cs.overflowY)) return el;
		}
		return document.body;
	}

	function view() {
		return ready ? window.umletCollabView() : { zoom: DEFAULT_ZOOM, x: 0, y: 0 };
	}

	var pointer = null;        // last local pointer position in shared coordinates
	var lastPresence = 0;
	var lastSelectionSent = '';
	function sendPresence(pointerMoved) {
		if (!ready || !synced) return;
		var sel = Array.from(window.umletCollabSelection());
		var selKey = sel.join(',');
		if (!pointerMoved && selKey === lastSelectionSent) return;
		var now = Date.now();
		if (pointerMoved && now - lastPresence < LIVE_INTERVAL_MS) return;
		lastPresence = now;
		lastSelectionSent = selKey;
		send({ t: 'presence', name: me.name, color: me.color, x: pointer ? pointer.x : null, y: pointer ? pointer.y : null, sel: sel });
	}

	document.addEventListener('mousemove', function (e) {
		var c = diagramCanvas();
		if (!c) return;
		var r = c.getBoundingClientRect();
		var v = view();
		var z = v.zoom / DEFAULT_ZOOM;
		pointer = { x: (e.clientX - r.left - v.x) / z, y: (e.clientY - r.top - v.y) / z };
		sendPresence(true);
	}, true);
	document.addEventListener('scroll', scheduleRender, true);
	window.addEventListener('resize', scheduleRender);

	var peers = {}; // id -> {name, color, x, y, sel, cursor, boxes}
	function onPresence(msg) {
		var isNew = !peers[msg.from];
		var p = peers[msg.from] || (peers[msg.from] = { boxes: {} });
		p.name = msg.name;
		p.color = msg.color;
		p.x = msg.x;
		p.y = msg.y;
		p.sel = msg.sel || [];
		p.seen = Date.now();
		scheduleRender();
		if (isNew) announcePresence(); // let a newcomer see us right away (they answer once in turn, then it stops)
	}

	function announcePresence() {
		lastSelectionSent = null;
		lastPresence = 0;
		sendPresence(false);
	}

	// heartbeat: everyone re-announces regularly, and peers not heard from for a while are dropped, so someone whose
	// laptop slept or whose connection died without a 'leave' does not linger as a ghost cursor/selection
	var HEARTBEAT_MS = 20000, PEER_TIMEOUT_MS = 75000;
	setInterval(function () {
		if (ws && ws.readyState === 1) announcePresence();
		var now = Date.now();
		Object.keys(peers).forEach(function (id) { if (now - (peers[id].seen || 0) > PEER_TIMEOUT_MS) removePeer(id); });
		scheduleRender();
	}, HEARTBEAT_MS);

	function removePeer(id) {
		var p = peers[id];
		if (!p) return;
		if (p.cursor) p.cursor.remove();
		Object.keys(p.boxes).forEach(function (k) { p.boxes[k].remove(); });
		delete peers[id];
	}

	var overlay = document.createElement('div');
	overlay.className = 'collab-overlay';
	var renderQueued = false;
	function scheduleRender() {
		if (renderQueued) return;
		renderQueued = true;
		requestAnimationFrame(render);
	}

	function render() {
		renderQueued = false;
		var canvas = ready && diagramCanvas();
		if (!canvas) return;
		if (!overlay.parentNode) document.body.appendChild(overlay);
		var vp = diagramViewport(canvas).getBoundingClientRect();
		overlay.style.left = vp.left + 'px';
		overlay.style.top = vp.top + 'px';
		overlay.style.width = vp.width + 'px';
		overlay.style.height = vp.height + 'px';
		var cr = canvas.getBoundingClientRect();
		var ox = cr.left - vp.left, oy = cr.top - vp.top; // canvas origin inside the overlay
		var v = view();
		var z = v.zoom / DEFAULT_ZOOM;

		Object.keys(peers).forEach(function (id) {
			var p = peers[id];
			// cursor
			if (!p.cursor) {
				p.cursor = document.createElement('div');
				p.cursor.className = 'collab-cursor';
				p.cursor.innerHTML = '<svg width="16" height="20" viewBox="0 0 16 20"><path d="M0 0 L0 16 L4 12 L7 19 L10 18 L7 11 L13 11 Z" stroke="white" stroke-width="1"/></svg><span></span>';
				overlay.appendChild(p.cursor);
			}
			p.cursor.style.display = p.x === null ? 'none' : '';
			p.cursor.querySelector('path').setAttribute('fill', p.color);
			var label = p.cursor.querySelector('span');
			label.textContent = p.name;
			label.style.background = p.color;
			p.cursor.style.transform = 'translate(' + (ox + v.x + p.x * z) + 'px,' + (oy + v.y + p.y * z) + 'px)';

			// selection boxes
			var wanted = {};
			p.sel.forEach(function (elementId) {
				var rect = window.umletCollabRect(elementId);
				if (!rect) return;
				wanted[elementId] = true;
				var box = p.boxes[elementId];
				if (!box) {
					box = p.boxes[elementId] = document.createElement('div');
					box.className = 'collab-selection';
					box.innerHTML = '<span></span>';
					overlay.appendChild(box);
				}
				box.style.borderColor = p.color;
				box.firstChild.textContent = p.name;
				box.firstChild.style.background = p.color;
				box.style.left = (ox + rect.x - 3) + 'px';
				box.style.top = (oy + rect.y - 3) + 'px';
				box.style.width = (rect.w + 2) + 'px';
				box.style.height = (rect.h + 2) + 'px';
				box.className = 'collab-selection' + (oy + rect.y < 20 ? ' label-below' : ''); // keep the name visible at the top edge
			});
			Object.keys(p.boxes).forEach(function (elementId) {
				if (!wanted[elementId]) { p.boxes[elementId].remove(); delete p.boxes[elementId]; }
			});
		});
	}

	var style = document.createElement('style');
	style.textContent = '.collab-overlay{position:fixed;overflow:hidden;pointer-events:none;z-index:100000}' +
		'.collab-cursor{position:absolute;left:0;top:0;transition:transform 40ms linear}' +
		'.collab-cursor span{position:absolute;left:14px;top:16px;color:#fff;font:11px sans-serif;padding:1px 5px;border-radius:3px;white-space:nowrap}' +
		'.collab-selection{position:absolute;border:2px dashed;border-radius:3px}' +
		'.collab-selection span{position:absolute;left:-2px;top:-17px;color:#fff;font:10px sans-serif;padding:1px 4px;border-radius:3px 3px 3px 0;white-space:nowrap}' +
		'.collab-selection.label-below span{top:auto;bottom:-17px;border-radius:0 3px 3px 3px}';
	document.head.appendChild(style);

	connect();
})();
