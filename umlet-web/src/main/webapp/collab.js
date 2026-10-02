// Collaboration client for UMLetino (Excalidraw-style per-element sync).
//
// GWT side (see CollabBridge.java / WebFileChangeNotifier.java):
//   umletCollab.onLocalChange(live)        called by GWT after every local change (live=true: on redraw/drag, maybe nothing changed; throttled)
//   umletCollabSnapshot()                  -> [{id, type, x, y, w, h, pa, aa}] all elements at default zoom
//   umletCollabApply(records, replaceAll)  applies remote records in place
//   umletCollabView()                      -> {zoom, x, y}: zoom level (grid size, default 10) and local view offset in px
//
// Every element has {version, nonce}. A local change bumps the version; a remote record replaces the
// local one only if its version is higher (ties are broken by the lower nonce), so all clients converge.
(function () {
	var DEFAULT_ZOOM = 10;
	var LIVE_INTERVAL_MS = 33; // ~30 Hz for drags and cursors

	var params = new URLSearchParams(location.search);
	var room = params.get('room');
	if (!room) {
		room = Math.random().toString(36).slice(2, 8);
		params.set('room', room);
		history.replaceState(null, '', location.pathname + '?' + params.toString() + location.hash);
	}

	var COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#469990'];
	var me = { id: null, color: COLORS[Math.floor(Math.random() * COLORS.length)], name: 'User ' + Math.floor(Math.random() * 90 + 10) };

	var ws = null;
	var ready = false;        // GWT exported its functions
	var serverState = null;   // elements from the last 'hello' that are not applied yet
	var synced = false;       // initial state has been exchanged; local changes may be sent
	var everSynced = false;
	var applying = false;     // true while applying remote records (prevents echo)
	var known = new Map();    // id -> record incl. version, nonce, deleted
	var liveTimer = null;
	var lastLiveFlush = 0;

	function rand() { return Math.floor(Math.random() * 2147483647); }
	function content(r) { return JSON.stringify([r.type, r.x, r.y, r.w, r.h, r.pa, r.aa, !!r.deleted]); }
	function wins(op, cur) {
		return !cur || op.version > cur.version || (op.version === cur.version && op.nonce < cur.nonce);
	}

	function send(msg) {
		if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
	}

	// ---- local -> remote -------------------------------------------------------
	function flush() {
		if (!synced || applying) return;
		clearTimeout(liveTimer);
		liveTimer = null;
		lastLiveFlush = Date.now();
		var snapshot = window.umletCollabSnapshot();
		var ops = [];
		var present = new Set();
		for (var i = 0; i < snapshot.length; i++) {
			var r = snapshot[i];
			present.add(r.id);
			var cur = known.get(r.id);
			if (cur && content(cur) === content(r)) continue;
			var op = { id: r.id, type: r.type, x: r.x, y: r.y, w: r.w, h: r.h, pa: r.pa, aa: r.aa, deleted: false, version: (cur ? cur.version : 0) + 1, nonce: rand() };
			known.set(op.id, op);
			ops.push(op);
		}
		known.forEach(function (cur, id) {
			if (!cur.deleted && !present.has(id)) {
				var op = { id: id, deleted: true, version: cur.version + 1, nonce: rand() };
				known.set(id, op);
				ops.push(op);
			}
		});
		if (ops.length) send({ t: 'ops', ops: ops });
	}

	function onLocalChange(live) {
		if (applying || !synced) return;
		if (!live) return flush();
		// always async, so GWT finishes the current operation first (e.g. palette double click adds, then moves the element)
		if (!liveTimer) liveTimer = setTimeout(flush, Math.max(0, LIVE_INTERVAL_MS - (Date.now() - lastLiveFlush)));
	}

	// ---- remote -> local -------------------------------------------------------
	function applyRecords(records, replaceAll) {
		// keep the caret if the user is typing in the properties panel and it gets refreshed
		var ae = document.activeElement;
		var caret = ae && ae.tagName === 'TEXTAREA' ? { el: ae, start: ae.selectionStart, end: ae.selectionEnd, value: ae.value } : null;
		applying = true;
		try { window.umletCollabApply(records, replaceAll); } finally { applying = false; }
		// applying may make GWT realign elements (redraw(true)); propagate that like any other local change
		onLocalChange(true);
		if (caret && caret.el.value !== caret.value) {
			var len = caret.el.value.length;
			caret.el.focus();
			caret.el.setSelectionRange(Math.min(caret.start, len), Math.min(caret.end, len));
		}
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
				accepted.push(op);
			}
		}
		if (accepted.length) applyRecords(accepted, false);
	}

	function trySync() {
		if (!ready || serverState === null) return;
		var elements = Array.from(serverState.values());
		serverState = null;
		if (!everSynced) {
			// first join: the room's diagram replaces the local one; an empty room is seeded with the local diagram
			known = new Map();
			elements.forEach(function (e) { known.set(e.id, e); });
			if (elements.some(function (e) { return !e.deleted; })) applyRecords(elements, true);
		}
		synced = true;
		if (everSynced) onRemoteOps(elements); // reconnect: merge, then push whatever changed locally while offline
		everSynced = true;
		flush();
	}

	function connect() {
		var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		ws = new WebSocket(proto + '//' + location.host + '/collab?room=' + encodeURIComponent(room));
		ws.onmessage = function (e) {
			var msg = JSON.parse(e.data);
			if (msg.t === 'hello') {
				me.id = msg.id;
				serverState = new Map();
				(msg.elements || []).forEach(function (e) { serverState.set(e.id, e); });
				trySync();
			}
			else if (msg.t === 'ops') onRemoteOps(msg.ops);
			else if (msg.t === 'cursor') drawCursor(msg);
			else if (msg.t === 'leave') removeCursor(msg.from);
		};
		ws.onclose = function () {
			synced = false;
			setTimeout(connect, 1000);
		};
	}

	window.umletCollab = {
		room: room,
		onReady: function () { ready = true; trySync(); },
		onLocalChange: onLocalChange,
		debug: function () { return { synced: synced, elements: Array.from(known.values()) }; }
	};

	// ---- cursors -------------------------------------------------------------
	// positions are sent in diagram coordinates at default zoom, so scroll position and zoom level don't matter
	function diagramCanvas() {
		var best = null, bestArea = 0;
		var all = document.getElementsByTagName('canvas');
		for (var i = 0; i < all.length; i++) {
			var r = all[i].getBoundingClientRect();
			if (r.width * r.height > bestArea) { bestArea = r.width * r.height; best = all[i]; }
		}
		return best;
	}

	function view() {
		return ready ? window.umletCollabView() : { zoom: DEFAULT_ZOOM, x: 0, y: 0 };
	}

	var lastCursor = 0;
	document.addEventListener('mousemove', function (e) {
		var now = Date.now();
		if (now - lastCursor < LIVE_INTERVAL_MS) return;
		var c = diagramCanvas();
		if (!c) return;
		lastCursor = now;
		var r = c.getBoundingClientRect();
		var v = view();
		var z = v.zoom / DEFAULT_ZOOM;
		send({ t: 'cursor', x: (e.clientX - r.left - v.x) / z, y: (e.clientY - r.top - v.y) / z, name: me.name, color: me.color });
	}, true);

	var cursors = {};
	function drawCursor(msg) {
		var el = cursors[msg.from];
		if (!el) {
			el = document.createElement('div');
			el.className = 'collab-cursor';
			el.innerHTML = '<svg width="16" height="20" viewBox="0 0 16 20"><path d="M0 0 L0 16 L4 12 L7 19 L10 18 L7 11 L13 11 Z" stroke="white" stroke-width="1"/></svg><span></span>';
			document.body.appendChild(el);
			cursors[msg.from] = el;
		}
		el.querySelector('path').setAttribute('fill', msg.color);
		var label = el.querySelector('span');
		label.textContent = msg.name;
		label.style.background = msg.color;
		var c = diagramCanvas();
		var r = c ? c.getBoundingClientRect() : { left: 0, top: 0 };
		var v = view();
		var z = v.zoom / DEFAULT_ZOOM;
		el.style.transform = 'translate(' + (r.left + v.x + msg.x * z) + 'px,' + (r.top + v.y + msg.y * z) + 'px)';
	}

	function removeCursor(id) {
		if (cursors[id]) { cursors[id].remove(); delete cursors[id]; }
	}

	var style = document.createElement('style');
	style.textContent = '.collab-cursor{position:fixed;left:0;top:0;pointer-events:none;z-index:100000;transition:transform 40ms linear}' +
		'.collab-cursor span{position:absolute;left:14px;top:16px;color:#fff;font:11px sans-serif;padding:1px 5px;border-radius:3px;white-space:nowrap}';
	document.head.appendChild(style);

	connect();
})();
