// Project bar for collaborative UMLetino: ?project=<id>[&diagram=<id>] shows the project's diagrams as tabs,
// ?room=<name> (a standalone diagram from before projects existed) shows the bar without tabs, and without
// either the user is sent to the project list.
//
// A project is a list of diagrams; each diagram is its own collaborative room "<projectId>/<diagramId>".
// The tabs are live for everyone in the project: add (+), rename (double click), delete (x), reorder (drag),
// restore deleted diagrams (Deleted menu). Switching tabs swaps the room in place via umletCollab.switchRoom().
// Controls are Shoelace components (vendor/shoelace, bundled by collab-server/scripts/build.js); the tabs are
// styled with Shoelace's design tokens so light and dark mode follow its themes.
// Server side: Project Durable Object (collab-server/src/worker.js) / Node relay, logic in src/project.js.
(function () {
	var params = new URLSearchParams(location.search);
	var projectId = params.get('project');
	var standalone = !projectId;
	if (standalone && !params.get('room')) {
		location.replace('./');
		return;
	}

	var BAR_HEIGHT = 40;
	var ws = null;
	var project = null;       // {id, name, diagrams: [{id, name}], trash: [{id, name, deletedAt}]}
	var viewers = [];         // [{id, diagram, name, color}]
	var you = null;           // own id on the project connection
	var current = params.get('diagram');
	var requestCounter = 0;
	var pendingAdd = null;    // requestId of the diagram we created, to switch to it
	var pendingRename = null; // id of the diagram we created: rename it inline as soon as its tab exists
	var pendingSwitch = null; // id of a diagram we restored: switch to it as soon as its tab exists

	function el(tag, attrs, children) {
		var e = document.createElement(tag);
		Object.keys(attrs || {}).forEach(function (k) {
			if (k === 'text') e.textContent = attrs[k];
			else if (k === 'className') e.className = attrs[k];
			else e.setAttribute(k, attrs[k]);
		});
		(children || []).forEach(function (c) { e.appendChild(c); });
		return e;
	}
	function icon(name, slot) { return el('sl-icon', slot ? { name: name, slot: slot } : { name: name }); }
	function tooltip(content, child) { return el('sl-tooltip', { content: content, hoist: '' }, [child]); }

	// ---- DOM ------------------------------------------------------------------------
	var homeButton = el('sl-button', { variant: 'text', size: 'small', href: './', className: 'pb-home' }, [icon('chevron-left', 'prefix'), document.createTextNode('Projects')]);

	var projectNameEl = el('span', { className: 'pb-project-name' });
	var projectButton = el('sl-button', { slot: 'trigger', variant: 'text', size: 'small', caret: '', className: 'pb-project', title: 'Switch, create or rename projects' }, [projectNameEl]);
	var projectMenu = el('sl-menu', { className: 'pb-project-menu' });
	var projectDropdown = el('sl-dropdown', { hoist: '', distance: '4', placement: 'bottom-start' }, [projectButton, projectMenu]);

	var tabsEl = el('div', { className: 'pb-tabs', role: 'tablist' });
	var addButton = tooltip('New diagram', el('sl-icon-button', { name: 'plus-lg', label: 'New diagram', className: 'pb-add' }));

	var trashButton = el('sl-button', { slot: 'trigger', variant: 'text', size: 'small', caret: '' }, [icon('trash3', 'prefix'), el('span', { className: 'pb-trash-label' })]);
	var trashMenu = el('sl-menu');
	var trashDropdown = el('sl-dropdown', { hoist: '', distance: '4', placement: 'bottom-end', className: 'pb-trash' }, [trashButton, trashMenu]);

	// Insert: merge a .uxf file into the current diagram (File Import in the editor menu replaces the diagram instead)
	var insertInput = el('input', { type: 'file', accept: '.uxf,.xml', multiple: true, hidden: true });
	// shown in the editor's left menu, right below File Import/File Export (added once GWT has rendered the menu)
	var insertMenuItem = el('div', { title: 'add the elements of a uxf file to this diagram, next to what is already here', text: 'File Insert' });
	(function addInsertMenuItem() {
		var exportItem = document.querySelector('[title="export diagram to uxf or as image"]');
		if (!exportItem) return setTimeout(addInsertMenuItem, 200);
		insertMenuItem.className = exportItem.className; // same look as the other menu items
		exportItem.parentNode.insertBefore(insertMenuItem, exportItem.nextSibling);
	})();

	var historyButton = el('sl-button', { slot: 'trigger', variant: 'text', size: 'small', caret: '' }, [icon('clock-history', 'prefix'), document.createTextNode('History')]);
	var historyMenu = el('sl-menu');
	var historyDropdown = el('sl-dropdown', { hoist: '', distance: '4', placement: 'bottom-end', className: 'pb-history' }, [historyButton, historyMenu]);

	var statusEl = el('span', { className: 'pb-status' });
	var themeIcon = el('sl-icon-button', { name: 'moon', label: 'Dark mode' });
	var themeTooltip = tooltip('Dark mode', themeIcon);
	var meDot = el('span', { className: 'pb-dot', slot: 'prefix' });
	var meLabel = el('span');
	var meButton = tooltip('Change your display name', el('sl-button', { variant: 'text', size: 'small', className: 'pb-me' }, [meDot, meLabel]));
	var shareButton = el('sl-button', { size: 'small', className: 'pb-share' }, [icon('link-45deg', 'prefix'), document.createTextNode('Copy link')]);

	var bar = el('div', { id: 'projectbar' }, [
		homeButton,
		el('div', { className: 'pb-sep' }),
		projectDropdown,
		tabsEl,
		addButton,
		el('div', { className: 'pb-spacer' }),
		statusEl,
		insertInput,
		historyDropdown,
		trashDropdown,
		themeTooltip,
		meButton,
		shareButton
	]);
	var toast = el('div', { id: 'pb-toast', role: 'status' });

	function mount() {
		document.body.appendChild(bar);
		document.body.appendChild(toast);
		document.body.classList.add('has-projectbar');
		if (standalone) {
			document.body.classList.add('pb-standalone');
			projectNameEl.textContent = 'Standalone diagram';
		}
		applyBarTheme(typeof theme !== 'undefined' ? theme : 'LIGHT'); // set by the host page
		renderMe();
		window.dispatchEvent(new Event('resize')); // GWT re-lays out below the bar
	}
	if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

	// ---- theme: the host page owns it (window.setAppTheme), the bar follows ----------------
	function applyBarTheme(t) {
		var dark = t === 'DARK';
		document.documentElement.classList.toggle('sl-theme-dark', dark);
		themeIcon.setAttribute('name', dark ? 'sun' : 'moon');
		themeIcon.setAttribute('label', dark ? 'Light mode' : 'Dark mode');
		themeTooltip.setAttribute('content', dark ? 'Light mode' : 'Dark mode');
	}
	window.addEventListener('umlet-theme', function (e) { applyBarTheme(e.detail); });
	themeIcon.addEventListener('click', function () {
		window.setAppTheme(document.documentElement.classList.contains('sl-theme-dark') ? 'LIGHT' : 'DARK');
	});

	var toastTimer;
	function showToast(text) {
		toast.textContent = text;
		toast.classList.add('visible');
		clearTimeout(toastTimer);
		toastTimer = setTimeout(function () { toast.classList.remove('visible'); }, 3500);
	}

	insertMenuItem.addEventListener('click', function () { insertInput.value = ''; insertInput.click(); });
	insertInput.addEventListener('change', function () {
		Array.prototype.forEach.call(insertInput.files, function (file) {
			file.text().then(function (text) {
				var n = window.umletCollab.insertUxf(text);
				showToast(n ? 'Inserted ' + n + ' element' + (n === 1 ? '' : 's') + ' from ' + file.name : file.name + ' has no elements');
			}).catch(function (e) { showToast('Could not insert ' + file.name + ': ' + e.message); });
		});
	});

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
		projectNameEl.textContent = p.name;
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
		var box = document.getElementById('pb-missing') || document.body.appendChild(el('div', { id: 'pb-missing' }));
		box.innerHTML = '';
		box.appendChild(el('p', { text: 'This project doesn’t exist or was deleted.' }));
		box.appendChild(el('sl-button', { variant: 'primary', href: './' }, [document.createTextNode('Go to all projects')]));
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
		if (project) document.title = diagramName(current) + ' – ' + project.name + ' – UMLet';
	}

	window.addEventListener('popstate', function () {
		var id = new URLSearchParams(location.search).get('diagram');
		if (id && project && id !== current) switchTo(id, false);
	});

	// ---- tabs -----------------------------------------------------------------------
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
			var active = d.id === current;
			var tab = el('div', { className: 'pb-tab' + (active ? ' active' : ''), role: 'tab', 'aria-selected': String(active), draggable: 'true', title: d.name + '\nDouble-click to rename, drag to reorder' });
			tab.dataset.id = d.id;
			tab.appendChild(el('span', { className: 'pb-tab-name', text: d.name }));

			var others = viewers.filter(function (v) { return v.diagram === d.id && v.id !== you; });
			if (others.length) {
				var people = el('span', { className: 'pb-people' });
				others.slice(0, 4).forEach(function (v) {
					var initials = v.name.split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
					var avatar = el('span', { className: 'pb-avatar', title: v.name, text: initials });
					avatar.style.background = v.color;
					people.appendChild(avatar);
				});
				if (others.length > 4) people.appendChild(el('span', { className: 'pb-avatar pb-more', text: '+' + (others.length - 4) }));
				tab.appendChild(people);
			}

			if (project.diagrams.length > 1) {
				var close = el('sl-icon-button', { name: 'x-lg', label: 'Delete ' + d.name, className: 'pb-close' });
				close.addEventListener('click', function (e) {
					e.stopPropagation();
					if (confirm('Delete "' + d.name + '" for everyone in this project?\nYou can restore it from the Deleted menu.')) send({ t: 'remove', id: d.id });
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
		var activeTab = tabsEl.querySelector('.active');
		if (activeTab && activeTab.scrollIntoView) activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	// inline editing for diagram and project names
	function inlineEdit(target, value, onCommit) {
		var input = el('input', { className: 'pb-input', maxlength: '80', 'aria-label': 'Name' });
		input.value = value;
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

	addButton.querySelector('sl-icon-button').addEventListener('click', function () {
		pendingAdd = 'r' + (++requestCounter) + Date.now();
		send({ t: 'add', requestId: pendingAdd });
	});

	// ---- Deleted menu: deleted diagrams keep their content and can be restored by anyone ------
	function ago(time) {
		var m = Math.round((Date.now() - time) / 60000);
		if (m < 1) return 'just now';
		if (m < 60) return m + ' min ago';
		if (m < 60 * 24) return Math.round(m / 60) + ' h ago';
		return Math.round(m / 60 / 24) + ' days ago';
	}

	function renderTrash() {
		var trash = (project && project.trash) || [];
		trashDropdown.hidden = trash.length === 0;
		trashButton.querySelector('.pb-trash-label').textContent = 'Deleted (' + trash.length + ')';
		trashMenu.innerHTML = '';
		trashMenu.appendChild(el('sl-menu-label', { text: 'Restore a deleted diagram' }));
		trash.forEach(function (d) {
			var purge = el('sl-icon-button', { name: 'trash3', label: 'Delete "' + d.name + '" permanently', title: 'Delete permanently', className: 'pb-purge' });
			purge.addEventListener('click', function (e) {
				e.stopPropagation(); // not a restore
				if (confirm('Permanently delete "' + d.name + '"?\nIts content and history are erased for everyone. This cannot be undone.')) send({ t: 'purge', id: d.id });
			});
			var item = el('sl-menu-item', { value: d.id }, [
				icon('arrow-counterclockwise', 'prefix'),
				document.createTextNode(d.name),
				el('span', { slot: 'suffix', className: 'pb-suffix' }, [el('span', { className: 'pb-menu-hint', text: d.deletedAt ? ago(d.deletedAt) : '' }), purge])
			]);
			trashMenu.appendChild(item);
		});
	}
	// ---- History menu: versions of the current diagram kept by the server (hourly, and before large deletes) ----
	function when(time) {
		var d = new Date(time), now = new Date();
		var t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		if (d.toDateString() === now.toDateString()) return 'Today ' + t;
		var y = new Date(now); y.setDate(now.getDate() - 1);
		if (d.toDateString() === y.toDateString()) return 'Yesterday ' + t;
		return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + t;
	}
	function fileName(time) {
		var name = (current ? diagramName(current) : 'diagram').replace(/[\\/:*?"<>|]+/g, '_');
		return name + ' ' + new Date(time).toISOString().slice(0, 16).replace('T', ' ').replace(':', '-') + '.uxf';
	}
	function download(text, name) {
		var a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/xml' })), download: name });
		document.body.appendChild(a);
		a.click();
		setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
	}
	var versions = [];
	function renderHistory(state) {
		historyMenu.innerHTML = '';
		historyMenu.appendChild(el('sl-menu-label', { text: 'Restore this diagram to an earlier version' }));
		if (state === 'loading') return historyMenu.appendChild(el('sl-menu-item', { disabled: '' }, [el('sl-spinner', { slot: 'prefix' }), document.createTextNode('Loading…')]));
		if (state === 'error') return historyMenu.appendChild(el('sl-menu-item', { disabled: '' }, [document.createTextNode('Couldn’t load the history')]));
		if (!versions.length) historyMenu.appendChild(el('sl-menu-item', { disabled: '' }, [document.createTextNode('No versions yet (saved hourly while editing)')]));
		versions.forEach(function (v) {
			var save = el('sl-icon-button', { name: 'download', label: 'Download as .uxf', title: 'Download as .uxf' });
			save.addEventListener('click', function (e) {
				e.stopPropagation(); // not a restore
				window.umletCollab.getVersion(v.at).then(function (uxf) { download(uxf, fileName(v.at)); }).catch(function (err) { showToast('Download failed: ' + err.message); });
			});
			historyMenu.appendChild(el('sl-menu-item', { value: String(v.at) }, [
				icon('arrow-counterclockwise', 'prefix'),
				document.createTextNode(when(v.at)),
				el('span', { slot: 'suffix', className: 'pb-suffix' }, [
					el('span', { className: 'pb-menu-hint', text: v.count + ' element' + (v.count === 1 ? '' : 's') + (v.reason === 'hourly' ? '' : ' · ' + v.reason) }),
					save
				])
			]));
		});
		historyMenu.appendChild(el('sl-divider'));
		historyMenu.appendChild(el('sl-menu-item', { value: '__now' }, [icon('download', 'prefix'), document.createTextNode('Download current diagram')]));
	}
	historyDropdown.addEventListener('sl-show', function (e) {
		if (e.target !== historyDropdown) return;
		renderHistory('loading');
		window.umletCollab.listVersions().then(function (list) { versions = list; renderHistory(); }).catch(function () { renderHistory('error'); });
	});
	historyMenu.addEventListener('sl-select', function (e) {
		var value = e.detail.item.value;
		if (value === '__now') {
			var snap = window.umletCollab.currentUxf();
			return download(snap, fileName(Date.now()));
		}
		var v = versions.filter(function (x) { return String(x.at) === value; })[0];
		if (!v) return;
		var label = when(v.at).replace(/^T/, 't').replace(/^Y/, 'y');
		if (!confirm('Restore "' + (current ? diagramName(current) : 'this diagram') + '" to how it was ' + label + ' (' + v.count + ' elements)?\n\nThis replaces the diagram for everyone. The current version is kept in History, so you can undo this.')) return;
		window.umletCollab.getVersion(v.at).then(function (uxf) {
			window.umletCollab.replaceWithUxf(uxf);
			showToast('Restored the version from ' + label);
		}).catch(function (err) { showToast('Restore failed: ' + err.message); });
	});

	trashMenu.addEventListener('sl-select', function (e) {
		send({ t: 'restore', id: e.detail.item.value });
	});

	// ---- project switcher -----------------------------------------------------------
	function renderProjectMenu() {
		projectMenu.innerHTML = '';
		projectMenu.appendChild(el('sl-menu-label', { text: 'Projects' }));
		var loading = el('sl-menu-item', { disabled: '' }, [el('sl-spinner', { slot: 'prefix' }), document.createTextNode('Loading…')]);
		projectMenu.appendChild(loading);
		projectMenu.appendChild(el('sl-divider'));
		projectMenu.appendChild(el('sl-menu-item', { value: '__new' }, [icon('plus-lg', 'prefix'), document.createTextNode('New project…')]));
		if (!standalone) projectMenu.appendChild(el('sl-menu-item', { value: '__rename' }, [icon('pencil', 'prefix'), document.createTextNode('Rename this project…')]));
		projectMenu.appendChild(el('sl-menu-item', { value: '__all' }, [icon('grid', 'prefix'), document.createTextNode('All projects')]));
		fetch('api/projects', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (list) {
			var items = list.map(function (p) {
				var isCurrent = p.id === projectId;
				return el('sl-menu-item', { value: p.id }, [
					icon(isCurrent ? 'check2' : 'folder2', 'prefix'),
					document.createTextNode(p.name),
					el('span', { slot: 'suffix', className: 'pb-menu-hint', text: String(p.diagrams) })
				]);
			});
			if (!items.length) items = [el('sl-menu-item', { disabled: '' }, [document.createTextNode('No projects yet')])];
			items.forEach(function (item) { projectMenu.insertBefore(item, loading); });
			loading.remove();
		}).catch(function () {
			loading.replaceChildren(document.createTextNode('Couldn’t load projects'));
		});
	}
	projectDropdown.addEventListener('sl-show', renderProjectMenu);
	projectMenu.addEventListener('sl-select', function (e) {
		var value = e.detail.item.value;
		if (value === '__new') createProject();
		else if (value === '__rename') setTimeout(renameProject, 0);
		else if (value === '__all') location.href = './';
		else if (value && value !== projectId) location.href = 'app?project=' + encodeURIComponent(value);
	});

	function createProject() {
		var name = prompt('Name of the new project:', '');
		if (name === null) return;
		fetch('api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) })
			.then(function (r) { return r.json(); })
			.then(function (p) { location.href = 'app?project=' + encodeURIComponent(p.id) + '&diagram=' + encodeURIComponent(p.diagrams[0].id); })
			.catch(function () { showToast('Couldn’t create the project. Try again.'); });
	}
	function renameProject() {
		if (!project) return;
		var name = prompt('Rename this project:', project.name);
		if (name && name.trim() && name.trim() !== project.name) send({ t: 'renameProject', name: name.trim() });
	}

	// ---- you, sharing ---------------------------------------------------------------
	function renderMe() {
		meDot.style.background = umletCollab.me.color;
		meLabel.textContent = umletCollab.me.name;
	}
	meButton.querySelector('sl-button').addEventListener('click', function () {
		var name = prompt('Your display name (shown to others):', umletCollab.me.name);
		if (name && name.trim()) {
			umletCollab.setName(name);
			renderMe();
			announce();
		}
	});
	shareButton.addEventListener('click', function () {
		var done = function () { showToast('Link copied'); };
		if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(location.href).then(done, function () { prompt('Copy this link:', location.href); });
		else prompt('Copy this link:', location.href);
	});

	// ---- styles: Shoelace design tokens, so light and dark follow its themes ----------------
	var style = document.createElement('style');
	style.textContent = [
		'body.has-projectbar #umlet-root{top:' + BAR_HEIGHT + 'px !important}',
		'#projectbar{position:fixed;left:0;right:0;top:0;height:' + BAR_HEIGHT + 'px;display:flex;align-items:center;gap:var(--sl-spacing-2x-small);padding:0 var(--sl-spacing-x-small);box-sizing:border-box;background:var(--sl-color-neutral-50);color:var(--sl-color-neutral-900);border-bottom:1px solid var(--sl-color-neutral-200);font-family:var(--sl-font-sans);font-size:var(--sl-font-size-small);z-index:1000;user-select:none}',
		'#projectbar .pb-sep{width:1px;height:20px;background:var(--sl-color-neutral-200);margin:0 var(--sl-spacing-2x-small)}',
		'#projectbar .pb-project::part(label){font-weight:var(--sl-font-weight-semibold);max-width:220px;overflow:hidden;text-overflow:ellipsis}',
		'#projectbar .pb-tabs{position:relative;z-index:0;display:flex;align-items:stretch;align-self:stretch;gap:2px;margin-left:var(--sl-spacing-x-small);overflow-x:auto;overflow-y:hidden;min-width:0;scrollbar-width:none}',
		'#projectbar sl-button[variant=text]::part(base){color:var(--sl-color-neutral-700)}',
		'#projectbar sl-button[variant=text]::part(base):hover{color:var(--sl-color-neutral-900);background:var(--sl-color-neutral-100)}',
		'#projectbar sl-icon-button::part(base){color:var(--sl-color-neutral-600)}',
		'#projectbar sl-icon-button::part(base):hover{color:var(--sl-color-neutral-900)}',
		'#projectbar .pb-tab{position:relative;display:flex;align-items:center;gap:6px;max-width:220px;padding:0 var(--sl-spacing-2x-small) 0 var(--sl-spacing-small);color:var(--sl-color-neutral-600);cursor:pointer;white-space:nowrap}',
		'#projectbar .pb-tab::before{content:"";position:absolute;inset:6px 0;border-radius:var(--sl-border-radius-medium);z-index:-1}',
		'#projectbar .pb-tab:hover{color:var(--sl-color-neutral-900)}',
		'#projectbar .pb-tab:hover::before{background:var(--sl-color-neutral-100)}',
		'#projectbar .pb-tab.active{color:var(--sl-color-neutral-900);font-weight:var(--sl-font-weight-semibold)}',
		'#projectbar .pb-tab.active::after{content:"";position:absolute;left:var(--sl-spacing-x-small);right:var(--sl-spacing-x-small);bottom:0;height:2px;border-radius:2px;background:var(--sl-color-neutral-900)}',
		'#projectbar .pb-tab.dragging{opacity:.5}',
		'#projectbar .pb-tab.drop-target{box-shadow:inset 2px 0 0 var(--sl-color-primary-600)}',
		'#projectbar .pb-tab-name{overflow:hidden;text-overflow:ellipsis;padding:var(--sl-spacing-2x-small) 0}',
		'#projectbar .pb-close{font-size:11px;opacity:0}',
		'#projectbar .pb-tab:hover .pb-close,#projectbar .pb-tab.active .pb-close,#projectbar .pb-close:focus-within{opacity:1}',
		'#projectbar .pb-close::part(base){padding:4px}',
		'#projectbar .pb-people{display:flex;padding-left:4px}',
		'#projectbar .pb-avatar{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;margin-left:-4px;border-radius:50%;border:2px solid var(--sl-color-neutral-50);color:#fff;font-size:9px;font-weight:var(--sl-font-weight-semibold);line-height:1}',
		'#projectbar .pb-avatar.pb-more{background:var(--sl-color-neutral-500)}',
		'#projectbar .pb-add{font-size:var(--sl-font-size-medium)}',
		'#projectbar .pb-spacer{flex:1}',
		'#projectbar .pb-status{color:var(--sl-color-warning-700)}',
		'#projectbar .pb-trash[hidden]{display:none}',
		'.pb-suffix{display:inline-flex;align-items:center;gap:4px}',
		'.pb-suffix sl-icon-button::part(base){padding:2px;font-size:14px}',
		'#projectbar .pb-dot{display:inline-block;width:10px;height:10px;border-radius:50%}',
		'.pb-menu-hint{color:var(--sl-color-neutral-500);font-size:var(--sl-font-size-x-small)}',
		'sl-menu{min-width:240px;max-width:340px;max-height:70vh;overflow-y:auto}',
		'.pb-input{font:inherit;font-weight:var(--sl-font-weight-normal);width:150px;padding:2px 6px;border:1px solid var(--sl-color-primary-600);border-radius:var(--sl-border-radius-small);background:var(--sl-color-neutral-0);color:var(--sl-color-neutral-900);outline:none;box-shadow:0 0 0 2px var(--sl-color-primary-100)}',
		'body.pb-standalone #projectbar .pb-tabs,body.pb-standalone #projectbar .pb-add,body.pb-standalone #projectbar .pb-trash{display:none}',
		'body.pb-standalone #projectbar .pb-project::part(label){font-weight:var(--sl-font-weight-normal);color:var(--sl-color-neutral-600)}',
		'#pb-toast{position:fixed;left:50%;top:' + (BAR_HEIGHT + 12) + 'px;transform:translateX(-50%);background:var(--sl-color-neutral-800);color:var(--sl-color-neutral-0);padding:var(--sl-spacing-x-small) var(--sl-spacing-medium);border-radius:var(--sl-border-radius-medium);font:var(--sl-font-size-small) var(--sl-font-sans);box-shadow:var(--sl-shadow-large);opacity:0;pointer-events:none;transition:opacity .2s;z-index:1001}',
		'#pb-toast.visible{opacity:1}',
		'#pb-missing{position:fixed;inset:' + BAR_HEIGHT + 'px 0 0 0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:var(--sl-spacing-medium);background:var(--sl-color-neutral-50);color:var(--sl-color-neutral-700);font:var(--sl-font-size-medium) var(--sl-font-sans);z-index:999}',
		'body.pb-missing #projectbar .pb-add,body.pb-missing #projectbar .pb-share{display:none}'
	].join('\n');
	document.head.appendChild(style);

	if (!standalone) connect();
})();
