// The globe the airplane flies over. An orthographic projection (d3-geo) drawn on one canvas: zoomed out it is a
// globe; zoomed in you see a smaller and smaller patch of the sphere, so the curvature fades away.
//
// This is the homepage globe from ethandavidmagalei.com cut down to its fly mode: no dragging or wheel zoom (the
// airplane is the camera, moved by js/fly.js through window.__globe.look), and the "i" bubbles show only when
// fly.js says so (below 3,000 feet).
//
// Map data (all in globe-data/):
//   world-110.json, world-50.json  Natural Earth 1:110m and 1:50m land, lakes, rivers (public domain)
//   t10/                           Natural Earth 1:10m in 10-degree tiles, loaded once zoomed in (public domain)
//   mountains.json                 Natural Earth 1:10m mountain ranges and named peaks (public domain)
//   osm/                           OpenStreetMap streets, water and parks for three regions (Heber Valley, Utah;
//                                  the Stanford area; Fallen Leaf Lake), © OpenStreetMap contributors, ODbL
(function () {
  'use strict';
  const zone = document.getElementById('geo-map-zone');
  if (!zone) return;

  const D3 = 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js';
  const D3_SRI = 'sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i';
  const SITE = 'https://ethandavidmagalei.com';   // links inside a fact that point at the original site
  const TAU = Math.PI * 2;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const gfetch = (u) => fetch('globe-data/' + u);

  load();

  function load() {
    const s = document.createElement('script'); s.src = D3; s.integrity = D3_SRI; s.crossOrigin = 'anonymous';
    const fail = (e) => { console.error('globe', e); zone.classList.add('is-failed'); };
    s.onload = () => gfetch('world-110.json').then((r) => { if (!r.ok) throw new Error('world-110 ' + r.status); return r.json(); }).then((w) => start(unpack(w))).catch(fail);
    s.onerror = () => fail(new Error('d3 did not load'));
    document.head.appendChild(s);
  }

  // The packed Natural Earth files: delta-encoded integer rings.
  function unpack(w) {
    const ring = (a) => { const out = []; let x = 0, y = 0; for (let i = 0; i < a.length; i += 2) { x += a[i]; y += a[i + 1]; out.push([x * w.q, y * w.q]); } return out; };
    const closed = (r) => { const p = ring(r); if (p.length && (p[0][0] !== p[p.length - 1][0] || p[0][1] !== p[p.length - 1][1])) p.push(p[0]); return p; };
    // Each shape keeps its bounding box, so the globe can hand the projection only what's near the screen.
    const box = (pts) => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const [x, y] of pts) { if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; } return [a, b, c, d]; };
    const polys = (list) => list.map((p) => { const rings = p.map(closed); return { c: rings, b: box(rings[0]) }; });
    const lines = (list) => list.map((l) => { const c = ring(l); return { c, b: box(c) }; });
    const L = polys(w.land), K = polys(w.lakes), R = lines(w.rivers);
    return {
      land: { type: 'MultiPolygon', coordinates: L.map((x) => x.c) }, lakes: { type: 'MultiPolygon', coordinates: K.map((x) => x.c) },
      rivers: { type: 'MultiLineString', coordinates: R.map((x) => x.c) }, parts: { land: L, lakes: K, rivers: R },
      isles: w.isles || [],
    };
  }

  function start(world110) {
    const d3 = window.d3;
    const scroller = document.getElementById('geo-map-scroller');
    // The globe's layers: a canvas, and a layer over it for the "i" bubbles and their cards.
    const cv = document.createElement('canvas'); cv.className = 'geo-globe-canvas'; cv.setAttribute('aria-hidden', 'true');
    const layer = document.createElement('div'); layer.className = 'geo-pin-overlay geo-globe-pins';
    scroller.append(cv, layer);
    const ctx = cv.getContext('2d');
    let W = 0, H = 0, DPR = 1, R0 = 1;
    let world = world110, world50 = null, loading50 = false;

    // View: rotation (the point facing us) and zoom k (1 = the whole globe fits). fly.js moves it every frame.
    const KMAX = 3000;
    const view = { lon: -111.98, lat: 40.79, k: 40 };
    const proj = d3.geoOrthographic().clipAngle(90).precision(0.4);
    const path = d3.geoPath(proj, ctx);
    const grat = d3.geoGraticule10();
    function setProj() { proj.rotate([-view.lon, -view.lat]).scale(R0 * view.k).translate([W / 2, H / 2]); }

    function size() {
      const r = zone.getBoundingClientRect(); W = r.width; H = r.height; DPR = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR); cv.style.width = W + 'px'; cv.style.height = H + 'px';
      R0 = Math.min(W, H) * 0.42; dirty();
    }

    // ---------- the fast path (zoomed in) ----------
    // Zoomed in, the globe's edge is never on screen, so the general projection's clipping and resampling aren't
    // needed. Each point's place on the sphere (cosφ·sinλ, cosφ·cosλ, sinφ) is worked out once when its tile loads;
    // turning the view then costs a few multiplications a point.
    const RAD = Math.PI / 180;
    function prep(coords) {
      const f = new Float32Array(coords.length * 3); let w = 1e9, so = 1e9, e = -1e9, n = -1e9;
      for (let i = 0; i < coords.length; i++) {
        const lng = coords[i][0], lat = coords[i][1], l = lng * RAD, p = lat * RAD, cp = Math.cos(p);
        f[i * 3] = cp * Math.sin(l); f[i * 3 + 1] = cp * Math.cos(l); f[i * 3 + 2] = Math.sin(p);
        if (lng < w) w = lng; if (lng > e) e = lng; if (lat < so) so = lat; if (lat > n) n = lat;
      }
      return { f, w, s: so, e, n };
    }
    let F = null;   // this frame's constants
    function frameConsts() { const l0 = view.lon * RAD, p0 = view.lat * RAD; F = { cl0: Math.cos(l0), sl0: Math.sin(l0), cp0: Math.cos(p0), sp0: Math.sin(p0), s: R0 * view.k, cx: W / 2, cy: H / 2, box: screenBox() }; }
    function trace(it, close, minPx = 0.9) {
      const f = it.f, cl0 = F.cl0, sl0 = F.sl0, cp0 = F.cp0, sp0 = F.sp0, sc = F.s, cx = F.cx, cy = F.cy, last = f.length - 3;
      // A line (not a filled shape) whose pen and next point are both past the same edge of the screen has
      // nothing to show there: the pen jumps instead. `lc` = which edges the pen is past.
      const M = 6, x1 = W + M, y1 = H + M, edges = (x, y) => (x < -M ? 1 : x > x1 ? 2 : 0) | (y < -M ? 4 : y > y1 ? 8 : 0);
      let lx = 0, ly = 0, lc = 0, held = false;
      for (let i = 0; i < f.length; i += 3) {
        const a = f[i], b = f[i + 1], x = cx + sc * (a * cl0 - b * sl0), y = cy - sc * (cp0 * f[i + 2] - sp0 * (b * cl0 + a * sl0));
        if (!i) { ctx.moveTo(x, y); lx = x; ly = y; lc = close ? 0 : edges(x, y); continue; }
        const c = close ? 0 : edges(x, y);
        if (c & lc) { lx = x; ly = y; lc = c; held = true; continue; }
        if (held) { ctx.moveTo(lx, ly); held = false; }
        // A point under a pixel from the last one drawn adds nothing you can see.
        else if (i < last && Math.abs(x - lx) + Math.abs(y - ly) < minPx) continue;
        ctx.lineTo(x, y); lx = x; ly = y; lc = c;
      }
      if (close) ctx.closePath();
    }
    // The world files' shapes near the screen (all of them while the globe's edge shows).
    function nearParts(kind) {
      const all = world.parts[kind], b = F.box;
      if (!b) return all;
      const m = (b[2] - b[0]) * 0.15 + 1;
      return all.filter((x) => x.b[2] - x.b[0] > 180 || !(x.b[2] < b[0] - m || x.b[0] > b[2] + m || x.b[3] < b[1] - m || x.b[1] > b[3] + m));
    }
    // Each world shape knows the cap of sphere it covers (worked out once): shapes wholly on the near side go by
    // the fast path, shapes wholly behind are skipped, and only those crossing the edge go through d3's clipping.
    function capOf(rings) {
      if (rings.cap) return rings.cap;
      const f = rings[0].f; let x = 0, y = 0, z = 0;
      for (let i = 0; i < f.length; i += 3) { x += f[i]; y += f[i + 1]; z += f[i + 2]; }
      const L = Math.hypot(x, y, z) || 1; x /= L; y /= L; z /= L; let lo = 1;
      for (let i = 0; i < f.length; i += 3) { const d = x * f[i] + y * f[i + 1] + z * f[i + 2]; if (d < lo) lo = d; }
      return (rings.cap = { x, y, z, r: L < 1e-6 ? Math.PI : Math.acos(clamp(lo, -1, 1)) });
    }
    function chunkCaps(fp) {   // each ring cut into stretches of 128 points, each with its own cap
      const out = [];
      for (const r of fp) for (let i = 0; i < r.f.length; i += 128 * 3) { const piece = { f: r.f.subarray(i, Math.min(r.f.length, i + 129 * 3)) }; out.push(capOf([piece])); }
      return out;
    }
    function sortParts(kind, isLine) {
      const fast = [], slow = [], vx = F.cp0 * F.sl0, vy = F.cp0 * F.cl0, vz = F.sp0; let cover = false;
      // How far from the middle of the view the screen reaches, as an angle on the sphere (all of it while the edge shows).
      const reach = F.box ? Math.asin(Math.min(1, Math.hypot(W, H) / 2 / (R0 * view.k))) + 0.05 : 1.62;
      for (const x of nearParts(kind)) {
        if (!x.fp) { x.fp = isLine ? [prep(x.c)] : x.c.map(prep); }
        const c = capOf(x.fp), ang = Math.acos(clamp(vx * c.x + vy * c.y + vz * c.z, -1, 1));
        if (ang - c.r > Math.min(1.62, reach)) continue;      // wholly behind the globe, or nowhere near the screen
        if (ang + c.r < 1.5) { fast.push(x.fp); continue; }  // wholly in front: no clipping needed
        // A continent that crosses the horizon: if no stretch of its outline reaches the screen, it either
        // covers the whole screen (we're over its middle) or none of it; one cached check says which.
        if (F.box && !isLine) {
          if (!x.chunks) x.chunks = chunkCaps(x.fp);
          if (!x.chunks.some((q) => Math.acos(clamp(vx * q.x + vy * q.y + vz * q.z, -1, 1)) - q.r <= reach)) {
            const here = [view.lon, view.lat];
            if (!x.inside || d3.geoDistance(x.inside.at, here) > reach * 0.5) x.inside = { at: here, yes: d3.geoContains({ type: 'Polygon', coordinates: x.c }, here) };
            if (x.inside.yes) cover = true;
            continue;
          }
        }
        slow.push(x);
      }
      return { fast, slow, cover };
    }
    function drawWorld(kind, fill) {
      const { fast, slow, cover } = sortParts(kind, !fill);
      if (cover && fill) ctx.fillRect(0, 0, W, H);   // over the middle of a continent (or lake): it fills the screen
      ctx.beginPath();
      for (const rings of fast) if (onScreen(rings[0])) for (const r of rings) trace(r, fill);
      if (fill) ctx.fill('evenodd'); ctx.stroke();
      if (!slow.length) return;
      if (!fill) { ctx.beginPath(); path({ type: 'MultiLineString', coordinates: slow.map((x) => x.c) }); ctx.stroke(); return; }
      // d3's clipping at the edge now and then hands a shape back inside out; filled, it would cover the whole
      // globe. Seen on the globe, a shape never looks bigger than it really is, so each one is drawn into its own
      // path while its area is added up, and one that comes out bigger than its real area is left out of this frame.
      const all = new Path2D(), s2 = F.s * F.s;
      for (const x of slow) {
        if (x.area == null) { const a = d3.geoArea({ type: 'Polygon', coordinates: x.c }); x.area = Math.min(a, 4 * Math.PI - a); }
        rec.start(); recPath({ type: 'Polygon', coordinates: x.c });
        if (Math.abs(rec.a) / 2 <= x.area * s2 * 1.05 + 50) all.addPath(rec.p);
      }
      ctx.fill(all); ctx.stroke(all);
    }
    // A drawing context for d3 that keeps one shape's path and its area on screen (the shoelace sum).
    const rec = {
      p: null, a: 0, x0: 0, y0: 0, x: 0, y: 0,
      start() { this.p = new Path2D(); this.a = 0; },
      moveTo(x, y) { this.p.moveTo(x, y); this.x0 = this.x = x; this.y0 = this.y = y; },
      lineTo(x, y) { this.p.lineTo(x, y); this.a += this.x * y - x * this.y; this.x = x; this.y = y; },
      closePath() { this.p.closePath(); this.a += this.x * this.y0 - this.x0 * this.y; this.x = this.x0; this.y = this.y0; },
      arc(x, y, r) { this.p.moveTo(x + r, y); this.p.arc(x, y, r, 0, TAU); },
    };
    const recPath = d3.geoPath(proj, rec);
    function onScreen(it) { const b = F.box; if (!b) return true; const m = (b[2] - b[0]) * 0.08 + 0.002; return !(it.e < b[0] - m || it.w > b[2] + m || it.n < b[1] - m || it.s > b[3] + m); }
    const strokeAll = (items, minPx) => { ctx.beginPath(); for (const it of items) if (onScreen(it)) trace(it, false, minPx); ctx.stroke(); };
    // Rivers and roads are thin, faint lines: a point every 2 px is as smooth to the eye. Coastlines keep every pixel.
    const FAINT_PX = 2;
    const fillAll = (polys) => { ctx.beginPath(); for (const rings of polys) if (onScreen(rings[0])) for (const r of rings) trace(r, true); ctx.fill('evenodd'); };
    // A point: on the near side? and where on screen.
    function fastPt(ll) {
      const l = ll[0] * RAD, p = ll[1] * RAD, cp = Math.cos(p), a = cp * Math.sin(l), b = cp * Math.cos(l), c = Math.sin(p);
      if (F.sp0 * c + F.cp0 * (b * F.cl0 + a * F.sl0) < 0.05) return null;   // behind the globe
      return [F.cx + F.s * (a * F.cl0 - b * F.sl0), F.cy - F.s * (F.cp0 * c - F.sp0 * (b * F.cl0 + a * F.sl0))];
    }

    // ---------- the data by zoom ----------
    // 1:110m, then 1:50m (k > 2.5), then the 1:10m tiles for what's on screen (k > TILE_K).
    const TILE_K = 10;
    const tiles = new Map(); let tileIndex = null;   // name -> decoded tile | 'loading'
    gfetch('t10/index.json').then((r) => r.json()).then((a) => { tileIndex = new Set(a); dirty(); }).catch(() => {});
    let mountains = null;
    gfetch('mountains.json').then((r) => r.json()).then((m) => { mountains = unpackMountains(m); dirty(); }).catch(() => {});
    function unpackMountains(m) {
      const pairs = (a, q) => { const out = []; for (let i = 0; i < a.length; i += 2) out.push([a[i] * q, a[i + 1] * q]); return out; };
      return { ranges: m.ranges.map((r) => ({ n: r.n, r: r.r, c: r.c, g: r.g.map((a) => pairs(a, m.q)) })), peaks: m.peaks.map(([lng, lat, el, n, r]) => ({ ll: [lng, lat], el, n, r })) };
    }
    function unpackTile(t) {
      const lineQ = (a) => { const out = []; let x = 0, y = 0; for (let i = 0; i < a.length; i += 2) { x += a[i]; y += a[i + 1]; out.push([x * t.q, y * t.q]); } return out; };
      const poly = (p) => p.map(lineQ);
      const roads = [[], [], [], []]; (t.roads || []).forEach(([c, l]) => roads[c].push(lineQ(l)));
      const P = (ls) => ls.map((l) => prep(l)), PP = (ps) => ps.map((p) => p.map((r) => prep(r)));
      return {
        land: PP(t.land.map(poly)), coast: P(t.coast.map(lineQ)), lakes: PP(t.lakes.map(poly)), shore: P(t.shore.map(lineQ)),
        rivers: P(t.rivers.map(lineQ)), roads: roads.map(P),
        places: t.places.map(([x, y, r, n]) => ({ ll: [x * t.q, y * t.q], r, n })),
        m: t.m ? t.m.map((a) => { const out = []; for (let i = 0; i < a.length; i += 2) out.push([a[i] * t.mq, a[i + 1] * t.mq]); return out; }) : [[], []],
      };
    }
    // The lng/lat box the screen covers (null when the globe's edge is in view: then sample instead).
    function screenBox() {
      let w = 999, s0 = 999, e = -999, n = -999, ok = true;
      for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
        const p = proj.invert([W * i / 8, H * j / 8]);
        if (!p || isNaN(p[0]) || d3.geoDistance(p, [view.lon, view.lat]) > Math.PI / 2 - 0.01) { ok = false; continue; }
        w = Math.min(w, p[0]); e = Math.max(e, p[0]); s0 = Math.min(s0, p[1]); n = Math.max(n, p[1]);
      }
      return ok && e - w < 180 ? [w, s0, e, n] : null;
    }
    // The tiles under the screen: 10° cells.
    function visibleTiles() {
      const names = new Set(), key = (lng, lat) => (Math.floor((lng + 180) / 10) * 10 - 180) + '_' + (Math.floor((lat + 90) / 10) * 10 - 90), b = screenBox();
      if (b) { for (let x = Math.floor((b[0] + 180) / 10); x <= Math.floor((b[2] + 180) / 10); x++) for (let y = Math.floor((b[1] + 90) / 10); y <= Math.floor((b[3] + 90) / 10); y++) names.add((x * 10 - 180) + '_' + (y * 10 - 90)); return [...names]; }
      for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) {
        const p = proj.invert([W * i / 12, H * j / 12]); if (!p || isNaN(p[0]) || d3.geoDistance(p, [view.lon, view.lat]) > Math.PI / 2) continue;
        names.add(key(p[0], p[1]));
      }
      return [...names];
    }
    function tilesNow() {
      if (view.k < TILE_K || !tileIndex) return [];
      const out = [];
      visibleTiles().forEach((n) => {
        if (!tileIndex.has(n)) return;
        const t = tiles.get(n);
        if (t && t !== 'loading') out.push(t);
        else if (!t) { tiles.set(n, 'loading'); gfetch('t10/' + n + '.json').then((r) => r.json()).then((d) => { tiles.set(n, unpackTile(d)); dirty(); }).catch(() => tiles.delete(n)); }
      });
      return out;
    }

    // OpenStreetMap detail for three regions (Heber Valley, the Stanford area and the Bay Area's main roads,
    // Fallen Leaf Lake), 0.1° tiles loaded once zoomed in (OSM_K) over a region.
    const OSM_K = 40, TOWN_K = 150, OSM = ['heber', 'stanford', 'fallen-leaf'].map((id) => ({ id, index: null, tiles: new Map() }));
    let osmShown = false;
    function osmNow() {
      if (view.k < OSM_K) return [];
      const c = [view.lon, view.lat], out = [];
      OSM.forEach((R) => {
        if (R.index === null) { R.index = 'loading'; gfetch('osm/' + R.id + '/index.json').then((r) => r.json()).then((ix) => { R.index = { ...ix, set: new Set(ix.tiles) }; dirty(); }).catch(() => { R.index = null; }); return; }
        if (R.index === 'loading') return;
        const [w, s0, e, n] = R.index.bbox; if (c[0] < w - 1 || c[0] > e + 1 || c[1] < s0 - 1 || c[1] > n + 1) return;
        // Every tile inside the box the screen covers.
        const names = new Set(), b = screenBox(); if (!b) return;
        for (let i = Math.floor(b[0] / R.index.ts); i <= Math.floor(b[2] / R.index.ts); i++) for (let j = Math.floor(b[1] / R.index.ts); j <= Math.floor(b[3] / R.index.ts); j++) names.add(i + '_' + j);
        names.forEach((nm) => {
          if (!R.index.set.has(nm)) return; const t = R.tiles.get(nm);
          if (t && t !== 'loading') out.push(t);
          else if (!t) { R.tiles.set(nm, 'loading'); gfetch('osm/' + R.id + '/' + nm + '.json').then((r) => r.json()).then((d) => { R.tiles.set(nm, unpackOsm(d)); dirty(); }).catch(() => R.tiles.delete(nm)); }
        });
      });
      return out;
    }
    function unpackOsm(t) {
      const line = (a) => { const out = []; let x = 0, y = 0; for (let i = 0; i < a.length; i += 2) { x += a[i]; y += a[i + 1]; out.push([x * t.q, y * t.q]); } return out; };
      // (Drawn by the fast path, filled even-odd on the flat screen, so an outline's direction doesn't matter.)
      const kinds = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.map(([id, pk]) => Object.assign(prep(line(pk)), { id }))]));
      return { lines: kinds(t.lines), areas: kinds(t.areas), peaks: t.peaks.map(([x, y, n, el]) => ({ ll: [x * t.q, y * t.q], n, el })), places: t.places.map(([x, y, r, n]) => ({ ll: [x * t.q, y * t.q], r, n })) };
    }

    // Peak symbols: a few drawn once (lit face, shaded right face, snow on the tall ones), then stamped.
    const SPRITES = [0, 1, 2, 3].map((v) => {
      const c = document.createElement('canvas'), S = 64; c.width = S; c.height = S; const g = c.getContext('2d');
      const ax = S * (0.42 + v * 0.05), top = S * (0.12 + (v % 2) * 0.08), base = S * 0.94, l = S * 0.06, r = S * 0.94;
      const ridge = [[l, base], [S * 0.22, S * (0.66 - v * 0.03)], [S * 0.3, S * 0.58], [ax, top], [S * 0.62, S * 0.5], [S * 0.72, S * 0.56], [r, base]];
      g.beginPath(); ridge.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fillStyle = '#3a6688'; g.fill();
      g.beginPath(); g.moveTo(ax, top); [[S * 0.62, S * 0.5], [S * 0.72, S * 0.56], [r, base], [ax + S * 0.04, base], [ax + S * 0.02, S * 0.6]].forEach(([x, y]) => g.lineTo(x, y)); g.closePath(); g.fillStyle = '#22405c'; g.fill();
      if (v < 2) { g.beginPath(); g.moveTo(ax - S * 0.1, top + S * 0.17); g.lineTo(ax, top); g.lineTo(ax + S * 0.11, top + S * 0.19); g.lineTo(ax + S * 0.03, top + S * 0.14); g.lineTo(ax - S * 0.03, top + S * 0.2); g.closePath(); g.fillStyle = 'rgba(214,240,248,0.85)'; g.fill(); }
      g.strokeStyle = 'rgba(101,244,244,0.35)'; g.lineWidth = 1.2; g.beginPath(); ridge.slice(1, -1).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
      return c;
    });
    const hash = (a, b) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
    const front = (ll, lim) => d3.geoDistance(ll, [view.lon, view.lat]) < (lim || Math.PI / 2 - 0.08);
    function stamp(ll, s, variant, alpha) { const p = fastPt(ll); if (!p || p[0] < -s || p[0] > W + s || p[1] < -s || p[1] > H + s) return null; ctx.globalAlpha = alpha; ctx.drawImage(SPRITES[variant], p[0] - s / 2, p[1] - s * 0.9, s, s); return p; }

    // Labels: a simple grid of taken cells, so names don't pile up.
    let taken;
    function label(text, x, y, font, color, w) { const cw = 18, ch = 14, c0 = Math.floor((x - w / 2) / cw), c1 = Math.floor((x + w / 2) / cw), r0 = Math.floor((y - 10) / ch), r1 = Math.floor((y + 4) / ch); for (let i = c0; i <= c1; i++) for (let j = r0; j <= r1; j++) if (taken.has(i + ',' + j)) return false; for (let i = c0; i <= c1; i++) for (let j = r0; j <= r1; j++) taken.add(i + ',' + j); ctx.font = font; ctx.fillStyle = color; ctx.fillText(text, x, y); return true; }

    // ---------- layers, drawn in this order ----------
    const LAYERS = [
      { id: 'sea', draw(t, r) {
        if (r < Math.max(W, H)) { const g = ctx.createRadialGradient(W / 2, H / 2, r * 0.96, W / 2, H / 2, r * 1.12); g.addColorStop(0, 'rgba(101,244,244,0.22)'); g.addColorStop(1, 'rgba(101,244,244,0)'); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(W / 2, H / 2, r * 1.12, 0, TAU); ctx.fill(); }
        const sea = ctx.createRadialGradient(W / 2 - r * 0.35, H / 2 - r * 0.4, r * 0.1, W / 2, H / 2, r); sea.addColorStop(0, '#1c3358'); sea.addColorStop(1, '#0c1a2e');
        ctx.fillStyle = r < Math.max(W, H) * 2 ? sea : '#13243f'; ctx.beginPath(); path({ type: 'Sphere' }); ctx.fill();
        ctx.strokeStyle = 'rgba(101,244,244,0.07)'; ctx.lineWidth = 1; ctx.beginPath(); path(grat); ctx.stroke();
      } },
      { id: 'land', draw(t) {
        ctx.fillStyle = '#1e3a52'; ctx.strokeStyle = 'rgba(101,244,244,0.75)'; ctx.lineWidth = view.k > 6 ? 1.2 : 0.9;
        if (t.length) { fillAll(t.flatMap((x) => x.land)); strokeAll(t.flatMap((x) => x.coast)); }
        else drawWorld('land', true);
      } },
      { id: 'water', draw(t) {
        ctx.fillStyle = '#16294a'; ctx.strokeStyle = 'rgba(101,244,244,0.45)'; ctx.lineWidth = 0.7;
        if (t.length) { fillAll(t.flatMap((x) => x.lakes)); strokeAll(t.flatMap((x) => x.shore)); }
        else drawWorld('lakes', true);
        ctx.strokeStyle = 'rgba(101,244,244,' + (view.k > 4 ? 0.38 : 0.2) + ')'; ctx.lineWidth = view.k > 20 ? 1 : 0.7;
        if (t.length) strokeAll(t.flatMap((x) => x.rivers), FAINT_PX); else drawWorld('rivers', false);
      } },
      // The Pacific islands: a dot keeps each small island visible while it's under a pixel, and the island
      // nations and territories are named as you come closer.
      { id: 'pacific', draw() {
        if (view.k < TILE_K) {
          ctx.fillStyle = 'rgba(101,244,244,0.8)'; const rr = view.k < 2 ? 1 : 1.4;
          ctx.beginPath(); for (const ll of world.isles) { const p = fastPt(ll); if (p) { ctx.moveTo(p[0] + rr, p[1]); ctx.arc(p[0], p[1], rr, 0, TAU); } } ctx.fill();
        }
        if (view.k < 1.3 || view.k > 40) return;
        ctx.textAlign = 'center';
        PACIFIC.forEach(([n, lng, lat, star]) => {
          if (!front([lng, lat]) || (!star && view.k < 2)) return; const p = proj([lng, lat]); if (!p) return;
          label(n, p[0], p[1] - 9, (star ? '600 12px ' : '11px ') + FONT, star ? 'rgba(230,248,250,0.92)' : 'rgba(200,230,238,0.75)', n.length * 6.5);
        });
      } },
      { id: 'roads', draw(t) {
        if (!t.length || osmShown) return;   // where OpenStreetMap's own roads show, the coarse world ones would only draw stray straight lines
        [[1, 8, 1.1, 0.5], [2, 16, 0.8, 0.4], [3, 40, 0.6, 0.3]].forEach(([c, kmin, w, a]) => { if (view.k < kmin) return; ctx.strokeStyle = 'rgba(232,200,140,' + a + ')'; ctx.lineWidth = w; strokeAll(t.flatMap((x) => x.roads[c]), FAINT_PX); });
      } },
      { id: 'local', draw() {
        const o = osmNow(); osmShown = o.length > 0; if (!o.length) return;
        const seen = new Set(), once = (list) => list.filter((x) => !seen.has(x.id) && seen.add(x.id));
        // Town areas: a soft warm fill under everything, so a town reads as a shape where its streets thin out.
        if (view.k >= TOWN_K) { ctx.fillStyle = 'rgba(245,220,170,0.1)'; ctx.beginPath(); for (const a of once(o.flatMap((t) => t.areas.town || []))) if (onScreen(a)) trace(a, true); ctx.fill('nonzero'); }
        const water = once(o.flatMap((t) => t.areas.water));
        ctx.fillStyle = '#16294a'; ctx.strokeStyle = 'rgba(101,244,244,0.5)'; ctx.lineWidth = 0.8;
        ctx.beginPath(); for (const a of water) if (onScreen(a)) trace(a, true); ctx.fill('evenodd'); ctx.stroke();
        ctx.fillStyle = 'rgba(60,140,110,0.18)'; ctx.beginPath(); for (const a of once(o.flatMap((t) => t.areas.park))) if (onScreen(a)) trace(a, true); ctx.fill('evenodd');
        const k = view.k;
        // Streets bright and early; trails later and fainter; streams quiet.
        [['stream', 90, 'rgba(101,244,244,0.32)', 0.8, null], ['trail', 260, 'rgba(240,215,160,0.32)', 0.8, [3, 3]], ['street', OSM_K, 'rgba(245,220,170,0.7)', 1.1, null], ['major', OSM_K, 'rgba(250,222,165,0.85)', 1.9, null]].forEach(([kind, kmin, col, w, dash]) => {
          if (k < kmin) return; ctx.strokeStyle = col; ctx.lineWidth = w * Math.min(1.8, Math.max(1, k / 600)); ctx.setLineDash(dash || []);
          strokeAll(once(o.flatMap((t) => t.lines[kind])));
        });
        ctx.setLineDash([]);
        // Only the tallest few peaks, and only up close.
        if (k >= 500) o.flatMap((t) => t.peaks).filter((p) => { const q = proj(p.ll); return q && q[0] > 0 && q[0] < W && q[1] > 0 && q[1] < H; }).sort((a, b) => (parseFloat(b.el) || 0) - (parseFloat(a.el) || 0)).slice(0, 4).forEach((p) => {
          const q = proj(p.ll); if (!q || q[0] < 0 || q[0] > W || q[1] < 0 || q[1] > H) return;
          ctx.fillStyle = 'rgba(214,240,248,0.85)'; ctx.beginPath(); ctx.moveTo(q[0], q[1] - 6); ctx.lineTo(q[0] + 5, q[1] + 3); ctx.lineTo(q[0] - 5, q[1] + 3); ctx.closePath(); ctx.fill();
          ctx.textAlign = 'center'; label(p.n, q[0], q[1] + 15, 'italic 11px ' + FONT, 'rgba(214,240,248,0.8)', p.n.length * 6);
        });
        o.flatMap((t) => t.places).sort((a, b) => a.r - b.r).forEach((p) => {
          if (k < (p.r <= 2 ? OSM_K : p.r === 3 ? 70 : 150)) return; const q = proj(p.ll); if (!q || q[0] < 0 || q[0] > W || q[1] < 0 || q[1] > H) return;
          ctx.textAlign = 'center'; label(p.n, q[0], q[1], (p.r <= 2 ? '600 13px ' : p.r === 3 ? '600 11.5px ' : '11px ') + FONT, 'rgba(240,246,250,0.92)', p.n.length * 7);
        });
      } },
      { id: 'mountains', draw(t) {
        if (!mountains) return;
        // The finest grid whose peaks stand at least ~22 px apart on screen.
        const pxPerDeg = R0 * view.k * Math.PI / 180, steps = [1, 0.5, 0.25, 0.125];
        let lvl = 0; for (let i = 0; i < 4; i++) if (steps[i] * pxPerDeg >= 22) lvl = i;
        if (lvl >= 2 && !t.length) lvl = 1;   // fine grids live in the tiles
        const s = clamp(steps[lvl] * pxPerDeg * 0.95, 7, 30), fade = clamp(((osmShown ? 60 : 260) - view.k) / (osmShown ? 20 : 120), 0, 1) * (view.k < 1.2 ? 0.75 : 0.95);   // where OSM's real peaks take over, the symbols step back
        if (fade <= 0) return;
        const pts = lvl < 2 ? mountains.ranges.flatMap((r) => r.g[lvl]) : t.flatMap((x) => x.m[lvl - 2]);
        const b = F.box, m = b ? (b[2] - b[0]) * 0.1 : 0;
        for (const ll of pts) { if (b && (ll[0] < b[0] - m || ll[0] > b[2] + m || ll[1] < b[1] - m || ll[1] > b[3] + m)) continue; stamp(ll, s * (0.8 + 0.4 * hash(ll[0], ll[1])), 1 + Math.floor(hash(ll[1], ll[0]) * 3), fade); }
        // Named summits: bigger, by height, with their names once close enough.
        mountains.peaks.forEach((p) => {
          if (view.k < (p.r <= 3 ? 1.6 : p.r <= 5 ? 3 : 6) || (osmShown && view.k > 60)) return;
          const at = stamp(p.ll, clamp(s * 1.5 * (0.7 + p.el / 6000), 12, 44), 0, Math.max(fade, 0.6)); ctx.globalAlpha = 1;
          if (at && view.k >= 4 && !osmShown) label(p.n, at[0], at[1] + 12, '11px ' + FONT, 'rgba(214,240,248,0.75)', p.n.length * 6);
        });
        ctx.globalAlpha = 1;
      } },
      { id: 'labels', draw(t) {
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        // Range names, spaced capitals, between continent and valley zoom.
        if (mountains && view.k >= 2.2 && view.k < 60) mountains.ranges.forEach((r) => {
          if (view.k < 2.2 + r.r * 0.9 || !front(r.c)) return; const p = proj(r.c); if (!p) return;
          const txt = r.n.toUpperCase().split('').join(' '); label(txt, p[0], p[1] - 16, 'italic 10px ' + FONT, 'rgba(160,220,232,0.55)', txt.length * 5.2);
        });
        // Towns and cities from the tiles, bigger places first.
        if (t.length) {
          const maxRank = view.k < 12 ? 3 : view.k < 25 ? 5 : view.k < 60 ? 7 : 10;
          t.flatMap((x) => x.places).filter((p) => p.r <= maxRank && front(p.ll)).sort((a, b) => a.r - b.r).forEach((p) => {
            const q = proj(p.ll); if (!q || q[0] < 0 || q[0] > W || q[1] < 0 || q[1] > H) return;
            if (label(p.n, q[0], q[1] - 6, (p.r <= 2 ? '600 12px ' : '11px ') + FONT, 'rgba(230,240,245,0.85)', p.n.length * 6.5)) { ctx.fillStyle = 'rgba(230,240,245,0.85)'; ctx.beginPath(); ctx.arc(q[0], q[1], 2, 0, TAU); ctx.fill(); }
          });
        }
      } },
      { id: 'limb', draw(t, r) {
        if (r >= Math.max(W, H)) return;
        const lim = ctx.createRadialGradient(W / 2, H / 2, r * 0.7, W / 2, H / 2, r); lim.addColorStop(0, 'rgba(5,10,20,0)'); lim.addColorStop(1, 'rgba(5,10,20,0.45)');
        ctx.fillStyle = lim; ctx.beginPath(); ctx.arc(W / 2, H / 2, r, 0, TAU); ctx.fill();
      } },
    ];
    const FONT = 'Helvetica, Arial, sans-serif';
    // [name, lng, lat, named first]: Pacific island nations and territories (label points).
    const PACIFIC = [
      ['Samoa', -172.1, -13.75, 1], ['Tonga', -175.2, -21.15, 1], ['Fiji', 178.1, -17.8, 1], ['Vanuatu', 167.7, -16.2, 1],
      ['American Samoa', -170.7, -14.3], ['Niue', -169.87, -19.05], ['Tokelau', -171.8, -9.2], ['Wallis and Futuna', -176.2, -13.3],
      ['Tuvalu', 179.2, -8.5], ['Kiribati', 173.0, 1.4], ['Nauru', 166.93, -0.53], ['Marshall Islands', 171.2, 7.1],
      ['Micronesia', 158.2, 6.9], ['Palau', 134.55, 7.5], ['Guam', 144.8, 13.45], ['Northern Mariana Islands', 145.7, 15.2],
      ['Solomon Islands', 160.2, -9.6], ['New Caledonia', 165.6, -21.3], ['Papua New Guinea', 145.0, -6.5],
      ['Cook Islands', -159.8, -21.2], ['French Polynesia', -149.4, -17.65], ['Pitcairn Islands', -130.1, -25.07],
      ['Rapa Nui', -109.35, -27.12], ['Hawaiʻi', -155.5, 19.6], ['Aotearoa New Zealand', 172.5, -41.5],
    ];

    // ---------- drawing ----------
    let raf = 0;
    function dirty() { if (!raf) raf = requestAnimationFrame(draw); }
    function draw() {
      // Resampling (extra points along each edge) makes coastlines expensive: the whole globe keeps a little so its
      // limb stays round; zoomed in, the data's own points are close enough.
      raf = 0; proj.precision(view.k < 1.5 ? 1 : 0); setProj(); frameConsts();
      const r = R0 * view.k, t = tilesNow();
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H); taken = new Set();
      LAYERS.forEach((L) => { ctx.save(); L.draw(t, r); ctx.restore(); });
      // Credits for what's on screen: OpenStreetMap asks for this (ODbL); Natural Earth is public domain.
      ctx.font = '10px ' + FONT; ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(200,225,235,0.6)';
      ctx.fillText(osmShown ? '© OpenStreetMap contributors · Natural Earth' : 'Natural Earth', W - 10, W < 700 ? 74 : 22);
      placeFacts();
      // More detail once zoomed in (the tiles take over from 1:50m at TILE_K).
      if (view.k > 2.5 && !world50 && !loading50) {
        loading50 = true;
        gfetch('world-50.json').then((x) => x.json()).then((w) => { world50 = unpack(w); dirty(); }).catch(() => { loading50 = false; });
      }
      const want = view.k > 2.5 && world50 ? world50 : world110; if (want !== world) { world = want; dirty(); }
    }

    // ---------- the "i" bubbles (data/facts.json) ----------
    // A fact about a place. fly.js says when they show (below 3,000 feet) and opens one when the airplane flies
    // over it; one you've opened is remembered as found on this device.
    let flyGate = null;   // fly.js: (fact) => whether its bubble shows now
    const facts = ((window.FLY_DATA || {}).facts || []);
    const FOUND = 'globe-trivia-found';
    let found = new Set(); try { found = new Set(JSON.parse(localStorage.getItem(FOUND) || '[]')); } catch (e) {}
    const factEls = facts.map((f) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'geo-globe-fact'; b.hidden = true; b.textContent = 'i';
      b.setAttribute('aria-label', 'A fact: ' + f.title);
      const s = { f, el: b, ll: [+f.lng, +f.lat] };
      b.addEventListener('click', (e) => { e.stopPropagation(); if (factCard._s === s) { closeFact(); return; } openFact(s); });
      layer.appendChild(b); return s;
    });
    const factCard = document.createElement('div'); factCard.className = 'geo-globe-card geo-globe-fact-card'; factCard.hidden = true; factCard.setAttribute('role', 'dialog');
    layer.appendChild(factCard);
    function placeFacts() {
      const show = !!flyGate, c = [view.lon, view.lat], shown = [];
      factEls.forEach((s) => {
        const xy = show && flyGate(s) && d3.geoDistance(s.ll, c) < Math.PI / 2 - 0.05 ? proj(s.ll) : null;
        if (!xy || xy[0] < 0 || xy[0] > W || xy[1] < 0 || xy[1] > H) { s.el.hidden = true; return; }
        if (shown.some((q) => Math.hypot(q[0] - xy[0], q[1] - xy[1]) < 24)) { s.el.hidden = true; return; }   // two too close: the second waits for a closer zoom
        shown.push(xy);
        s.el.hidden = false; s.el.style.left = xy[0] + 'px'; s.el.style.top = xy[1] + 'px';
        s.el.classList.toggle('is-found', found.has(s.f.id));
        if (factCard._s === s) posFact(s.el);
      });
      if (factCard._s && factCard._s.el.hidden) closeFact();
    }
    function openFact(s) {
      factCard.textContent = ''; factCard._s = s;
      found.add(s.f.id); try { localStorage.setItem(FOUND, JSON.stringify([...found])); } catch (e) {}
      const x = document.createElement('button'); x.type = 'button'; x.className = 'geo-globe-card-x'; x.setAttribute('aria-label', 'Close'); x.textContent = '×'; x.addEventListener('click', (e) => { e.stopPropagation(); closeFact(); s.el.focus(); });
      const h = document.createElement('div'); h.className = 'geo-globe-card-h'; h.textContent = s.f.title;
      const t = document.createElement('div'); t.className = 'geo-globe-card-what'; factText(t, s.f.fact);
      factCard.append(x, h, t);
      if (/^https:\/\/en\.wikipedia\.org\/wiki\//.test(s.f.source || '')) { const a = document.createElement('a'); a.href = s.f.source; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Wikipedia →'; factCard.appendChild(a); }
      const n = document.createElement('div'); n.className = 'geo-globe-fact-count'; n.textContent = facts.filter((f) => found.has(f.id)).length + ' of ' + facts.length + ' found';
      factCard.appendChild(n);
      factCard.hidden = false; posFact(s.el);
      factEls.forEach((q) => { q.el.classList.toggle('is-on', q === s); q.el.classList.toggle('is-found', found.has(q.f.id)); });
    }
    // A fact's own links. On the original site, [[pin-id|words]] turns the homepage globe to a pin and
    // [words](/page/) goes to a page there: here both open that page on ethandavidmagalei.com in a new tab.
    // [[i:fact-id|words]] (a link to another fact) stays plain words, since the airplane is the camera.
    // Built as elements, never as HTML.
    function factText(box, text) {
      const re = /\[\[(i:)?([a-z0-9-]+)\|([^\]]+)\]\]|\[([^\]]+)\]\((\/(?!\/)[^)\s]*)\)/gi; let at = 0, m;
      while ((m = re.exec(text))) {
        box.append(text.slice(at, m.index)); at = re.lastIndex;
        const [, isFact, key, words, label, url] = m;
        if (isFact) { box.append(words); continue; }
        const a = document.createElement('a'); a.className = 'geo-globe-fact-link'; a.target = '_blank'; a.rel = 'noopener';
        if (key) { a.href = SITE + '/#map=' + encodeURIComponent(key); a.textContent = words; }
        else { a.href = SITE + url; a.textContent = label; }
        box.append(a);
      }
      box.append(text.slice(at));
    }
    function posFact(el) {
      const x = parseFloat(el.style.left), y = parseFloat(el.style.top), half = factCard.offsetWidth / 2 + 8;
      factCard.style.left = clamp(x, half, Math.max(half, W - half)) + 'px'; factCard.style.top = y + 'px';
    }
    function closeFact() { factCard.hidden = true; factCard._s = null; factEls.forEach((q) => q.el.classList.remove('is-on')); }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && factCard._s) closeFact(); });

    // The page never zooms under a pinch or the wheel (fly.js reads the wheel itself, as the throttle).
    const stop = (e) => e.preventDefault();
    [cv, layer].forEach((el) => {
      el.addEventListener('wheel', stop, { passive: false });
      ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => el.addEventListener(t, stop));
    });

    window.__globe = {
      view, layers: LAYERS,
      // Put the camera somewhere now.
      look: (lon, lat, k) => { view.lon = lon; view.lat = clamp(lat, -85, 85); if (k) view.k = clamp(k, 0.6, KMAX); dirty(); },
      // For the flying game: the screen's size and scale, the facts, when their bubbles show, and opening one.
      metrics: () => ({ W, H, R0, k: view.k }),
      facts: () => factEls.map((q) => ({ id: q.f.id, title: q.f.title, ll: q.ll, found: found.has(q.f.id) })),
      factGate: (fn) => { flyGate = fn; dirty(); },
      openFact: (id) => { const q = factEls.find((x) => x.f.id === id); if (q && !q.el.hidden) { openFact(q); return true; } return false; },
      factOpen: () => (factCard._s ? factCard._s.f.id : null), closeFact: () => closeFact(),
      drawNow: () => { const t0 = performance.now(); draw(); return performance.now() - t0; },
    };
    addEventListener('resize', size);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { const r = zone.getBoundingClientRect(); if (Math.abs(r.width - W) > 1 || Math.abs(r.height - H) > 1) size(); }).observe(zone);
    size(); zone.classList.add('is-globe-ready');
  }
})();
