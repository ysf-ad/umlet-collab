// Collaboration client for UMLetino.
// GWT side calls umletCollab.onLocalChange(xml) whenever the diagram changes (see WebFileChangeNotifier)
// and exposes window.umletCollabApply(xml) to load a diagram received from others (see WebStartupDiagramLoader).
(function () {
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
	var ready = false;        // GWT app exported umletCollabApply
	var pendingDoc = null;    // doc received before GWT was ready
	var applying = false;     // true while applying a remote doc (prevents echo)
	var lastXml = null;
	var cursors = {};

	function send(msg) {
		if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
	}

	function applyDoc(xml) {
		if (!xml || xml === lastXml) return;
		if (!ready) { pendingDoc = xml; return; }
		lastXml = xml;
		applying = true;
		try { window.umletCollabApply(xml); } finally { applying = false; }
	}

	function connect() {
		var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		ws = new WebSocket(proto + '//' + location.host + '/collab?room=' + encodeURIComponent(room));
		ws.onmessage = function (e) {
			var msg = JSON.parse(e.data);
			if (msg.t === 'hello') { me.id = msg.id; if (msg.doc) applyDoc(msg.doc); }
			else if (msg.t === 'doc') applyDoc(msg.xml);
			else if (msg.t === 'cursor') drawCursor(msg);
			else if (msg.t === 'leave') removeCursor(msg.from);
		};
		ws.onclose = function () { setTimeout(connect, 1000); };
	}

	window.umletCollab = {
		room: room,
		onReady: function () {
			ready = true;
			if (pendingDoc) { var d = pendingDoc; pendingDoc = null; applyDoc(d); }
		},
		onLocalChange: function (xml) {
			if (applying || xml === lastXml) return;
			lastXml = xml;
			send({ t: 'doc', xml: xml });
		}
	};

	// ---- cursors -------------------------------------------------------------
	// positions are sent relative to the diagram canvas, so scrolled/resized windows still line up roughly
	function diagramCanvas() {
		var best = null, bestArea = 0;
		var all = document.getElementsByTagName('canvas');
		for (var i = 0; i < all.length; i++) {
			var r = all[i].getBoundingClientRect();
			if (r.width * r.height > bestArea) { bestArea = r.width * r.height; best = all[i]; }
		}
		return best;
	}

	var lastSent = 0;
	document.addEventListener('mousemove', function (e) {
		var now = Date.now();
		if (now - lastSent < 33) return; // ~30 Hz
		var c = diagramCanvas();
		if (!c) return;
		lastSent = now;
		var r = c.getBoundingClientRect();
		send({ t: 'cursor', x: e.clientX - r.left, y: e.clientY - r.top, name: me.name, color: me.color });
	}, true);

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
		el.style.transform = 'translate(' + (r.left + msg.x) + 'px,' + (r.top + msg.y) + 'px)';
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
