// Browser side of the project API, shared by the project list page and the editor.
// The server has no public list of projects (a project's id is its only protection), so each browser keeps the list of
// the projects it has opened or created, and asks the server for their details. Creating a project goes through the
// captcha (Cloudflare Turnstile) when the server has one switched on, and failures come back as readable messages.
(function () {
	var KEY = 'umletcollab.projects';
	var MAX_KNOWN = 100; // the server looks up at most this many ids per request
	var JSON_HEADERS = { 'Content-Type': 'application/json' };

	// ---- the projects this browser knows ----------------------------------------------
	function read() {
		try {
			var list = JSON.parse(localStorage.getItem(KEY));
			return Array.isArray(list) ? list.filter(function (p) { return p && typeof p.id === 'string'; }) : [];
		} catch (e) { return []; }
	}
	function write(list) {
		try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_KNOWN))); } catch (e) { /* private window: not remembered */ }
	}

	// most recently opened first
	function remember(id, name) {
		var list = read().filter(function (p) { return p.id !== id; });
		list.unshift({ id: id, name: String(name || ''), at: Date.now() });
		write(list);
	}

	function forget(id) {
		write(read().filter(function (p) { return p.id !== id; }));
	}

	// details of the known projects (newest edit first); ids the server no longer has are dropped from the list
	function lookup() {
		var known = read();
		if (!known.length) return Promise.resolve([]);
		return fetch('api/projects/lookup', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ids: known.map(function (p) { return p.id; }) }) })
			.then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
			.then(function (found) {
				var byId = {};
				found.forEach(function (p) { byId[p.id] = p; });
				write(known.filter(function (p) { return byId[p.id]; }).map(function (p) { return { id: p.id, name: byId[p.id].name, at: p.at }; }));
				return found.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
			});
	}

	// ---- captcha ------------------------------------------------------------------------
	var turnstileLoading = null;
	function loadTurnstile() {
		if (window.turnstile) return Promise.resolve(window.turnstile);
		if (!turnstileLoading) {
			turnstileLoading = new Promise(function (resolve, reject) {
				var script = document.createElement('script');
				script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
				script.async = true;
				script.onload = function () { window.turnstile ? resolve(window.turnstile) : reject(new Error('The captcha could not start. Reload the page and try again.')); };
				script.onerror = function () { turnstileLoading = null; reject(new Error('Couldn’t load the captcha. Check your connection or any blocker you use, then try again.')); };
				document.head.appendChild(script);
			});
		}
		return turnstileLoading;
	}

	// the widget stays invisible unless it needs the person to do something; only then is it shown, in a small card
	function captchaToken(siteKey) {
		return loadTurnstile().then(function (turnstile) {
			return new Promise(function (resolve, reject) {
				var overlay = document.createElement('div');
				overlay.style.cssText = 'position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.35);z-index:2000;font:14px system-ui,sans-serif';
				var card = document.createElement('div');
				card.style.cssText = 'background:#fff;color:#222;padding:20px 24px;border-radius:10px;box-shadow:0 10px 40px rgba(0,0,0,.3);text-align:center';
				var label = document.createElement('p');
				label.style.margin = '0 0 12px';
				label.textContent = 'One quick check before your project is created';
				var holder = document.createElement('div');
				card.appendChild(label);
				card.appendChild(holder);
				overlay.appendChild(card);
				document.body.appendChild(overlay);

				var widget, finished = false, timer;
				function finish(fn, value) {
					if (finished) return;
					finished = true;
					clearTimeout(timer);
					try { turnstile.remove(widget); } catch (e) { /* already gone */ }
					overlay.remove();
					fn(value);
				}
				timer = setTimeout(function () { finish(reject, new Error('The captcha took too long. Reload the page and try again.')); }, 60000);
				widget = turnstile.render(holder, {
					sitekey: siteKey,
					action: 'create_project',
					appearance: 'interaction-only',
					callback: function (token) { finish(resolve, token); },
					'error-callback': function () { finish(reject, new Error('The captcha could not run. Reload the page and try again.')); },
					'timeout-callback': function () { finish(reject, new Error('The captcha expired. Try again.')); },
					'before-interactive-callback': function () { overlay.style.display = 'flex'; },
					'after-interactive-callback': function () { overlay.style.display = 'none'; }
				});
			});
		});
	}

	// ---- creating a project -----------------------------------------------------------------
	function describe(data) {
		if (data && data.error === 'project_limit') {
			var when = data.retryAt ? new Date(data.retryAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) : '';
			return 'You can create up to ' + data.limit + ' new projects per ' + data.days + ' days from one network.' + (when ? ' You can create another on ' + when + '.' : '');
		}
		return (data && data.message) || 'Couldn’t create the project. Try again.';
	}

	// resolves with the new project ({id, name, diagrams: [...]}); rejects with an Error whose message can be shown as is
	function create(name) {
		return fetch('api/config', { cache: 'no-store' })
			.then(function (r) { return r.ok ? r.json() : {}; }, function () { return {}; })
			.then(function (config) { return config.turnstileSiteKey ? captchaToken(config.turnstileSiteKey) : null; })
			.then(function (token) {
				return fetch('api/projects', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: name, token: token }) })
					.catch(function () { throw new Error('Couldn’t reach the server. Check your connection and try again.'); });
			})
			.then(function (r) {
				return r.json().catch(function () { return null; }).then(function (data) {
					if (!r.ok || !data || !data.id) throw new Error(describe(data));
					remember(data.id, data.name);
					return data;
				});
			});
	}

	window.umletProjects = { remember: remember, forget: forget, lookup: lookup, create: create };
})();
