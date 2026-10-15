// Checks the flight numbers in js/fly-lib.js. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const L = require('../js/fly-lib.js');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || '') + ` ${a} not within ${tol} of ${b}`);

const KSLC = [-111.9778, 40.7884], KHCR = [-111.4288, 40.4818], KSFO = [-122.375, 37.6188];

test('the 172 book numbers', () => {
  assert.equal(L.C172.usableGal, 53);
  assert.equal(L.C172.cruise, 120);
  assert.equal(L.C172.vso, 48);
  assert.equal(L.C172.reserveMin, 30);
});

test('fuel burn: idle 1.5 gph, about 8.5 at 75% power, 11 at full', () => {
  near(L.burnGph(0), 1.5, 1e-9);
  near(L.burnGph(0.75), 8.6, 0.2);
  near(L.burnGph(1), 11, 1e-9);
  near(L.burnGph(2), 11, 1e-9, 'clamped');
});

test('a full tank goes about 600 nm with the reserve at cruise', () => {
  const gph = L.burnGph(0.65), tas = L.tasFromIas(L.targetIas(0.65, 0), 4500);
  const hours = L.endurance(L.C172.usableGal - gph * 0.5, gph);
  near(hours * tas, 600, 120);
});

test('airspeed settles near cruise at cruise power, level', () => {
  near(L.targetIas(0.65, 0), 95, 5);
  assert.ok(L.targetIas(1, 0) < L.C172.vne);
  assert.ok(L.targetIas(0.65, 1) < L.targetIas(0.65, 0), 'nose up is slower');
});

test('true airspeed grows 2% per thousand feet', () => {
  near(L.tasFromIas(100, 5000), 110, 1e-9);
  near(L.tasFromIas(100, -50), 100, 1e-9);
});

test('climb fades to nothing near the ceiling and sinks at idle', () => {
  assert.ok(L.climbMax(1, 0) > 600);
  assert.ok(L.climbMax(1, 14000) < 100);
  assert.ok(L.climbMax(0, 3000) < 0);
});

test('time scale: 6x on the ground, 60x at 1,000 ft, at most 900x', () => {
  assert.equal(L.timeScale(0), 6);
  assert.equal(L.timeScale(1000), 60);
  assert.equal(L.timeScale(4500), 270);
  assert.equal(L.timeScale(40000), 900);
});

test('the camera comes closer as you descend', () => {
  assert.ok(L.zoomFor(500) > L.zoomFor(4500));
  assert.ok(L.zoomFor(4500) > L.zoomFor(12000));
  assert.ok(L.zoomFor(0) <= 1600 && L.zoomFor(1e6) >= 18);
});

test('great circles: KSLC to KSFO is about 516 nm, a bit south of west', () => {
  near(L.distanceNm(KSLC, KSFO), 516, 6);
  const c = L.course(KSLC, KSFO);
  assert.ok(c > 250 && c < 265, 'course ' + c);
  near(L.distanceNm(KSLC, KHCR), 30, 3);
  near(L.course([0, 0], [1, 0]), 90, 1e-6);
  near(L.course([0, 0], [0, 1]), 0, 1e-6);
});

test('along() lands where course and distance say', () => {
  const c = L.course(KSLC, KSFO), d = L.distanceNm(KSLC, KSFO), p = L.along(KSLC, c, d);
  near(p[0], KSFO[0], 1e-6); near(p[1], KSFO[1], 1e-6);
  const q = L.along([179.5, 0], 90, 60);
  assert.ok(q[0] < -179, 'wraps across the date line: ' + q[0]);
});

test('wind triangle: a direct headwind and a crosswind', () => {
  const head = L.windTriangle(360, 100, 360, 20);
  near(head.wca, 0, 1e-9); near(head.heading, 0, 1e-9); near(head.gs, 80, 1e-9);
  const cross = L.windTriangle(360, 100, 90, 20);   // wind from the east: crab right into it
  near(cross.wca, 11.5, 0.1); assert.ok(cross.heading > 11 && cross.heading < 12);
  near(cross.gs, Math.sqrt(100 * 100 - 20 * 20), 1e-6);
  assert.equal(L.windTriangle(0, 30, 90, 40).heading, null, 'wind stronger than the airplane');
});

test('drift is the wind triangle the other way round', () => {
  const tri = L.windTriangle(45, 110, 300, 25), dr = L.drift(tri.heading, 110, 300, 25);
  near(dr.track, 45, 1e-6); near(dr.gs, tri.gs, 1e-6);
});

test('VFR cruising altitudes: odd thousands + 500 eastbound, even westbound, above 3,000 ft', () => {
  assert.equal(L.vfrAltitude(90, 2500).applies, false);
  const e = L.vfrAltitude(90, 5400); assert.equal(e.east, true); assert.equal(e.target, 5500); assert.equal(e.ok, true);
  const w = L.vfrAltitude(270, 5400); assert.equal(w.east, false); assert.equal(w.target, 4500); assert.equal(w.ok, false);
  assert.equal(L.vfrAltitude(10, 3200).target, 3500);
  assert.equal(L.vfrAltitude(200, 3200).target, 4500);
  assert.equal(L.vfrAltitude(90, 18000).applies, false);
});

test('leg fuel adds the 30-minute reserve', () => {
  const f = L.legFuel(240, 120, 8);
  near(f.hours, 2, 1e-9); near(f.gal, 16, 1e-9); near(f.withReserve, 20, 1e-9);
  assert.equal(L.legFuel(10, 0, 8).hours, Infinity);
});

test('the wind is steady, westerly in the middle latitudes, easterly in the tropics, and grows with height', () => {
  assert.deepEqual(L.windAt(KSLC, 4500), L.windAt(KSLC, 4500));
  for (let lon = -180; lon < 180; lon += 15) {
    const mid = L.windAt([lon, 45], 6000).from, trop = L.windAt([lon, 10], 6000).from;
    assert.ok(mid > 180 && mid < 340, 'mid-latitude wind from ' + mid);
    assert.ok(trop > 0 && trop < 160, 'tropical wind from ' + trop);
  }
  assert.ok(L.windAt(KSLC, 12000).kt > L.windAt(KSLC, 0).kt);
});

test('the data files: start airports first, KSLC the default, facts complete', () => {
  const a = JSON.parse(readFileSync(new URL('../data/airports.json', import.meta.url))).airports;
  const f = JSON.parse(readFileSync(new URL('../data/facts.json', import.meta.url))).facts;
  assert.equal(a.find((x) => x.start).icao, 'KSLC');
  assert.ok(a.filter((x) => x.start).length >= 2);
  assert.ok(a.some((x) => x.ne) && a.length > 500);
  for (const x of a) { assert.ok(/^[A-Z0-9]{3,4}$/.test(x.icao), x.icao); assert.ok(Math.abs(x.lat) <= 90 && Math.abs(x.lng) <= 180, x.icao); }
  assert.equal(new Set(a.map((x) => x.icao)).size, a.length, 'no airport twice');
  assert.ok(f.length > 0);
  for (const x of f) { assert.ok(x.id && x.title && x.fact, x.id); assert.ok(Math.abs(x.lat) <= 90 && Math.abs(x.lng) <= 180, x.id); }
  assert.equal(new Set(f.map((x) => x.id)).size, f.length, 'no fact twice');
});
