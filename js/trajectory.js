// Earth -> Moon transfer trajectories in the planar circular restricted three-body problem (Earth-Moon rotating frame).
// Used by Researcher mode: (1) one representative transfer shape for past landings, (2) a Monte Carlo of thousands of
// trans-lunar injections for the chosen landing site, ranked by delta-v, flight time and Sun/Earth availability on arrival.
// Planar model: the out-of-plane part is charged as a plane-change delta-v (see planeDv). Not a flight-dynamics tool.
import { windowStats, SERIES, skyNow } from './analysis.js';
import { msOf } from './ephemeris.js';

const muE = 398600.4418, muM = 4902.8, D = 384400, RMk = 1737.4, REk = 6378.1;
const mu = muM / (muE + muM), W = Math.sqrt((muE + muM) / (D * D * D)), XE = -mu * D, XM = (1 - mu) * D;
const R0 = REk + 200; // 200 km parking orbit
export const DAY = 86400;

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function randn(r) { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

const muS = 1.32712440018e11, AS = 1.495978707e8, WS = 1.99106e-7, TOR = 2 * Math.PI * Math.sqrt(R0 * R0 * R0 / muE), NOR = 2 * Math.PI / TOR;

/**
 * Fly one Earth -> Moon trajectory in the Earth-Moon rotating frame (circular restricted three-body, 3D; optional Sun term for
 * low-energy routes). o: keep (store path), inc (parking-orbit inclination, rad), sun (include Sun), sunPh (Sun phase), tmax (days),
 * after (keep flying after lunar closest approach to see whether the craft returns to Earth), laps (parking-orbit laps before the burn).
 * Returns path (Earth-relative km, x,y,z triples), tl (s from burn), iPeri (index of closest approach), dMin, tMin, vrel, kind, tof, retDist.
 */
export function fly(phi, dvTli, eps, o = {}) {
  const keep = !!o.keep, inc = o.inc || 0, sun = !!o.sun, sunPh = o.sunPh || 0, tmax = (o.tmax || 9) * DAY, after = !!o.after, dtMax = o.dtMax || (sun ? 7200 : 1500);
  const ci = Math.cos(inc), si = Math.sin(inc), px = XE + R0 * Math.cos(phi), py = R0 * Math.sin(phi), vc = Math.sqrt(muE / R0) + dvTli, ang = phi + Math.PI / 2 + eps;
  let x = px, y = py, z = 0, vx = vc * Math.cos(ang) * ci + W * py, vy = vc * Math.sin(ang) * ci - W * px, vz = vc * si, t = 0;
  const path = [], tl = [], K = new Float64Array(24);
  const f = (X, Y, Z, VX, VY, VZ, T, off) => {
    const ex = X - XE, mx = X - XM, de2 = ex * ex + Y * Y + Z * Z, dm2 = mx * mx + Y * Y + Z * Z, de3 = de2 * Math.sqrt(de2), dm3 = dm2 * Math.sqrt(dm2);
    let ax = 2 * W * VY + W * W * X - muE * ex / de3 - muM * mx / dm3, ay = -2 * W * VX + W * W * Y - muE * Y / de3 - muM * Y / dm3, az = -muE * Z / de3 - muM * Z / dm3;
    if (sun) { const th = sunPh + (WS - W) * T, sx = AS * Math.cos(th), sy = AS * Math.sin(th), qx = X - sx, qy = Y - sy, d2 = qx * qx + qy * qy + Z * Z, d3 = d2 * Math.sqrt(d2), a3 = AS * AS * AS; ax -= muS * (qx / d3 + sx / a3); ay -= muS * (qy / d3 + sy / a3); az -= muS * Z / d3; }
    K[off] = VX; K[off + 1] = VY; K[off + 2] = VZ; K[off + 3] = ax; K[off + 4] = ay; K[off + 5] = az;
  };
  let dMin = 1e12, tMin = 0, vrel = 0, incArr = 0, nextS = 0, kind = 0, pp = null, retDist = 1e12, pastPeri = false;
  const push = () => { path.push(x - XE, y, z); tl.push(t); };
  if (keep) push();
  for (let it = 0; it < 12000; it++) {
    const mx = x - XM, dm = Math.sqrt(mx * mx + y * y + z * z), de = Math.sqrt((x - XE) ** 2 + y * y + z * z), sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
    if (dm < dMin) { dMin = dm; tMin = t; vrel = Math.sqrt((vx - W * y) ** 2 + (vy + W * mx) ** 2 + vz * vz); pp = [x - XE, y, z, t]; incArr = Math.asin(Math.max(-1, Math.min(1, vz / (vrel || 1)))); }
    if (dm < RMk) { kind = 2; break; }
    if (de < REk && t > 3600) { if (pastPeri) retDist = Math.min(retDist, de); else kind = 0; break; }
    if (pastPeri && de < retDist) retDist = de;
    if (t > tmax || de > (sun ? 2.4e6 : 700000)) break;
    if (!after) { if ((!sun || dMin < 60000) && dm > dMin * 1.4 && dm > 15000 && t > 2 * DAY) break; if (dMin < 40000 && dm > dMin * 1.03 + 200 && t > 2 * DAY) break; }
    else if (dMin < 40000 && dm > dMin * 1.03 + 200 && t > 2 * DAY) pastPeri = true;
    const dt = Math.max(15, Math.min(dtMax, 0.04 * Math.min(dm, de) / Math.max(sp, 0.2)));
    f(x, y, z, vx, vy, vz, t, 0);
    f(x + 0.5 * dt * K[0], y + 0.5 * dt * K[1], z + 0.5 * dt * K[2], vx + 0.5 * dt * K[3], vy + 0.5 * dt * K[4], vz + 0.5 * dt * K[5], t + 0.5 * dt, 6);
    f(x + 0.5 * dt * K[6], y + 0.5 * dt * K[7], z + 0.5 * dt * K[8], vx + 0.5 * dt * K[9], vy + 0.5 * dt * K[10], vz + 0.5 * dt * K[11], t + 0.5 * dt, 12);
    f(x + dt * K[12], y + dt * K[13], z + dt * K[14], vx + dt * K[15], vy + dt * K[16], vz + dt * K[17], t + dt, 18);
    x += dt / 6 * (K[0] + 2 * K[6] + 2 * K[12] + K[18]); y += dt / 6 * (K[1] + 2 * K[7] + 2 * K[13] + K[19]); z += dt / 6 * (K[2] + 2 * K[8] + 2 * K[14] + K[20]);
    vx += dt / 6 * (K[3] + 2 * K[9] + 2 * K[15] + K[21]); vy += dt / 6 * (K[4] + 2 * K[10] + 2 * K[16] + K[22]); vz += dt / 6 * (K[5] + 2 * K[11] + 2 * K[17] + K[23]); t += dt;
    if (keep && t >= nextS) { push(); nextS = t + (dm < 40000 ? 1500 : de > 1e6 ? 40000 : 7000); }
  }
  if (keep) push();
  let iPeri = -1;
  if (keep && pp) { iPeri = tl.findIndex((q) => q > pp[3]); if (iPeri < 0) iPeri = tl.length; path.splice(iPeri * 3, 0, pp[0], pp[1], pp[2]); tl.splice(iPeri, 0, pp[3]); }
  let lapDays = 0;
  if (keep && o.laps) { // coast around the parking orbit before the burn (drawn in the rotating frame)
    const per = 28, n = o.laps * per, pre = [], pt = [];
    for (let i = 0; i < n; i++) { const tau = -(1 - i / n) * o.laps * TOR, a = (NOR - W) * tau, c = Math.cos(a), s = Math.sin(a), ph = Math.cos(phi), qh = Math.sin(phi);
      const tx = -qh * ci, ty = ph * ci, tz = si; pre.push(R0 * (c * ph + s * tx), R0 * (c * qh + s * ty), R0 * s * tz); pt.push(tau); }
    path.unshift(...pre); tl.unshift(...pt); if (iPeri >= 0) iPeri += n; lapDays = o.laps * TOR / DAY;
  }
  const alt = dMin - RMk;
  if (kind !== 2) kind = alt < 60 ? 2 : alt <= 800 ? 1 : dMin < 90000 ? 3 : 0;
  return { path, tl, iPeri, incArr, dMin, tMin, vrel, kind, tof: tMin / DAY + lapDays, retDist, lapDays };
}

/** A representative low-delta-v direct transfer (centre of the standard family). */
let nominalCache = null;
export function nominal() {
  if (nominalCache) return nominalCache;
  let best = null;
  for (let phi = 3.9; phi <= 4.7; phi += 0.02) for (let dv = 3.04; dv <= 3.2; dv += 0.01) {
    const r = fly(phi, dv, 0); if (r.kind !== 1) continue;
    const cost = Math.abs(r.dMin - RMk - 150) / 100 + dv * 5; if (!best || cost < best.cost) best = { phi, dv, cost };
  }
  if (!best) best = { phi: 4.28, dv: 3.13 };
  const r = fly(best.phi, best.dv, 0, { keep: true }); nominalCache = { ...best, ...r }; return nominalCache;
}

/** Plane-change cost of reaching a site latitude (approach is near the lunar equator +-6.7 deg). */
/** Continuous days (max 14) with both Sun and Earth above the local horizon, counted from the landing moment. */
export function operateDays(A, land) {
  const i0 = Math.max(0, Math.min(SERIES.n - 2, Math.round(SERIES.index(land)))), nmax = Math.min(SERIES.n - i0, Math.round(14 / (1 / 12)));
  let k = 0; while (k < nmax && A.sunM[i0 + k] > 0 && A.earthM[i0 + k] > 0) k++;
  return k / 12;
}
export const planeDv = (latDeg) => { const di = Math.max(0, Math.abs(latDeg) - 6.7) * Math.PI / 180; return 2 * 1.63 * Math.sin(di / 2); };

/**
 * Monte Carlo of Earth -> Moon transfers for a landing at `site` around date `jd`.
 * Each trial draws a parking-orbit departure phase (time of day), trans-lunar-injection burn and pointing error and a launch date;
 * it is flown to lunar closest approach, costed (TLI + lunar-orbit insertion + plane change) and judged against Sun & Earth at arrival.
 */
export const FAMILIES = ['Standard direct', 'Fast direct', 'Slow direct', 'Parking-orbit', 'Inclined approach', 'Free return', 'Low-energy'];
const PI2 = Math.PI * 2;

function search(phi, eps, o, lo, hi, scan, ref) { // find the burn that brings the craft closest to the Moon
  const d = (dv) => fly(phi, dv, eps, { ...o, keep: false }).dMin; let bd = 1e12, bv = lo;
  for (let k = 0; k <= scan; k++) { const dv = lo + (hi - lo) * (k / scan), q = d(dv); if (q < bd) { bd = q; bv = dv; } }
  let a = bv - (hi - lo) / scan, b = bv + (hi - lo) / scan;
  for (let k = 0; k < ref; k++) { const m1 = a + (b - a) / 3, m2 = b - (b - a) / 3, d1 = d(m1), d2 = d(m2); if (d1 < d2) { b = m2; if (d1 < bd) { bd = d1; bv = m1; } } else { a = m1; if (d2 < bd) { bd = d2; bv = m2; } } }
  return { dv: bv, d: bd };
}

/**
 * Monte Carlo of Earth -> Moon routes for a landing at `site` around date `jd`. Seven route families are sampled (direct fast / standard / slow,
 * parking-orbit laps, inclined approaches, free-return loops, Sun-assisted low-energy transfers). Every route is flown with the physics above, costed
 * (burn + lunar-orbit insertion + plane change for the site latitude) and checked against Sun and Earth availability after landing.
 */
export function simulateTransfers({ jd, sites, analyze, weight = 0.12, minRun = 1, seed = 7, budgetMs = 2800 }) {
  const r = rng(seed ^ Math.floor(jd * 10)), nom = nominal(), now = () => (typeof performance !== 'undefined' ? performance : Date).now(), t0 = now();
  const rec = { path: [], starts: [], counts: [], fam: [], kind: [], dv: [], tof: [], ok: [], launch: [], iPeri: [], run: [], loi: [], tli: [], plane: [], cost: [], land: [] };
  const cache = new Map(), famCount = new Array(FAMILIES.length).fill(0); let off = 0, flights = 0, best = -1, bestCost = 1e9, nOk = 0;
  const raw = [];
  const add = (fam, f, dv) => {
    const i = rec.fam.length, land = jd + (r() * 2 - 1) * 1.0, n = f.path.length / 3;
    rec.starts.push(off); rec.counts.push(n); for (let k = 0; k < f.path.length; k++) rec.path.push(f.path[k]); off += n;
    rec.fam.push(fam); rec.kind.push(f.kind); rec.tof.push(f.tof); rec.iPeri.push(f.iPeri); rec.tli.push(dv); famCount[fam]++;
    rec.launch.push(land - f.tof - 1); rec.land.push(land); raw.push({ kind: f.kind, vrel: f.vrel, dMin: f.dMin, incArr: f.incArr });
  };
  const quota = [150, 110, 90, 0, 110, 0, 0];
  const gen = {
    0: () => ({ phi: nom.phi + (r() * 2 - 1) * 0.6, eps: randn(r) * 0.01, o: {}, lo: nom.dv - 0.1, hi: nom.dv + 0.16, scan: 10, ref: 6 }),
    1: () => ({ phi: nom.phi - (0.08 + r() * 0.34), eps: randn(r) * 0.004, o: {}, lo: 3.17, hi: 3.65, scan: 28, ref: 8 }),
    2: () => ({ phi: nom.phi + (0.35 + r() * 0.3), eps: randn(r) * 0.006, o: {}, lo: 3.10, hi: 3.17, scan: 8, ref: 6 }),
    4: () => ({ phi: nom.phi + (r() * 2 - 1) * 0.5, eps: randn(r) * 0.01, o: { inc: (8 + r() * 32) * Math.PI / 180 * (r() < 0.5 ? -1 : 1) }, lo: nom.dv - 0.1, hi: nom.dv + 0.16, scan: 10, ref: 6 }),
  };
  const budget = (frac) => t0 + budgetMs * frac;
  // direct families (standard, fast, slow, inclined) plus parking-orbit laps added to a share of the standard ones
  let phase = 0; const target = [150, 110, 90, 0, 110], got = [0, 0, 0, 0, 0], tries = [0, 0, 0, 0, 0];
  while (now() < budget(0.5) && phase < 4000) {
    phase++; const fam = [0, 1, 2, 4][phase % 4]; if (got[fam] >= target[fam] || tries[fam] > target[fam] * 8) { if ([0, 1, 2, 4].every((f) => got[f] >= target[f] || tries[f] > target[f] * 8)) break; continue; }
    tries[fam]++; const g = gen[fam](), s = search(g.phi, g.eps, g.o, g.lo, g.hi, g.scan, g.ref); flights += g.scan + 2 * g.ref + 2; if (s.d - RMk > 900) continue;
    const laps = fam === 0 && r() < 0.4 ? 1 + Math.floor(r() * 3) : 0, dv = s.dv + randn(r) * 0.0012, f = fly(g.phi, dv, g.eps, { ...g.o, keep: true, laps }); flights++;
    if (f.kind !== 1 && f.kind !== 2) continue; got[fam]++; add(laps ? 3 : fam, f, dv);
  }
  // free-return loops: standard approaches that keep flying and swing back to Earth
  for (let i = 0; i < 700 && now() < budget(0.85) && famCount[5] < 22; i++) {
    const phi = nom.phi + (r() * 2 - 1) * 0.6, eps = randn(r) * 0.01, s = search(phi, eps, {}, nom.dv - 0.1, nom.dv + 0.16, 10, 6); flights += 22; if (s.d - RMk > 900) continue;
    const dv = s.dv + randn(r) * 0.002, f = fly(phi, dv, eps, { keep: true, after: true, tmax: 16 }); flights++; if ((f.kind === 1 || f.kind === 2) && f.retDist < 120000) add(5, f, dv);
  }
  // low-energy routes: Sun-assisted, about one to four months
  for (let i = 0; i < 1500 && now() < budget(1) && famCount[6] < 45; i++) {
    const phi = r() * PI2, sp = r() * PI2, dv0 = 3.14 + r() * 0.07, o = { sun: true, sunPh: sp, tmax: 160 }; let f = fly(phi, dv0, 0, { ...o }); flights++;
    if (f.tof < 25 || f.dMin - RMk > 20000) continue;
    const s = search(phi, 0, o, dv0 - 0.004, dv0 + 0.004, 14, 8); flights += 30; if (s.d - RMk > 1500) continue;
    f = fly(phi, s.dv, 0, { ...o, keep: true }); flights++; if (f.tof > 25 && (f.kind === 1 || f.kind === 2)) add(6, f, s.dv);
  }
  // Score every route against every candidate site: fuel (TLI + orbit insertion + plane change for the site latitude) and Sun and Earth after landing
  const N0 = rec.fam.length, cands = sites.map((site) => ({ site, A: analyze(site), cache: new Map(), best: null, any: null }));
  const evalRoute = (i, c) => {
    const q = raw[i]; if (q.kind !== 1) return null; const land = rec.land[i];
    const loi = Math.max(0, q.vrel - Math.sqrt(muM / q.dMin)), incDeg = Math.abs(q.incArr) * 180 / Math.PI, di = Math.max(0, Math.abs(c.site.lat) - Math.max(incDeg, 6.7)) * Math.PI / 180, plane = 2 * 1.63 * Math.sin(di / 2), dvt = rec.tli[i] + loi + plane;
    const key = Math.round(land * 12); let run = c.cache.get(key); if (run === undefined) { run = operateDays(c.A, land); c.cache.set(key, run); }
    return { i, loi, plane, dv: dvt, run, viable: run >= minRun, cost: dvt + 0.01 * rec.tof[i] - weight * Math.min(run, 14) + (run > 0 ? 0 : 2) };
  };
  for (const c of cands) for (let i = 0; i < N0; i++) { const e = evalRoute(i, c); if (!e) continue; if (e.viable && (!c.best || e.cost < c.best.cost)) c.best = e; if (!c.any || e.cost < c.any.cost) c.any = e; }
  const scored = cands.map((c) => ({ site: c.site, ...(c.best || c.any || { i: -1, cost: 1e9, dv: 0, loi: 0, plane: 0, run: 0 }), viable: !!c.best })).filter((s) => s.i >= 0);
  scored.sort((a, b) => (b.viable - a.viable) || a.cost - b.cost);
  const win = scored[0] || null; best = win ? win.i : -1; nOk = scored.filter((s) => s.viable).length;
  if (win) { const c = cands.find((x) => x.site === win.site); for (let i = 0; i < N0; i++) { const e = evalRoute(i, c); rec.dv.push(e ? e.dv : 0); rec.loi.push(e ? e.loi : 0); rec.plane.push(e ? e.plane : 0); rec.run.push(e ? e.run : 0); rec.ok.push(e && e.viable ? 1 : 0); rec.cost.push(e ? e.cost : 1e9); } }
  else for (let i = 0; i < N0; i++) { rec.dv.push(0); rec.loi.push(0); rec.plane.push(0); rec.run.push(0); rec.ok.push(0); rec.cost.push(1e9); }
  const N = rec.fam.length, pick = best >= 0 ? { i: best, fam: rec.fam[best], dv: rec.dv[best], tli: rec.tli[best], loi: rec.loi[best], plane: rec.plane[best], tof: rec.tof[best], launch: rec.launch[best], land: rec.land[best], viable: !!rec.ok[best], run: rec.run[best], iPeri: rec.iPeri[best] } : null;
  return { N, winner: win ? win.site : null, ranking: scored, nSites: cands.length, path: Float32Array.from(rec.path), starts: Int32Array.from(rec.starts), counts: Int32Array.from(rec.counts), fam: Uint8Array.from(rec.fam), kind: Uint8Array.from(rec.kind), dv: Float32Array.from(rec.dv), tli: Float32Array.from(rec.tli), tof: Float32Array.from(rec.tof), ok: Uint8Array.from(rec.ok), iPeri: Int32Array.from(rec.iPeri), best: pick, famCount, nOk, flights, nMoon: N, XE, XM, D };
}

export const FRAME = { XE, XM, D, RMk, REk, dE: -XE };

/** Break the best route into analysable steps. idx = index into [path points..., 40 descent-arc points]. */
export function describeBest(res, site, A, T = 40) {
  if (!res.best) return [];
  const i = res.best.i, n = res.counts[i], o = res.starts[i], P = (k) => [res.path[(o + k) * 2], res.path[(o + k) * 2 + 1]], tt = (k) => res.ts[o + k] / DAY;
  const dEarth = (k) => Math.hypot(...P(k)), dMoon = (k) => { const p = P(k); return Math.hypot(p[0] - D, p[1]); };
  const speed = (k) => { const a = Math.max(0, k - 1), b = Math.min(n - 1, k + 1), pa = P(a), pb = P(b), dt = Math.max(1, res.ts[o + b] - res.ts[o + a]), vx = (pb[0] - pa[0]) / dt, vy = (pb[1] - pa[1]) / dt, p = P(k); return Math.hypot(vx - W * p[1], vy + W * p[0]); };
  let mid = 0, soi = Math.floor(n * 0.8), tm = res.ts[o + n - 1] / 2; for (let k = 0; k < n; k++) if (Math.abs(res.ts[o + k] - tm) < Math.abs(res.ts[o + mid] - tm)) mid = k;
  for (let k = 0; k < n; k++) if (dMoon(k) < 66000) { soi = k; break; }
  const tli = res.tli[i], loi = res.dvLoi[i], pl = res.planeDv, land = res.best.land, sky = skyNow(A, land), ws = windowStats(A, land, 7), dsc = 1.87;
  const fmt = (v, u, d = 0) => v.toLocaleString(undefined, { maximumFractionDigits: d }) + ' ' + u;
  const steps = [
    { name: 'Trans-lunar injection', idx: 0, t: 0, dv: tli, text: 'Burn from a 200 km parking orbit to leave Earth toward the Moon.', info: [['Time', 'T+0'], ['Altitude', '200 km'], ['Burn', fmt(tli, 'km/s', 2)], ['Speed after burn', fmt(speed(0), 'km/s', 2)]] },
    { name: 'Coast, mid-course', idx: mid, t: tt(mid), dv: 0, text: 'Unpowered coast. This is where small trajectory corrections would be made.', info: [['Time', 'T+' + tt(mid).toFixed(1) + ' d'], ['From Earth', fmt(dEarth(mid), 'km')], ['To Moon', fmt(dMoon(mid), 'km')], ['Speed (Earth frame)', fmt(speed(mid), 'km/s', 2)]] },
    { name: 'Enter lunar influence', idx: soi, t: tt(soi), dv: 0, text: 'Moon\'s gravity now dominates (about 66,000 km out). The craft speeds up on approach.', info: [['Time', 'T+' + tt(soi).toFixed(1) + ' d'], ['To Moon', fmt(dMoon(soi), 'km')], ['Speed', fmt(speed(soi), 'km/s', 2)]] },
    { name: 'Lunar orbit insertion', idx: n - 1, t: tt(n - 1), dv: loi, text: 'Closest approach. A braking burn captures the craft into lunar orbit.', info: [['Time', 'T+' + tt(n - 1).toFixed(1) + ' d'], ['Altitude', fmt(res.counts ? dMoon(n - 1) - RMk : 0, 'km')], ['Burn', fmt(loi, 'km/s', 2)]] },
    { name: 'Descent orbit', idx: n + Math.floor(T * 0.4), t: tt(n - 1) + 1, dv: pl, text: 'Hold in lunar orbit about one day, then change the orbit plane to pass over the site.', info: [['Time', 'T+' + (tt(n - 1) + 1).toFixed(1) + ' d'], ['Plane change', fmt(pl, 'km/s', 2)], ['Orbit speed', '1.63 km/s']] },
    { name: 'Touchdown', idx: n + T - 1, t: tt(n - 1) + 1.1, dv: dsc, text: 'Powered descent to the surface. This is the moment that matters for power and radio.', info: [['Landing', new Date(msOf(land)).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'], ['Sun elevation', sky.sun.el.toFixed(1) + '°'], ['Earth elevation', sky.earth.el.toFixed(1) + '°'], ['Sun and Earth, continuous', (res.best.run || 0).toFixed(1) + ' d'], ['Sun and Earth, next 7 d', Math.round(ws.bothFrac * 100) + '% of time']] },
  ];
  let cum = 0; for (const s of steps) { cum += s.dv; s.cum = cum; }
  steps.forEach((s, k) => { s.k = k; });
  return steps;
}
