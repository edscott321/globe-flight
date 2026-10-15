// Loads the airports and the "i" bubbles (data/*.json) into window.FLY_DATA, then the globe, the flight numbers
// and the game, in that order. Paths are relative, so the page works from any folder on any static host.
(function () {
  'use strict';
  const get = (u) => fetch(u).then((r) => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });
  const script = (src) => new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error(src)); document.body.appendChild(s); });
  Promise.all([get('data/airports.json'), get('data/facts.json')])
    .then(([a, f]) => { window.FLY_DATA = { airports: a.airports || [], facts: f.facts || [] }; })
    .then(() => script('js/globe.js')).then(() => script('js/fly-lib.js')).then(() => script('js/fly.js'))
    .catch((e) => { console.error('boot', e); const m = document.getElementById('fly-msg'); if (m) m.textContent = 'The game did not load (' + e.message + '). Serve the folder over http, not from file://.'; });
})();
