// Project bar for collaborative UMLetino: ?project=<id>[&diagram=<id>] shows the project's diagrams as tabs,
// ?room=<name> (a standalone diagram from before projects existed) shows the bar without tabs, and without
// either the user is sent to the project list.
//
// A project is a list of diagrams; each diagram is its own collaborative room "<projectId>/<diagramId>".
// The bar shows one tab per diagram, live for everyone in the project: add (+), rename (double click),
// delete (x), reorder (drag), restore deleted diagrams (Deleted menu). Switching tabs swaps the room in place
// via umletCollab.switchRoom().
// Server side: Project Durable Object (collab-server/src/worker.js) / Node relay, logic in src/project.js.
(function () {
	var params = new URLSearchParams(location.search);
	var projectId = params.get('project');
	var standalone = !projectId;
	if (standalone && !params.get('room')) {
		location.replace('./');
		return;
	}

	var BAR_HEIGHT = 36;
	var ws = null;
	var project = null;     // {id, name, diagrams: [{id, name}]}
	var viewers = [];       // [{id, diagram, name, color}]
	var you = null;         // own id on the project connection
	var current = params.get('diagram');
	var requestCounter = 0;
	var pendingAdd = null;  // requestId of the diagram we created, to switch to it
	var pendingRename = null; // id of the diagram we created: rename it inline as soon as its tab exists
	var pendingSwitch = null; // id of a diagram we restored: switch to it as soon as its tab exists

	// ---- DOM ------------------------------------------------------------------------
	var bar = document.createElement('div');
	bar.id = 'projectbar';
	bar.innerHTML =
		'<a class="pb-home" href="./" title="All projects">&#9664; Projects</a>' +
		'<button class="pb-project" title="Switch, create or rename projects" aria-haspopup="true" aria-expanded="false"><span class="pb-project-name"></span> &#9662;</button>' +
		'<div class="pb-tabs" role="tablist"></div>' +
		'<button class="pb-add" title="New diagram" aria-label="New diagram">+</button>' +
		'<div class="pb-spacer"></div>' +
		'<button class="pb-trash" title="Restore deleted diagrams" aria-haspopup="true" aria-expanded="false" hidden></button>' +
		'<span class="pb-status"></span>' +
		'<button class="pb-theme" title="Switch between light and dark mode" aria-label="Switch between light and dark mode"></button>' +
		'<button class="pb-me" title="Change your display name"></button>' +
		'<button class="pb-share" title="Copy a link to this diagram">Copy link</button>';
	var tabsEl = bar.querySelector('.pb-tabs');
	var projectButton = bar.querySelector('.pb-project');
	var projectEl = bar.querySelector('.pb-project-name');
	var projectMenu = document.createElement('div');
	projectMenu.className = 'pb-menu';
	projectMenu.hidden = true;
	var statusEl = bar.querySelector('.pb-status');
	var meEl = bar.querySelector('.pb-me');
	var themeEl = bar.querySelector('.pb-theme');
	var trashEl = bar.querySelector('.pb-trash');
	var trashMenu = document.createElement('div');
	trashMenu.className = 'pb-menu';
	trashMenu.hidden = true;
	var toast = document.createElement('div');
	toast.id = 'pb-toast';

	function mount() {
		document.body.appendChild(bar);
		document.body.appendChild(toast);
		document.body.appendChild(trashMenu);
		document.body.appendChild(projectMenu);
		document.body.classList.add('has-projectbar');
		applyBarTheme(typeof theme !== 'undefined' ? theme : 'LIGHT'); // set by the host page
		window.dispatchEvent(new Event('resize')); // GWT re-lays out below the bar
		renderMe();
		if (standalone) {
			document.body.classList.add('pb-standalone');
			projectEl.textContent = 'Standalone diagram';
		}
	}
	if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

	// light/dark: the host page owns the theme (window.setAppTheme), the bar follows it
	function applyBarTheme(t) {
		var dark = t === 'DARK';
		document.body.classList.toggle('pb-dark', dark);
		document.body.classList.toggle('pb-light', !dark);
		themeEl.textContent = dark ? '☀ Light' : '☾ Dark';
	}
	window.addEventListener('umlet-theme', function (e) { applyBarTheme(e.detail); });
	themeEl.addEventListener('click', function () {
		window.setAppTheme(document.body.classList.contains('pb-dark') ? 'LIGHT' : 'DARK');
	});

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
			else if (msg.t === 'restored') {
				pendingSwitch = msg.id;
				if (project) onProject(project);
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
		document.body.classList.remove('pb-missing'); // the project may have been restored
		var missing = document.getElementById('pb-missing');
		if (missing) missing.remove();
		renderTrash();
		if (pendingSwitch && p.diagrams.some(function (d) { return d.id === pendingSwitch; })) {
			var restored = pendingSwitch;
			pendingSwitch = null;
			if (restored !== current) { switchTo(restored, true); return; }
		}
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
	var activeEdit = null; // {input, finish} of the inline rename in progress

	function renderTabs() {
		if (!project) return;
		if (activeEdit) {
			// don't disturb an inline rename (re-rendered when it ends), but never let an abandoned one freeze the bar
			if (document.activeElement === activeEdit.input && tabsEl.contains(activeEdit.input)) return;
			activeEdit.finish(true);
			return;
		}
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

	function ago(time) {
		var m = Math.round((Date.now() - time) / 60000);
		if (m < 1) return 'just now';
		if (m < 60) return m + ' min ago';
		if (m < 60 * 24) return Math.round(m / 60) + ' h ago';
		return Math.round(m / 60 / 24) + ' days ago';
	}

	// "Deleted (n)" menu: deleted diagrams keep their content and can be restored by anyone
	function renderTrash() {
		var trash = (project && project.trash) || [];
		trashEl.hidden = trash.length === 0;
		trashEl.textContent = 'Deleted (' + trash.length + ')';
		if (!trash.length) closeTrash();
		trashMenu.innerHTML = '';
		trash.forEach(function (d) {
			var row = document.createElement('div');
			row.className = 'pb-trash-row';
			var label = document.createElement('div');
			label.className = 'pb-trash-label';
			var name = document.createElement('div');
			name.textContent = d.name;
			var when = document.createElement('div');
			when.className = 'pb-trash-when';
			when.textContent = d.deletedAt ? 'deleted ' + ago(d.deletedAt) : 'deleted';
			label.appendChild(name);
			label.appendChild(when);
			var button = document.createElement('button');
			button.textContent = 'Restore';
			button.setAttribute('aria-label', 'Restore ' + d.name);
			button.addEventListener('click', function () {
				send({ t: 'restore', id: d.id });
				closeTrash();
			});
			row.appendChild(label);
			row.appendChild(button);
			trashMenu.appendChild(row);
		});
	}

	// ---- dropdown menus (Deleted, project switcher) ------------------------------------
	var menus = [];
	function dropdown(button, menu, alignRight, onOpen) {
		var m = {
			open: function () {
				menus.forEach(function (other) { if (other !== m) other.close(); });
				if (onOpen) onOpen();
				var r = button.getBoundingClientRect();
				menu.style.top = (r.bottom + 4) + 'px';
				menu.style.left = alignRight ? '' : Math.max(8, r.left) + 'px';
				menu.style.right = alignRight ? Math.max(8, window.innerWidth - r.right) + 'px' : '';
				menu.hidden = false;
				button.setAttribute('aria-expanded', 'true');
			},
			close: function () {
				menu.hidden = true;
				button.setAttribute('aria-expanded', 'false');
			}
		};
		button.addEventListener('click', function (e) {
			e.stopPropagation();
			if (menu.hidden) m.open(); else m.close();
		});
		menus.push(m);
		return m;
	}
	document.addEventListener('mousedown', function (e) {
		var inside = e.target.closest && e.target.closest('.pb-menu, .pb-trash, .pb-project');
		if (!inside) menus.forEach(function (m) { m.close(); });
	}, true);
	document.addEventListener('keydown', function (e) { if (e.key === 'Escape') menus.forEach(function (m) { m.close(); }); });

	var trashDropdown = dropdown(trashEl, trashMenu, true, renderTrash);
	function closeTrash() { trashDropdown.close(); }

	// project switcher: every project, plus create / rename / all projects
	function menuItem(label, onClick) {
		var item = document.createElement('button');
		item.className = 'pb-menu-item';
		item.textContent = label;
		item.addEventListener('click', function () { projectDropdown.close(); onClick(); });
		projectMenu.appendChild(item);
	}
	function renderProjectMenu() {
		projectMenu.innerHTML = '<div class="pb-menu-title">Projects</div><div class="pb-menu-list"><div class="pb-menu-hint">Loading\u2026</div></div><div class="pb-menu-sep"></div>';
		menuItem('+ New project\u2026', createProject);
		if (!standalone) menuItem('Rename this project\u2026', renameProject);
		menuItem('All projects', function () { location.href = './'; });
		fetch('api/projects', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (list) {
			var box = projectMenu.querySelector('.pb-menu-list');
			box.innerHTML = '';
			if (!list.length) box.innerHTML = '<div class="pb-menu-hint">No projects yet</div>';
			list.forEach(function (p) {
				var a = document.createElement('a');
				a.className = 'pb-menu-item' + (p.id === projectId ? ' current' : '');
				a.href = 'app?project=' + encodeURIComponent(p.id);
				var name = document.createElement('span');
				name.className = 'pb-menu-name';
				name.textContent = (p.id === projectId ? '\u2713 ' : '') + p.name;
				var count = document.createElement('span');
				count.className = 'pb-menu-count';
				count.textContent = p.diagrams + (p.diagrams === 1 ? ' diagram' : ' diagrams');
				a.appendChild(name);
				a.appendChild(count);
				box.appendChild(a);
			});
		}).catch(function () {
			projectMenu.querySelector('.pb-menu-list').innerHTML = '<div class="pb-menu-hint">Couldn\u2019t load projects</div>';
		});
	}
	var projectDropdown = dropdown(projectButton, projectMenu, false, renderProjectMenu);

	function createProject() {
		var name = prompt('Name of the new project:', '');
		if (name === null) return;
		fetch('api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) })
			.then(function (r) { return r.json(); })
			.then(function (p) { location.href = 'app?project=' + encodeURIComponent(p.id) + '&diagram=' + encodeURIComponent(p.diagrams[0].id); })
			.catch(function () { showToast('Couldn\u2019t create the project. Try again.'); });
	}
	function renameProject() {
		if (project) inlineEdit(projectEl, project.name, function (name) { send({ t: 'renameProject', name: name }); });
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
		var done = false;
		function focusInput() {
			if (done || document.activeElement === input) return;
			input.focus();
			input.select();
		}
		focusInput();
		setTimeout(focusInput, 0);  // GWT may move the focus to the canvas while switching diagrams
		setTimeout(focusInput, 150);
		function finish(commit) {
			if (done) return;
			done = true;
			if (activeEdit && activeEdit.input === input) activeEdit = null;
			var v = input.value.trim();
			input.remove();
			if (commit && v && v !== value) onCommit(v);
			target.textContent = commit && v ? v : value;
			renderTabs();
		}
		input.addEventListener('keydown', function (e) {
			e.stopPropagation(); // keep UMLet shortcuts (e.g. Delete) away from the input
			if (e.key === 'Enter') { e.preventDefault(); finish(true); }
			else if (e.key === 'Escape') finish(false);
		});
		input.addEventListener('keyup', function (e) { e.stopPropagation(); e.preventDefault(); }); // a space must not click the surrounding button
		var openedAt = Date.now();
		input.addEventListener('blur', function () {
			// a blur right after opening is GWT grabbing the focus while the diagram switches, not the user leaving
			if (Date.now() - openedAt < 300) setTimeout(focusInput, 0);
			else finish(true);
		});
		activeEdit = { input: input, finish: finish };
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
	projectButton.addEventListener('dblclick', function (e) {
		e.preventDefault();
		projectDropdown.close();
		renameProject();
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
		'#projectbar .pb-project{align-self:center;font-weight:600;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 8px;border-radius:6px}',
		'#projectbar .pb-project:hover,#projectbar .pb-project[aria-expanded=true]{background:var(--pb-tab)}',
		'body.pb-standalone #projectbar .pb-tabs,body.pb-standalone #projectbar .pb-add,body.pb-standalone #projectbar .pb-trash{display:none}',
		'body.pb-standalone #projectbar .pb-project{font-weight:400;color:var(--pb-muted)}',
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
		'#projectbar .pb-me,#projectbar .pb-share,#projectbar .pb-trash,#projectbar .pb-theme{align-self:center;padding:4px 8px;border-radius:6px;white-space:nowrap}',
		'#projectbar .pb-theme{color:var(--pb-muted)}',
		'#projectbar .pb-theme:hover{background:var(--pb-tab);color:var(--pb-fg)}',
		'#projectbar .pb-trash{color:var(--pb-muted)}',
		'#projectbar .pb-trash:hover{background:var(--pb-tab);color:var(--pb-fg)}',
		'#projectbar .pb-trash[hidden]{display:none}',
		'.pb-menu{position:fixed;min-width:240px;max-width:340px;max-height:70vh;overflow-y:auto;background:var(--pb-active);color:var(--pb-fg);border:1px solid var(--pb-border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.25);padding:4px;font:13px system-ui,sans-serif;z-index:1002}',
		'.pb-menu[hidden]{display:none}',
		'.pb-menu-title{padding:6px 8px 4px;color:var(--pb-muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}',
		'.pb-menu-item{display:flex;justify-content:space-between;gap:12px;width:100%;box-sizing:border-box;padding:7px 8px;border:0;border-radius:6px;background:none;color:inherit;font:inherit;text-align:left;text-decoration:none;cursor:pointer}',
		'.pb-menu-item:hover{background:var(--pb-bg)}',
		'.pb-menu-item.current{font-weight:600}',
		'.pb-menu-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		'.pb-menu-count{color:var(--pb-muted);font-weight:400;white-space:nowrap}',
		'.pb-menu-hint{padding:7px 8px;color:var(--pb-muted)}',
		'.pb-menu-sep{height:1px;margin:4px 0;background:var(--pb-border)}',
		'.pb-trash-row{display:flex;align-items:center;gap:12px;padding:6px 8px;border-radius:6px}',
		'.pb-trash-row:hover{background:var(--pb-bg)}',
		'.pb-trash-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
		'.pb-trash-when{color:var(--pb-muted);font-size:12px}',
		'.pb-trash-row button{font:inherit;color:var(--pb-accent);background:none;border:1px solid var(--pb-border);border-radius:6px;padding:3px 8px;cursor:pointer}',
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

	if (!standalone) connect();
})();
