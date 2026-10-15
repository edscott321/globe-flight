// The flying game's numbers (the page is js/fly.js). Plain math, no page, so tests/fly-lib.test.mjs can
// check it. A Cessna 172 flown by visual flight rules: its performance, the wind
// triangle a pilot works on an E6B, great-circle courses, the VFR cruising altitudes, fuel with the day reserve.
// Figures are the 172S's book numbers, rounded (cruise ~120 knots, 53 gallons usable, stall ~48 knots).
(function (root) {
  'use strict';
  const RAD = Math.PI / 180, DEG = 180 / Math.PI, NM_KM = 1.852, EARTH_NM = 6371 / NM_KM;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const norm = (d) => ((d % 360) + 360) % 360;

  const C172 = {
    usableGal: 53,      // gallons of usable fuel (two tanks)
    vso: 48,            // stall, flaps down (knots, indicated)
    vs1: 53,            // stall, clean
    vr: 55,             // rotate on the takeoff roll
    vy: 74,             // best rate of climb
    cruise: 120,        // knots true at about 75% power
    vne: 163,           // never exceed
    ceiling: 14000,     // service ceiling (feet)
    climbSL: 730,       // best rate of climb at sea level (feet a minute)
    reserveMin: 30,     // VFR by day: fuel for 30 more minutes at cruise (14 CFR 91.151)
  };

  // Fuel burn (gallons an hour) for a throttle from 0 (idle) to 1 (full): about 8.5 at cruise power.
  const burnGph = (throttle) => 1.5 + 9.5 * clamp(throttle, 0, 1);
  // Airspeed the airplane settles at for a throttle and pitch (pitch -1 nose down … 1 nose up).
  const targetIas = (throttle, pitch) => clamp(42 + 82 * clamp(throttle, 0, 1) - 22 * clamp(pitch, -1, 1), 0, C172.vne);
  // True airspeed grows about 2% for every thousand feet up.
  const tasFromIas = (ias, alt) => ias * (1 + 0.02 * Math.max(0, alt) / 1000);
  // The best climb left at this altitude and power (feet a minute; at idle it sinks).
  const climbMax = (throttle, alt) => (C172.climbSL + 250) * clamp(throttle, 0, 1) * (1 - clamp(alt / (C172.ceiling + 500), 0, 1)) - 250;

  // How much faster than real time the game runs: a few hundred times at cruise (the U.S. to Russia in about a
  // minute, Alaska to Chukotka), about 60 times at 1,000 feet, slower still near the ground.
  const timeScale = (alt) => clamp(60 * Math.max(alt, 0) / 1000, 6, 900);
  // How close the camera is (the globe's zoom, 1 = the whole Earth): close to the ground, far up high.
  const zoomFor = (alt) => clamp(250 * Math.pow(Math.max(alt, 60) / 1000, -0.81), 18, 1600);

  // Great circles: the true course from a to b (degrees), the distance (nautical miles), the point d nm along a course.
  function course(a, b) {
    const p1 = a[1] * RAD, p2 = b[1] * RAD, dl = (b[0] - a[0]) * RAD;
    return norm(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * DEG);
  }
  function distanceNm(a, b) {
    const p1 = a[1] * RAD, p2 = b[1] * RAD, dp = p2 - p1, dl = (b[0] - a[0]) * RAD;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function along(a, crs, nm) {
    const d = nm / EARTH_NM, t = crs * RAD, p1 = a[1] * RAD, l1 = a[0] * RAD;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
    const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return [((l2 * DEG + 540) % 360) - 180, p2 * DEG];
  }

  // The wind triangle, as on an E6B. Given the course you want over the ground, your true airspeed and the wind
  // (the direction it blows FROM, and its speed), the wind correction angle, the heading to fly and the groundspeed.
  function windTriangle(tc, tas, windFrom, windKt) {
    const a = (windFrom - tc) * RAD, s = windKt * Math.sin(a) / Math.max(tas, 1);
    if (Math.abs(s) >= 1) return { wca: null, heading: null, gs: 0 };   // the wind is stronger than the airplane
    const wca = Math.asin(s) * DEG;
    return { wca, heading: norm(tc + wca), gs: tas * Math.cos(wca * RAD) - windKt * Math.cos(a) };
  }
  // The other way round: where a heading and airspeed actually take you in this wind (track and groundspeed).
  function drift(heading, tas, windFrom, windKt) {
    const h = heading * RAD, w = (windFrom + 180) * RAD;   // the wind blows toward windFrom + 180
    const e = tas * Math.sin(h) + windKt * Math.sin(w), n = tas * Math.cos(h) + windKt * Math.cos(w);
    return { track: norm(Math.atan2(e, n) * DEG), gs: Math.hypot(e, n) };
  }

  // VFR cruising altitudes (14 CFR 91.159), more than 3,000 feet up: a course from 0 to 179 flies odd thousands
  // plus 500 (3,500, 5,500 …), from 180 to 359 even thousands plus 500 (4,500, 6,500 …). The rule goes by the
  // magnetic course; the game uses the true course (it has no magnetic variation map), which the page says.
  function vfrAltitude(crs, alt) {
    if (alt <= 3000 || alt >= 18000) return { applies: false };
    const east = norm(crs) < 180, base = east ? 1000 : 2000;   // odd or even thousands
    const n = Math.round((alt - 500 - base) / 2000), target = Math.max(east ? 3500 : 4500, base + 500 + 2000 * n);
    return { applies: true, east, target, ok: Math.abs(alt - target) <= 150 };
  }

  // Fuel for a leg: the time en route at this groundspeed, the gallons at this burn, and the 30-minute VFR reserve.
  function legFuel(nm, gs, gph) {
    const hours = gs > 0 ? nm / gs : Infinity;
    return { hours, gal: hours * gph, withReserve: hours * gph + gph * C172.reserveMin / 60 };
  }
  // Hours of flying left on this much fuel at this burn.
  const endurance = (gal, gph) => (gph > 0 ? gal / gph : Infinity);

  // Winds aloft, made up but steady: westerlies in the middle latitudes that strengthen with height, easterly trade
  // winds in the tropics. The same place and altitude always has the same wind, so a plan you work out holds.
  function windAt(ll, alt) {
    const lon = ll[0], lat = ll[1], tropics = Math.abs(lat) < 25;
    const from = norm((tropics ? 80 : 260) + 35 * Math.sin(lat * 0.13 + lon * 0.045) + 20 * Math.sin(lon * 0.11));
    const kt = (4 + Math.max(0, alt) / 550) * (0.65 + 0.35 * Math.cos(lon * 0.07 + lat * 0.05));
    return { from: Math.round(from), kt: Math.round(kt) };
  }

  const FLYLIB = { C172, burnGph, targetIas, tasFromIas, climbMax, timeScale, zoomFor, course, distanceNm, along, windTriangle, drift, vfrAltitude, legFuel, endurance, windAt, norm, clamp };
  if (typeof module !== 'undefined' && module.exports) module.exports = FLYLIB;
  root.FLYLIB = FLYLIB;
})(typeof window !== 'undefined' ? window : globalThis);
