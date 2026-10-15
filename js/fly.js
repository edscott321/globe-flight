// The flying game: a Cessna 172 over the globe (js/globe.js), driven through window.__globe. The numbers are
// js/fly-lib.js (tested in tests/fly-lib.test.mjs); the airports and the "i" bubbles come from data/*.json, loaded
// by js/boot.js into window.FLY_DATA before this file runs.
//
// The world runs a few hundred times faster than real time at cruise and slower down low (FLYLIB.timeScale), and
// the camera comes down with you (FLYLIB.zoomFor). The "i" bubbles show below 3,000 feet; flying over one opens
// it and counts it as found. Fuel burns on the game's clock at a 172's book rate, so a tank goes about as far as
// a real one; land on an airport to fill it. The wind is steady (FLYLIB.windAt), so a heading worked out on the
// leg card holds. Altitudes are above the ground: the globe has no terrain heights, so there are no mountains to hit.
(function () {
  'use strict';
  const L = window.FLYLIB; if (!L) return;
  const $ = (id) => document.getElementById(id);
  const RAD = Math.PI / 180, clamp = L.clamp, norm = L.norm, C = L.C172;
  const CALM = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SEE_I = 3000;      // the bubbles show below this many feet
  const CLIMB = 12;        // climbs and descents run this many times faster than real (or a climb would take minutes)
  const GRAB_PX = 28;      // fly within this many pixels of a bubble to open it

  let airports = []; try { airports = ((window.FLY_DATA || {}).airports || []).map((a) => ({ icao: a.icao, name: a.name, ll: [+a.lng, +a.lat], start: !!a.start, ne: !!a.ne })); } catch (e) {}   // ne = from Natural Earth's list
  const get = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const put = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const prefs = Object.assign({ upClimbs: false, sound: true, arrow: true }, get('fly-prefs', {}));

  const P = { ll: [-111.43, 40.48], hdg: 90, alt: 4500, ias: 105, vs: 0, thr: 0.65, fuel: C.usableGal, bank: 0, pitch: 0, ground: false, at: null, trail: [], kCam: L.zoomFor(4500) };
  let started = false, paused = false, G = null, lastT = 0, trailT = 0, saveT = 0, msgT = 0, opened = new Set(), target = 'fact';

  // ---------- starting ----------
  const startSel = $('fly-start-at');
  airports.filter((a) => a.start).forEach((a) => { const o = document.createElement('option'); o.value = a.icao; o.textContent = a.name + ' (' + a.icao + ')'; startSel.appendChild(o); });
  const saved = get('fly-state', null);
  if (saved && saved.ll) $('fly-resume').hidden = false;
  function begin(mode) {
    const a = airports.find((x) => x.icao === startSel.value) || airports[0];
    if (mode === 'resume' && saved) Object.assign(P, saved, { trail: [], bank: 0, pitch: 0 });
    else {
      P.ll = a.ll.slice(); P.fuel = C.usableGal; P.trail = []; P.bank = 0; P.pitch = 0; P.vs = 0;
      if (mode === 'runway') Object.assign(P, { alt: 0, ias: 0, thr: 0, ground: true, at: a, hdg: 90 });
      else Object.assign(P, { alt: 4500, ias: 105, thr: 0.65, ground: false, at: null, hdg: 90 });
    }
    P.kCam = L.zoomFor(P.alt);
    $('fly-intro').hidden = true; started = true; paused = false; audio(); lastT = 0;
    say(mode === 'resume' ? 'Back where you were: ' + ft(P.alt) + ' feet, ' + P.fuel.toFixed(1) + ' gallons left.' : P.ground ? 'On the runway at ' + (P.at ? P.at.name : 'the field') + '. Throttle up (E), then pull back (' + (prefs.upClimbs ? 'W or ↑' : 'S or ↓') + ') at ' + C.vr + ' knots.' : 'Level at 4,500 feet. Descend below 3,000 to see the i bubbles.', 6);
    $('fly-canvas').focus();
  }
  $('fly-go-air').addEventListener('click', () => begin('air'));
  $('fly-go-runway').addEventListener('click', () => begin('runway'));
  $('fly-resume').addEventListener('click', () => begin('resume'));

  // ---------- settings ----------
  const setBox = (id, key) => { const b = $(id); b.checked = !!prefs[key]; b.addEventListener('change', () => { prefs[key] = b.checked; put('fly-prefs', prefs); }); };
  setBox('fly-up-climbs', 'upClimbs'); setBox('fly-sound', 'sound'); setBox('fly-arrow', 'arrow');

  // ---------- input ----------
  const keys = new Set();
  const typing = (e) => e.target && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName) && e.target.type !== 'checkbox';
  addEventListener('keydown', (e) => {
    if (typing(e) && !/^Arrow/.test(e.key)) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(k)) e.preventDefault();
    if (k === 'p') { togglePause(); return; }
    if (k === 'm') { follow = !follow; say(follow ? 'The plane follows your cursor. M again to stop.' : 'Steering with the keys.', 3); return; }
    if (k === 'Escape') { if (G && G.factOpen()) G.closeFact(); else togglePause(); return; }
    keys.add(k);
  });
  addEventListener('keyup', (e) => keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
  addEventListener('blur', () => { keys.clear(); if (started && !paused) togglePause(); });
  // The cursor: hold the mouse (or a finger) on the map and the plane turns and climbs toward it; M follows without holding.
  let follow = false, held = false, cur = null;
  // On the map = anywhere in the globe's box (its canvas or the bubbles' layer over it), but not a bubble or a card.
  const onMap = (e) => !!(e.target && e.target.closest && e.target.closest('#geo-map-zone') && !e.target.closest('button, a, input, select, .geo-globe-card'));
  document.addEventListener('pointerdown', (e) => { if (started && onMap(e)) { held = true; cur = [e.clientX, e.clientY]; } }, true);
  document.addEventListener('pointermove', (e) => { cur = [e.clientX, e.clientY]; }, true);
  ['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, () => { held = false; }, true));
  // The wheel is the throttle (the globe's own wheel zoom is off in fly mode).
  document.addEventListener('wheel', (e) => { if (!started || (e.target.closest && e.target.closest('.fly-panel'))) return; e.preventDefault(); P.thr = clamp(P.thr - e.deltaY * 0.0009, 0, 1); }, { capture: true, passive: false });
  $('fly-thr').addEventListener('input', (e) => { P.thr = +e.target.value / 100; });

  function togglePause() {
    if (!started) return; paused = !paused; $('fly-paused').hidden = !paused;
    if (!paused) { lastT = 0; $('fly-canvas').focus(); }
    hum();
  }
  $('fly-unpause').addEventListener('click', togglePause);

  // ---------- sound (the stall horn is a steady tone, as in the airplane; a chime for a bubble) ----------
  let ac = null, horn = null;
  function audio() { if (ac || !window.AudioContext) return; try { ac = new AudioContext(); } catch (e) {} }
  function chime() {
    if (!ac || !prefs.sound) return; const t = ac.currentTime;
    [660, 880, 1320].forEach((f, i) => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = f; o.type = 'sine'; g.gain.setValueAtTime(0.0001, t + i * 0.09); g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.09 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.5); o.connect(g).connect(ac.destination); o.start(t + i * 0.09); o.stop(t + i * 0.09 + 0.55); });
  }
  function hum(on) {
    on = !!on && prefs.sound && !paused && !!ac;
    if (on && !horn) { const o = ac.createOscillator(), g = ac.createGain(); o.type = 'triangle'; o.frequency.value = 1500; g.gain.value = 0.035; o.connect(g).connect(ac.destination); o.start(); horn = { o, g }; }
    if (!on && horn) { horn.o.stop(); horn = null; }
  }

  // ---------- messages ----------
  function say(text, secs) { $('fly-msg').textContent = text; msgT = performance.now() + (secs || 4) * 1000; }

  // ---------- the airplane ----------
  function update(dt) {
    const up = keys.has('ArrowUp') || keys.has('w'), down = keys.has('ArrowDown') || keys.has('s');
    let bankIn = (keys.has('ArrowRight') || keys.has('d') ? 1 : 0) - (keys.has('ArrowLeft') || keys.has('a') ? 1 : 0);
    let pitchIn = (prefs.upClimbs ? (up ? 1 : 0) - (down ? 1 : 0) : (down ? 1 : 0) - (up ? 1 : 0));   // a yoke: pull back to climb
    if ((held || follow) && cur) { const W = innerWidth, H = innerHeight; bankIn = clamp((cur[0] - W / 2) / (W * 0.22), -1, 1); pitchIn = clamp((H / 2 - cur[1]) / (H * 0.22), -1, 1); }
    if (keys.has('e') || keys.has('=') || keys.has('+')) P.thr = clamp(P.thr + dt * 0.45, 0, 1);
    if (keys.has('q') || keys.has('-')) P.thr = clamp(P.thr - dt * 0.45, 0, 1);
    P.bank += (bankIn - P.bank) * Math.min(1, dt * 4); P.pitch += (pitchIn - P.pitch) * Math.min(1, dt * 3);
    const thr = P.fuel > 0 ? P.thr : 0;

    // Airspeed settles toward what the power and the pitch give.
    if (P.ground) {
      P.ias += ((thr > 0.05 ? 25 + 80 * thr : 0) - P.ias) * Math.min(1, dt * (thr > 0.05 ? 0.35 : 1.6));   // at idle on the ground: the brakes
      P.ias = Math.max(0, P.ias);
      if (P.ias >= C.vr && P.pitch > 0.25) { P.ground = false; P.vs = 400; P.at = null; say('Rotate. You\'re flying.', 3); }
      else P.alt = 0;
    } else {
      P.ias += (L.targetIas(thr, P.pitch) - P.ias) * Math.min(1, dt * 0.55);
      const stall = P.ias < C.vso;
      let vs = P.pitch > 0 ? P.pitch * Math.max(0, L.climbMax(thr, P.alt)) : P.pitch * 1500;
      if (thr < 0.35) vs -= (0.35 - thr) * 1400;   // too little power for level flight: it sinks
      if (stall) { vs = Math.min(vs, -900); P.pitch = Math.min(P.pitch, -0.5); }
      if (P.alt >= C.ceiling) vs = Math.min(vs, 0);
      if (P.alt < 120 && vs < 0) vs *= 0.45 + P.alt / 220;   // ground effect: the last hundred feet cushion the sink
      P.vs += (vs - P.vs) * Math.min(1, dt * (P.alt < 150 ? 6 : 2));
      // Climbs and descents are sped up too, less so near the ground, where the last few hundred feet take real seconds.
      P.alt = Math.min(C.ceiling + 200, P.alt + P.vs / 60 * dt * CLIMB * clamp(0.3 + P.alt / 2500, 0.3, 1));
      hum(P.ias < C.vs1 + 5);
      if (stall && msgT < performance.now()) say('Stall. Nose down and add power.', 2);
      if (P.alt <= 0) touchdown();
    }
    if (P.fuel <= 0 && !P.ground && msgT < performance.now()) say('Out of fuel. Glide to a field, nose a little down, about 68 knots.', 3);

    // Heading (real-time turns), then where the heading and the wind take you, on the game's clock.
    P.hdg = norm(P.hdg + P.bank * (P.ground ? (P.ias > 3 ? 12 : 0) : 26) * dt);
    const tas = L.tasFromIas(P.ias, P.alt), wind = L.windAt(P.ll, P.alt);
    const dr = P.ground ? { track: P.hdg, gs: P.ias } : L.drift(P.hdg, tas, wind.from, wind.kt);
    const T = L.timeScale(P.alt), hours = dt * T / 3600;
    P.ll = L.along(P.ll, dr.track, dr.gs * hours);
    P.fuel = Math.max(0, P.fuel - L.burnGph(thr) * hours);
    P.tas = tas; P.wind = wind; P.track = dr.track; P.gs = dr.gs; P.T = T;
    if (P.at && !P.ground && L.distanceNm(P.ll, P.at.ll) > 4) P.at = null;   // on the ground you're at the field you landed on (within 4 nm counts)
    trailT += dt; if (trailT > 0.2 && !P.ground) { trailT = 0; P.trail.push(P.ll.slice()); if (P.trail.length > 160) P.trail.shift(); }
    saveT += dt; if (saveT > 4) { saveT = 0; put('fly-state', { ll: P.ll, hdg: P.hdg, alt: P.alt, ias: P.ias, thr: P.thr, fuel: P.fuel, ground: P.ground }); }
  }

  function touchdown() {
    P.lastTouch = { ias: Math.round(P.ias), vs: Math.round(P.vs) };
    const near = nearest(airports, 4), gentle = P.ias <= 85 && P.vs >= -1000;
    P.alt = 0; P.vs = 0;
    if (near && gentle) { P.ground = true; P.at = near; say('Landed at ' + near.name + ' (' + near.icao + '). Stop, then fill the tanks.', 6); return; }
    if (!near && P.ias <= 70 && P.vs >= -700) { P.ground = true; P.at = null; say('An off-field landing, down safe. No fuel here: the nearest airport is ' + nearInfo() + '.', 7); return; }
    const back = nearest(airports, Infinity) || airports[0];
    say('That landing bent the airplane. Back on the ground at ' + back.name + ', tanks full.', 7);
    Object.assign(P, { ll: back.ll.slice(), alt: 0, ias: 0, thr: 0, ground: true, at: back, fuel: C.usableGal, trail: [] });
  }
  function nearest(list, withinNm) { let best = null, bd = withinNm; list.forEach((a) => { const d = L.distanceNm(P.ll, a.ll); if (d < bd) { bd = d; best = a; } }); return best; }
  function nearInfo() { const a = nearest(airports, Infinity); return a ? a.name + ', ' + Math.round(L.distanceNm(P.ll, a.ll)) + ' nm, ' + pad3(L.course(P.ll, a.ll)) + '°' : 'far away'; }
  $('fly-refuel').addEventListener('click', () => { if (P.ground && P.at && P.ias < 3) { P.fuel = C.usableGal; say('Tanks full: ' + C.usableGal + ' gallons.', 3); } });

  // ---------- the bubbles ----------
  function facts() { return G ? G.facts() : []; }
  function grabFacts() {
    if (!G || P.alt > SEE_I || G.factOpen()) return;
    for (const f of facts()) {
      if (opened.has(f.id)) continue;
      const q = toScreen(f.ll); if (!q) continue;
      if (Math.hypot(q[0] - innerWidth / 2, q[1] - innerHeight / 2) < GRAB_PX && G.openFact(f.id)) {
        opened.add(f.id); chime(); const n = facts().filter((x) => x.found).length;
        say('Found ' + n + ' of ' + facts().length + '.', 3); return;
      }
    }
  }

  // ---------- where things are on screen (the same orthographic view as the globe, centred on the plane) ----------
  function toScreen(ll) {
    const m = G.metrics(), s = m.R0 * m.k, l0 = P.ll[0] * RAD, p0 = P.ll[1] * RAD, l = ll[0] * RAD, p = ll[1] * RAD;
    const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(l - l0); if (cosc < 0) return null;
    return [m.W / 2 + s * Math.cos(p) * Math.sin(l - l0), m.H / 2 - s * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(l - l0))];
  }

  // ---------- the leg (the E6B card) ----------
  const tSel = $('fly-target');
  airports.filter((a) => !a.ne).forEach((a) => { const o = document.createElement('option'); o.value = 'apt:' + a.icao; o.textContent = a.name + ' (' + a.icao + ')'; tSel.appendChild(o); });
  tSel.addEventListener('change', () => { target = tSel.value; });
  function legTarget() {
    if (target === 'fact') { let best = null, bd = Infinity; facts().forEach((f) => { if (f.found) return; const d = L.distanceNm(P.ll, f.ll); if (d < bd) { bd = d; best = f; } }); return best ? { name: best.title, ll: best.ll, fact: true } : null; }
    if (target === 'apt') { const a = nearest(airports, Infinity); return a ? { name: a.name + ' (' + a.icao + ')', ll: a.ll } : null; }
    const a = airports.find((x) => 'apt:' + x.icao === target); return a ? { name: a.name + ' (' + a.icao + ')', ll: a.ll } : null;
  }

  // ---------- drawing ----------
  const cv = $('fly-canvas'), ctx = cv.getContext('2d');
  function sizeCanvas() { const d = Math.min(devicePixelRatio || 1, 2); cv.width = innerWidth * d; cv.height = innerHeight * d; cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px'; ctx.setTransform(d, 0, 0, d, 0, 0); }
  addEventListener('resize', sizeCanvas); sizeCanvas();
  function drawPlane(x, y, hdg, col, sc) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(hdg * RAD); ctx.scale(sc, sc); ctx.fillStyle = col;
    ctx.beginPath(); ctx.ellipse(0, 2, 3.2, 15, 0, 0, Math.PI * 2); ctx.fill();         // fuselage
    ctx.fillRect(-19, -5, 38, 5.5);                                                     // the high wing
    ctx.fillRect(-7.5, 13, 15, 3.2);                                                    // the tail plane
    ctx.beginPath(); ctx.moveTo(-4, -13); ctx.lineTo(4, -13); ctx.lineTo(0, -16.5); ctx.closePath(); ctx.fill();   // the cowling
    ctx.restore();
  }
  function draw() {
    const W = innerWidth, H = innerHeight; ctx.clearRect(0, 0, W, H); if (!G) return;
    // The track behind you, fading.
    if (P.trail.length > 1) {
      ctx.lineWidth = 2; ctx.lineCap = 'round';
      for (let i = 1; i < P.trail.length; i++) { const a = toScreen(P.trail[i - 1]), b = toScreen(P.trail[i]); if (!a || !b) continue; ctx.strokeStyle = 'rgba(101,244,244,' + (0.06 + 0.4 * i / P.trail.length) + ')'; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
    }
    // Airports on screen.
    ctx.font = '11px Helvetica, Arial, sans-serif'; ctx.textAlign = 'left';
    const kNow = G.metrics().k;
    airports.forEach((a) => { if (a.ne && kNow < 35) return; const q = toScreen(a.ll); if (!q || q[0] < -20 || q[0] > W + 20 || q[1] < -20 || q[1] > H + 20) return; ctx.strokeStyle = 'rgba(255,214,120,0.95)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(q[0], q[1], 6, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(q[0] - 9, q[1] + 3); ctx.lineTo(q[0] + 9, q[1] - 3); ctx.stroke(); ctx.fillStyle = 'rgba(255,224,150,0.95)'; if (!a.ne || kNow >= 70) ctx.fillText(a.icao, q[0] + 10, q[1] - 6); });
    // The leg's target: a marker on screen, or an arrow at the edge pointing to it.
    const t = legTarget();
    if (t && prefs.arrow) {
      const q = toScreen(t.ll), inView = q && q[0] > 30 && q[0] < W - 30 && q[1] > 30 && q[1] < H - 30;
      if (inView) { ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(q[0], q[1], 14, 0, Math.PI * 2); ctx.stroke(); }
      else {
        const brg = L.course(P.ll, t.ll) * RAD, r = Math.min(W, H) * 0.42, x = W / 2 + Math.sin(brg) * r, y = H / 2 - Math.cos(brg) * r;
        ctx.save(); ctx.translate(x, y); ctx.rotate(brg); ctx.fillStyle = t.fact ? 'rgba(101,244,244,0.9)' : 'rgba(255,214,120,0.9)';
        ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(8, 6); ctx.lineTo(0, 2); ctx.lineTo(-8, 6); ctx.closePath(); ctx.fill(); ctx.restore();
      }
    }
    // The airplane and its shadow on the ground (further off the higher you are).
    const off = P.ground ? 1.5 : clamp(P.alt / 380, 2, 30), sc = P.ground ? 0.9 : 1;
    drawPlane(W / 2 + off, H / 2 + off, P.hdg, 'rgba(0,0,0,0.32)', sc * 0.95);
    drawPlane(W / 2, H / 2, P.hdg, '#f4f7fa', sc);
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(P.hdg * RAD); ctx.fillStyle = '#d33'; ctx.fillRect(-19, -5, 3, 5.5); ctx.fillStyle = '#2b2'; ctx.fillRect(16, -5, 3, 5.5); ctx.restore();   // nav lights: red left, green right
  }

  // ---------- the instruments ----------
  const pad3 = (d) => String(Math.round(norm(d)) % 360).padStart(3, '0');
  const hm = (h) => { if (!isFinite(h)) return 'n/a'; const m = Math.round(h * 60); return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min'; };
  const ft = (x) => Math.round(x).toLocaleString('en-US');
  function hud() {
    const thr = P.fuel > 0 ? P.thr : 0, gph = L.burnGph(thr), w = P.wind || L.windAt(P.ll, P.alt);
    $('fly-ias').textContent = Math.round(P.ias); $('fly-alt').textContent = ft(P.alt); $('fly-vs').textContent = (P.vs >= 0 ? '+' : '') + Math.round(P.vs / 10) * 10;
    $('fly-hdg').textContent = pad3(P.hdg); $('fly-trk').textContent = pad3(P.track || P.hdg); $('fly-gs').textContent = Math.round(P.gs || 0);
    $('fly-wind').textContent = pad3(w.from) + '° at ' + w.kt + ' kt'; $('fly-pwr').textContent = Math.round(thr * 100) + '%';
    if (document.activeElement !== $('fly-thr')) $('fly-thr').value = Math.round(P.thr * 100);
    $('fly-fuel').textContent = P.fuel.toFixed(1) + ' gal'; $('fly-fuel-bar').style.width = (100 * P.fuel / C.usableGal) + '%';
    $('fly-fuel-bar').classList.toggle('is-low', L.endurance(P.fuel, gph) < C.reserveMin / 60);
    $('fly-endur').textContent = hm(L.endurance(P.fuel, gph)) + ' at ' + gph.toFixed(1) + ' gph';
    $('fly-speedup').textContent = Math.round(P.T || L.timeScale(P.alt)) + '×';
    $('fly-see').hidden = P.alt <= SEE_I || P.ground;
    const n = facts().filter((f) => f.found).length; $('fly-found').textContent = n + ' of ' + facts().length;
    $('fly-refuel').hidden = !(P.ground && P.at && P.ias < 3 && P.fuel < C.usableGal - 0.05);
    // The leg.
    const t = legTarget();
    if (!t) { $('fly-leg').hidden = true; return; } $('fly-leg').hidden = false;
    const tc = L.course(P.ll, t.ll), nm = L.distanceNm(P.ll, t.ll), tas = P.tas || L.tasFromIas(P.ias, P.alt);
    const tri = L.windTriangle(tc, Math.max(tas, 60), w.from, w.kt), fuel = L.legFuel(nm, tri.gs, gph), vfr = L.vfrAltitude(tc, P.alt);
    $('fly-leg-to').textContent = t.name;
    $('fly-leg-tc').textContent = pad3(tc) + '°'; $('fly-leg-dist').textContent = Math.round(nm).toLocaleString('en-US') + ' nm';
    $('fly-leg-wca').textContent = tri.wca == null ? 'n/a' : (tri.wca >= 0 ? 'R ' : 'L ') + Math.abs(tri.wca).toFixed(0) + '°';
    $('fly-leg-hdg').textContent = tri.heading == null ? 'n/a' : pad3(tri.heading) + '°'; $('fly-leg-gs').textContent = Math.round(tri.gs) + ' kt';
    $('fly-leg-ete').textContent = hm(fuel.hours) + (isFinite(fuel.hours) ? ' (about ' + Math.max(1, Math.round(fuel.hours * 3600 / L.timeScale(Math.max(P.alt, 1500)))) + ' s here)' : '');
    const enough = P.fuel >= fuel.withReserve;
    $('fly-leg-fuel').textContent = isFinite(fuel.gal) ? fuel.withReserve.toFixed(1) + ' gal with the 30-minute reserve' + (enough ? '' : ': not enough') : 'n/a';
    $('fly-leg-fuel').classList.toggle('is-short', !enough);
    $('fly-leg-vfr').textContent = vfr.applies ? (vfr.east ? 'Eastbound: odd thousands + 500 → ' : 'Westbound: even thousands + 500 → ') + ft(vfr.target) + ' ft' + (vfr.ok ? ' ✓' : '') : 'Below 3,000 ft: any altitude';
  }

  // ---------- the loop ----------
  function frame(now) {
    requestAnimationFrame(frame);
    if (!G) { G = window.__globe && window.__globe.metrics ? window.__globe : null; if (G) G.factGate(() => P.alt <= SEE_I); else return; }
    // Real elapsed time (up to a quarter second), in small steps, so the airplane flies the same at 60 frames a
    // second or at 5 (a slow phone, or a headless browser).
    let dt = lastT ? Math.min(0.25, (now - lastT) / 1000) : 0; lastT = now;
    if (started && !paused) { while (dt > 1e-6) { const h = Math.min(0.02, dt); update(h); dt -= h; } grabFacts(); }
    P.kCam += (L.zoomFor(P.alt) - P.kCam) * Math.min(1, (CALM ? 1 : dt * 2.5));
    G.look(P.ll[0], P.ll[1], P.kCam);
    draw();
    if (now > msgT && $('fly-msg').textContent) $('fly-msg').textContent = '';
    hud();
  }
  requestAnimationFrame(frame);
  window.__fly = { P, input: () => ({ held, follow, cur }) };   // for scripted tests in a browser
})();
