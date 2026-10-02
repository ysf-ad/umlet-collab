// Project tab bar for collaborative UMLetino (only active with ?project=<id>).
//
// A project is a list of diagrams; each diagram is its own collaborative room "<projectId>/<diagramId>".
// The bar shows one tab per diagram, live for everyone in the project: add (+), rename (double click),
// delete (x), reorder (drag). Switching tabs swaps the room in place via umletCollab.switchRoom().
// Server side: Project Durable Object (collab-server/src/worker.js) / Node relay, logic in src/project.js.
(function () {
	var params = new URLSearchParams(location.search);
	var projectId = params.get('project');
	if (!projectId) return;

	var BAR_HEIGHT = 36;
	var ws = null;
	var project = null;     // {id, name, diagrams: [{id, name}]}
	var viewers = [];       // [{id, diagram, name, color}]
	var you = null;         // own id on the project connection
	var current = params.get('diagram');
	var requestCounter = 0;
	var pendingAdd = null;  // requestId of the diagram we created, to switch to it
	var pendingRename = null; // id of the diagram we created: rename it inline as soon as its tab exists

	// ---- DOM ------------------------------------------------------------------------
	var bar = document.createElement('div');
	bar.id = 'projectbar';
	bar.innerHTML =
		'<a class="pb-home" href="./" title="All projects">&#9664; Projects</a>' +
		'<span class="pb-project" title="Double-click to rename the project"></span>' +
		'<div class="pb-tabs" role="tablist"></div>' +
		'<button class="pb-add" title="New diagram" aria-label="New diagram">+</button>' +
		'<div class="pb-spacer"></div>' +
		'<span class="pb-status"></span>' +
		'<button class="pb-me" title="Change your display name"></button>' +
		'<button class="pb-share" title="Copy a link to this diagram">Copy link</button>';
	var tabsEl = bar.querySelector('.pb-tabs');
	var projectEl = bar.querySelector('.pb-project');
	var statusEl = bar.querySelector('.pb-status');
	var meEl = bar.querySelector('.pb-me');
	var toast = document.createElement('div');
	toast.id = 'pb-toast';

	function mount() {
		document.body.appendChild(bar);
		document.body.appendChild(toast);
		var dark = typeof theme !== 'undefined' && theme === 'DARK'; // set by the host page
		document.body.classList.add('has-projectbar', dark ? 'pb-dark' : 'pb-light');
		window.dispatchEvent(new Event('resize')); // GWT re-lays out below the bar
		renderMe();
	}
	if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

	var toastTimer;
	function showToast(text) {
		toast.textContent = text;
		toast.classList.add('visible');
		clearTimeout(toastTimer);
		toastTimer = setTimeout(function () { toast.classList.remove('visible'); }, 3500);
	}

	function send(msg) {
		if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
	}

	// ---- connection -----------------------------------------------------------------
	function connect() {
		var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		ws = new WebSocket(proto + '//' + location.host + '/project?id=' + encodeURIComponent(projectId));
		ws.onopen = function () { statusEl.textContent = ''; };
		ws.onmessage = function (e) {
			var msg = JSON.parse(e.data);
			if (msg.t === 'project') {
				viewers = msg.viewers || [];
				onProject(msg.project);
				if (msg.you) { // first message of a (re)connection: tell the others where we are
					you = msg.you;
					if (current) announce();
				}
			}
			else if (msg.t === 'viewers') { viewers = msg.viewers || []; renderTabs(); }
			else if (msg.t === 'added' && msg.requestId === pendingAdd) {
				// the reply arrives before the updated project, so the tab may not exist yet
				pendingAdd = null;
				pendingRename = msg.id;
				if (project && project.diagrams.some(function (d) { return d.id === msg.id; })) onProject(project);
			}
			else if (msg.t === 'error') showToast(msg.message);
			else if (msg.t === 'deleted') onProject(null);
		};
		ws.onclose = function () {
			statusEl.textContent = 'Reconnecting…';
			setTimeout(connect, 1500);
		};
	}

	function onProject(p) {
		if (!p) {
			project = null;
			showMissing();
			return;
		}
		var previous = project;
		project = p;
		projectEl.textContent = p.name;
		if (pendingRename && p.diagrams.some(function (d) { return d.id === pendingRename; })) {
			current = null; // switch to the new diagram below
		}
		var exists = p.diagrams.some(function (d) { return d.id === current; });
		if (!exists) {
			var removed = previous && current && previous.diagrams.filter(function (d) { return d.id === current; })[0];
			if (removed) showToast('"' + removed.name + '" was deleted');
			if (pendingRename) switchTo(pendingRename, true);
			else switchTo(p.diagrams[0].id, false);
		}
		else if (umletCollab.room !== roomOf(current)) switchTo(current, false);
		renderTabs();
		updateTitle();
		if (pendingRename === current) {
			pendingRename = null;
			startRename(current);
		}
	}

	function showMissing() {
		document.body.classList.add('pb-missing');
		var box = document.getElementById('pb-missing') || document.body.appendChild(document.createElement('div'));
		box.id = 'pb-missing';
		box.innerHTML = '<p>This project doesn’t exist or was deleted.</p><a href="./">Go to all projects</a>';
	}

	// ---- diagrams -------------------------------------------------------------------
	function roomOf(diagramId) { return projectId + '/' + diagramId; }
	function diagramName(id) {
		var d = project && project.diagrams.filter(function (x) { return x.id === id; })[0];
		return d ? d.name : '';
	}

	function switchTo(id, pushHistory) {
		current = id;
		var url = location.pathname + '?project=' + encodeURIComponent(projectId) + '&diagram=' + encodeURIComponent(id);
		if (pushHistory) history.pushState({ diagram: id }, '', url);
		else history.replaceState({ diagram: id }, '', url);
		umletCollab.switchRoom(roomOf(id));
		announce();
		renderTabs();
		updateTitle();
	}

	function announce() {
		send({ t: 'viewing', diagram: current, name: umletCollab.me.name, color: umletCollab.me.color });
	}

	function updateTitle() {
		if (project) document.title = diagramName(current) + ' – ' + project.name + ' – UMLetino';
	}

	window.addEventListener('popstate', function () {
		var id = new URLSearchParams(location.search).get('diagram');
		if (id && project && id !== current) switchTo(id, false);
	});

	// ---- rendering ------------------------------------------------------------------
	function renderTabs() {
		if (!project) return;
		var editing = tabsEl.querySelector('input');
		if (editing) return; // don't disturb an inline rename; re-rendered when it ends
		tabsEl.innerHTML = '';
		project.diagrams.forEach(function (d, index) {
			var tab = document.createElement('div');
			tab.className = 'pb-tab' + (d.id === current ? ' active' : '');
			tab.setAttribute('role', 'tab');
			tab.setAttribute('aria-selected', d.id === current);
			tab.draggable = true;
			tab.dataset.id = d.id;
			tab.title = d.name + ' (double-click to rename, drag to reorder)';

			var name = document.createElement('span');
			name.className = 'pb-tab-name';
			name.textContent = d.name;
			tab.appendChild(name);

			var dots = document.createElement('span');
			dots.className = 'pb-dots';
			viewers.filter(function (v) { return v.diagram === d.id && v.id !== you; }).forEach(function (v) {
				var dot = document.createElement('span');
				dot.className = 'pb-dot';
				dot.style.background = v.color;
				dot.title = v.name;
				dots.appendChild(dot);
			});
			tab.appendChild(dots);

			if (project.diagrams.length > 1) {
				var close = document.createElement('button');
				close.className = 'pb-close';
				close.title = 'Delete diagram';
				close.setAttribute('aria-label', 'Delete ' + d.name);
				close.textContent = '×';
				close.addEventListener('click', function (e) {
					e.stopPropagation();
					if (confirm('Delete "' + d.name + '" for everyone in this project?')) send({ t: 'remove', id: d.id });
				});
				tab.appendChild(close);
			}

			tab.addEventListener('click', function () { if (d.id !== current) switchTo(d.id, true); });
			tab.addEventListener('dblclick', function () { startRename(d.id); });
			tab.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', d.id); tab.classList.add('dragging'); });
			tab.addEventListener('dragend', function () { tab.classList.remove('dragging'); });
			tab.addEventListener('dragover', function (e) { e.preventDefault(); tab.classList.add('drop-target'); });
			tab.addEventListener('dragleave', function () { tab.classList.remove('drop-target'); });
			tab.addEventListener('drop', function (e) {
				e.preventDefault();
				tab.classList.remove('drop-target');
				var dragged = e.dataTransfer.getData('text/plain');
				if (dragged && dragged !== d.id) send({ t: 'move', id: dragged, index: index });
			});
			tabsEl.appendChild(tab);
		});
		var active = tabsEl.querySelector('.active');
		if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	function renderMe() {
		meEl.innerHTML = '';
		var dot = document.createElement('span');
		dot.className = 'pb-dot';
		dot.style.background = umletCollab.me.color;
		meEl.appendChild(dot);
		meEl.appendChild(document.createTextNode(' ' + umletCollab.me.name));
	}

	// inline editing for diagram and project names
	function inlineEdit(target, value, onCommit) {
		var input = document.createElement('input');
		input.className = 'pb-input';
		input.value = value;
		input.maxLength = 80;
		target.textContent = '';
		target.appendChild(input);
		input.focus();
		input.select();
		var done = false;
		function finish(commit) {
			if (done) return;
			done = true;
			var v = input.value.trim();
			input.remove();
			if (commit && v && v !== value) onCommit(v);
			target.textContent = commit && v ? v : value;
			renderTabs();
		}
		input.addEventListener('keydown', function (e) {
			e.stopPropagation(); // keep UMLet shortcuts (e.g. Delete) away from the input
			if (e.key === 'Enter') finish(true);
			else if (e.key === 'Escape') finish(false);
		});
		input.addEventListener('keyup', function (e) { e.stopPropagation(); });
		input.addEventListener('blur', function () { finish(true); });
		input.addEventListener('click', function (e) { e.stopPropagation(); });
		input.addEventListener('dblclick', function (e) { e.stopPropagation(); });
	}

	function startRename(id) {
		var tab = tabsEl.querySelector('.pb-tab[data-id="' + id + '"] .pb-tab-name');
		if (tab) inlineEdit(tab, diagramName(id), function (name) { send({ t: 'rename', id: id, name: name }); });
	}

	// ---- controls -------------------------------------------------------------------
	bar.querySelector('.pb-add').addEventListener('click', function () {
		pendingAdd = 'r' + (++requestCounter) + Date.now();
		send({ t: 'add', requestId: pendingAdd });
	});
	projectEl.addEventListener('dblclick', function () {
		if (project) inlineEdit(projectEl, project.name, function (name) { send({ t: 'renameProject', name: name }); });
	});
	meEl.addEventListener('click', function () {
		var name = prompt('Your display name (shown to others):', umletCollab.me.name);
		if (name && name.trim()) {
			umletCollab.setName(name);
			renderMe();
			announce();
		}
	});
	bar.querySelector('.pb-share').addEventListener('click', function () {
		var button = this;
		var done = function () { button.textContent = 'Copied'; setTimeout(function () { button.textContent = 'Copy link'; }, 1500); };
		if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(location.href).then(done, function () { prompt('Copy this link:', location.href); });
		else prompt('Copy this link:', location.href);
	});

	// ---- styles ---------------------------------------------------------------------
	var style = document.createElement('style');
	style.textContent = [
		'body.has-projectbar #umlet-root{top:' + BAR_HEIGHT + 'px !important}',
		'body.pb-light{--pb-bg:#f3f4f6;--pb-fg:#1f2328;--pb-muted:#656d76;--pb-tab:#e5e7eb;--pb-active:#ffffff;--pb-border:#d0d7de;--pb-accent:#2563eb}',
		'body.pb-dark{--pb-bg:#1b1d21;--pb-fg:#e6e6e6;--pb-muted:#9aa0a6;--pb-tab:#2a2d33;--pb-active:#000000;--pb-border:#3a3d44;--pb-accent:#6ea8fe}',
		'#projectbar{position:fixed;left:0;right:0;top:0;height:' + BAR_HEIGHT + 'px;display:flex;align-items:flex-end;gap:6px;padding:0 8px;box-sizing:border-box;background:var(--pb-bg);color:var(--pb-fg);border-bottom:1px solid var(--pb-border);font:13px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;z-index:1000;user-select:none}',
		'#projectbar button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}',
		'#projectbar .pb-home{align-self:center;color:var(--pb-muted);text-decoration:none;white-space:nowrap;padding:4px 6px;border-radius:6px}',
		'#projectbar .pb-home:hover{background:var(--pb-tab);color:var(--pb-fg)}',
		'#projectbar .pb-project{align-self:center;font-weight:600;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 6px;cursor:text}',
		'#projectbar .pb-tabs{display:flex;align-items:flex-end;align-self:stretch;gap:2px;overflow-x:auto;overflow-y:hidden;min-width:0;scrollbar-width:none}',
		'#projectbar .pb-tab{display:flex;align-items:center;gap:6px;height:29px;padding:0 6px 0 12px;background:var(--pb-tab);border:1px solid var(--pb-border);border-bottom:0;border-radius:7px 7px 0 0;cursor:pointer;white-space:nowrap;max-width:220px;color:var(--pb-muted)}',
		'#projectbar .pb-tab:hover{color:var(--pb-fg)}',
		'#projectbar .pb-tab.active{background:var(--pb-active);color:var(--pb-fg);height:31px;box-shadow:inset 0 2px 0 var(--pb-accent)}',
		'#projectbar .pb-tab.dragging{opacity:.5}',
		'#projectbar .pb-tab.drop-target{box-shadow:inset 3px 0 0 var(--pb-accent)}',
		'#projectbar .pb-tab-name{overflow:hidden;text-overflow:ellipsis}',
		'#projectbar .pb-close{width:18px;height:18px;line-height:16px;border-radius:4px;color:var(--pb-muted);visibility:hidden;font-size:15px}',
		'#projectbar .pb-tab:hover .pb-close,#projectbar .pb-tab.active .pb-close{visibility:visible}',
		'#projectbar .pb-close:hover{background:var(--pb-border);color:var(--pb-fg)}',
		'#projectbar .pb-add{align-self:center;width:26px;height:26px;border-radius:6px;font-size:18px;color:var(--pb-muted)}',
		'#projectbar .pb-add:hover,#projectbar .pb-me:hover,#projectbar .pb-share:hover{background:var(--pb-tab);color:var(--pb-fg)}',
		'#projectbar .pb-spacer{flex:1}',
		'#projectbar .pb-status{align-self:center;color:var(--pb-muted)}',
		'#projectbar .pb-me,#projectbar .pb-share{align-self:center;padding:4px 8px;border-radius:6px;white-space:nowrap}',
		'#projectbar .pb-share{border:1px solid var(--pb-border) !important}',
		'#projectbar .pb-dots{display:flex;gap:2px}',
		'.pb-dot{display:inline-block;width:8px;height:8px;border-radius:50%}',
		'#projectbar .pb-input{font:inherit;width:140px;padding:2px 4px;border:1px solid var(--pb-accent);border-radius:4px;background:var(--pb-active);color:var(--pb-fg);outline:none}',
		'#pb-toast{position:fixed;left:50%;top:' + (BAR_HEIGHT + 10) + 'px;transform:translateX(-50%);background:#323232;color:#fff;padding:8px 14px;border-radius:6px;font:13px system-ui,sans-serif;opacity:0;pointer-events:none;transition:opacity .2s;z-index:1001}',
		'#pb-toast.visible{opacity:1}',
		'#pb-missing{position:fixed;inset:' + BAR_HEIGHT + 'px 0 0 0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:var(--pb-bg);color:var(--pb-fg);font:15px system-ui,sans-serif;z-index:999}',
		'#pb-missing a{color:var(--pb-accent)}',
		'body.pb-missing #projectbar .pb-add,body.pb-missing #projectbar .pb-share{display:none}'
	].join('\n');
	document.head.appendChild(style);

	connect();
})();
