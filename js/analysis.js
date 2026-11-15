// Site analysis: Sun/Earth visibility (with terrain horizon) over time, countdowns, scores.
import { D2R, Series, siteBasis, altAz, jdOf, state, SYNODIC, topoDir, sunRadius, R_MOON } from './ephemeris.js';
import { siteHorizon } from './terrain.js';

export const SUN_RAD = 0.2666 * D2R;
export const JD_MIN = jdOf(Date.UTC(2025, 5, 1)), JD_MAX = jdOf(Date.UTC(2040, 11, 1));
export const STEP = 1 / 12; // 2 hours
export const SERIES = new Series(jdOf(Date.UTC(2025, 0, 1)), jdOf(Date.UTC(2041, 0, 1)), STEP);

export function horizonAt(profile, az) {
  const n = profile.length, f = (az / (2 * Math.PI)) * n, i = Math.floor(f) % n, t = f - Math.floor(f);
  return profile[i] * (1 - t) + profile[(i + 1) % n] * t;
}


const EARTH_R_KM = 6378.137;
/** Share (0..1) of the Sun's disc hidden behind the Earth's disc. sunDir/earthDir unit vectors, rs = Sun's angular radius, distKm = distance to Earth. */
export function eclipseFrac(sunDir, earthDir, rs, distKm) {
  const re = Math.asin(Math.min(1, EARTH_R_KM / distKm)), c = sunDir[0] * earthDir[0] + sunDir[1] * earthDir[1] + sunDir[2] * earthDir[2], dd = Math.acos(Math.max(-1, Math.min(1, c)));
  if (dd >= rs + re) return 0; if (dd <= Math.abs(re - rs)) return re >= rs ? 1 : (re * re) / (rs * rs);
  const A1 = rs * rs * Math.acos((dd * dd + rs * rs - re * re) / (2 * dd * rs)), A2 = re * re * Math.acos((dd * dd + re * re - rs * rs) / (2 * dd * re)), A3 = 0.5 * Math.sqrt(Math.max(0, (-dd + rs + re) * (dd + rs - re) * (dd - rs + re) * (dd + rs + re)));
  return Math.min(1, (A1 + A2 - A3) / (Math.PI * rs * rs));
}
/** Topocentric Earth direction for a site analysis and a state() result. */
export const earthTopo = (A, st) => topoDir(A.b.U, st.earthBody, st.earthDist, A.hKm);

const cache = new Map();
export function dropAnalysis(site) { cache.delete(`${site.lat.toFixed(3)},${site.lon.toFixed(3)}`); }
export function analyze(site) {
  const key = `${site.lat.toFixed(3)},${site.lon.toFixed(3)}`;
  if (cache.has(key)) return cache.get(key);
  const hz = siteHorizon(site), b = siteBasis(site.lat, site.lon), N = SERIES.n, hKm = hz.dem.height(hz.x, hz.y);
  const sunEl = new Float32Array(N), earthEl = new Float32Array(N), sunM = new Float32Array(N), earthM = new Float32Array(N), ecl = new Float32Array(N);
  const d = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    d[0] = SERIES.sun[i * 3]; d[1] = SERIES.sun[i * 3 + 1]; d[2] = SERIES.sun[i * 3 + 2];
    const rs = sunRadius(SERIES.sunDist[i]);
    let a = altAz(b, d), h = horizonAt(hz.profile, a.az);
    sunEl[i] = a.el / D2R; sunM[i] = (a.el + rs - h) / D2R;
    const sd = [d[0], d[1], d[2]];
    d[0] = SERIES.earth[i * 3]; d[1] = SERIES.earth[i * 3 + 1]; d[2] = SERIES.earth[i * 3 + 2];
    const te = topoDir(b.U, d, SERIES.earthDist[i], hKm);   // Earth is close: seen from the surface site, not from the Moon's centre
    a = altAz(b, te); h = horizonAt(hz.profile, a.az);
    earthEl[i] = a.el / D2R; earthM[i] = (a.el - h) / D2R;
    ecl[i] = eclipseFrac(sd, te, rs, te[3]);
  }
  const A = { site, key, hz, b, hKm, sunEl, earthEl, sunM, earthM, ecl };
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  cache.set(key, A); return A;
}

const clampJd = (jd) => Math.min(JD_MAX, Math.max(JD_MIN, jd));
const idx = (jd) => Math.max(0, Math.min(SERIES.n - 2, Math.round(SERIES.index(jd))));
const lerpAt = (arr, jd) => { const f = SERIES.index(jd), i = Math.max(0, Math.min(SERIES.n - 2, Math.floor(f))), t = f - i; return arr[i] * (1 - t) + arr[i + 1] * t; };
export const sunElAt = (A, jd) => lerpAt(A.sunEl, jd);
export const earthElAt = (A, jd) => lerpAt(A.earthEl, jd);
export const sunUpAt = (A, jd) => lerpAt(A.sunM, jd) > 0;
export const earthUpAt = (A, jd) => lerpAt(A.earthM, jd) > 0;

/** Stats over [jd, jd+days]. */
export function windowStats(A, jd, days = SYNODIC) {
  const i0 = idx(jd), n = Math.min(SERIES.n - i0, Math.round(days / STEP));
  let s = 0, e = 0, b = 0, darkRun = 0, darkMax = 0, noERun = 0, noEMax = 0, maxEl = -90, litEl = 0, sCount = 0;
  for (let k = 0; k < n; k++) {
    const su = A.sunM[i0 + k] > 0, eu = A.earthM[i0 + k] > 0;
    if (su) { s++; litEl += A.sunEl[i0 + k]; sCount++; darkRun = 0; } else { darkRun++; if (darkRun > darkMax) darkMax = darkRun; }
    if (eu) { e++; noERun = 0; } else { noERun++; if (noERun > noEMax) noEMax = noERun; }
    if (su && eu) b++;
    if (A.sunEl[i0 + k] > maxEl) maxEl = A.sunEl[i0 + k];
  }
  const sunFrac = s / n, earthFrac = e / n, bothFrac = b / n;
  return {
    sunFrac, earthFrac, bothFrac, darkDays: (darkMax * STEP), noEarthDays: (noEMax * STEP), maxSunEl: maxEl, avgLitEl: sCount ? litEl / sCount : 0,
    power: sunFrac, score: Math.round(100 * (0.55 * bothFrac + 0.25 * sunFrac + 0.2 * earthFrac)),
  };
}

/** Time to next flip of Sun/Earth visibility. kind: 'sun' | 'earth'. */
export function nextEvent(A, jd, kind) {
  const M = kind === 'sun' ? A.sunM : A.earthM, i0 = idx(jd), up = lerpAt(M, jd) > 0;
  const limit = Math.min(SERIES.n - 2, i0 + Math.round(120 / STEP));
  for (let i = i0; i < limit; i++) {
    if ((M[i + 1] > 0) !== up) {
      const t = M[i] / (M[i] - M[i + 1]), ejd = SERIES.jd0 + (i + Math.min(1, Math.max(0, t))) * STEP;
      if (ejd > jd) return { up, jd: ejd, dt: ejd - jd };
    }
  }
  return { up, jd: null, dt: Infinity };
}
export function fmtDur(days) {
  if (!isFinite(days)) return '—';
  const m = Math.round(days * 1440);
  if (m < 1) return '<1m';
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d >= 10) return `${d}d`;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mm}m`;
  return `${mm}m`;
}

/** Live sky (exact ephemeris) used by the 3D scene. */
export function skyNow(A, jd) {
  const st = state(jd), s = altAz(A.b, st.sunBody), e = altAz(A.b, earthTopo(A, st));
  return { st, sunRad: st.sunRad, sun: { ...s, hz: horizonAt(A.hz.profile, s.az) }, earth: { ...e, hz: horizonAt(A.hz.profile, e.az) } };
}

/** Sun and Earth tracks (az/el deg) over a span, for sky dome plots. */
export function skyTrack(A, jd, days = 30, stepH = 6) {
  const out = [], n = Math.round((days * 24) / stepH);
  for (let k = 0; k <= n; k++) {
    const t = clampJd(jd + (k * stepH) / 24), st = state(t), s = altAz(A.b, st.sunBody), e = altAz(A.b, earthTopo(A, st));
    out.push({ jd: t, sun: s, earth: e });
  }
  return out;
}
export const clamp = clampJd;

// ------------------------------------------------------------------ Earth eclipsing the Sun (power) and local solar time
const eclCache = new Map();
/** Fraction of the Sun covered by the Earth right now at this site (0 when the Sun is below the horizon anyway). */
export function eclipseNow(A, jd) {
  const st = state(jd), te = earthTopo(A, st), f = eclipseFrac(st.sunBody, te, st.sunRad, te[3]), s = altAz(A.b, st.sunBody), up = s.el + st.sunRad > horizonAt(A.hz.profile, s.az);
  return up ? f : 0;
}
/** Earth eclipses of the Sun that matter for power (Sun above the horizon): the one in progress (if any) and the next one within a year. */
export function eclipseInfo(A, jd) {
  const key = A.key + ':' + Math.floor(jd * 24); if (eclCache.has(key)) return eclCache.get(key);
  const i0 = idx(jd), last = Math.min(SERIES.n - 2, i0 + 366 * 12), eff = (i) => (A.sunM[i] > 0 ? A.ecl[i] : 0), TH = 0.002, runs = [];
  for (let i = Math.max(0, i0 - 3); i < last; i++) {
    if (eff(i) > TH) { let j = i; while (j < last && eff(j + 1) > TH) j++; runs.push([i, j]); i = j; if (runs[runs.length - 1][0] > i0) break; }
  }
  const refine = ([a, b]) => { // 5-minute sweep around the 2-hour samples for exact start, end and depth
    const t0 = SERIES.jd0 + (a - 1) * STEP, t1 = SERIES.jd0 + (b + 1) * STEP; let s = null, e = null, mx = 0;
    for (let t = t0; t <= t1; t += 5 / 1440) { const f = eclipseNow(A, t); if (f > TH * 0.5) { if (s === null) s = t; e = t; if (f > mx) mx = f; } }
    return s === null ? null : { start: s, end: e + 5 / 1440, max: mx, total: mx > 0.995 };
  };
  let cur = null, next = null;
  for (const r of runs) { const ev = refine(r); if (!ev) continue; if (ev.start <= jd && jd <= ev.end) cur = ev; else if (ev.start > jd && !next) next = ev; if (cur && next) break; }
  const out = { now: eclipseNow(A, jd), cur, next }; if (eclCache.size > 200) eclCache.clear(); eclCache.set(key, out); return out;
}
/** Eclipse flag per series sample for the graph window: true when the Sun is above the horizon and partly behind the Earth. */
export const eclipseAtIndex = (A, i) => A.sunM[i] > 0 && A.ecl[i] > 0.002;

/** Local solar time at the site, hours 0-24, with the whole 29.5-day lunar day stretched over 24 h (noon = Sun at the site's meridian). */
export function localSolarTime(site, st) { return ((((12 + (site.lon - st.sunSubLon) / 15) % 24) + 24) % 24); }
export function fmtClock(h) { const m = Math.round(h * 60) % 1440, hh = Math.floor(m / 60), mm = m % 60; return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0'); }

// ------------------------------------------------------------------ geometric rise/set (spherical Moon, no terrain) for the Horizons cross-check
/** Next time (JD) after jd that the Sun's or Earth's upper limb (the convention Horizons uses for rise and set) crosses the geometric horizon of the site. rising = true for rise. Returns null if none within 60 days. */
export function geoEvent(site, jd, kind, rising) {
  const b = siteBasis(site.lat, site.lon), i0 = idx(jd), last = Math.min(SERIES.n - 2, i0 + 60 * 12), d = [0, 0, 0];
  const el = (i) => {
    if (kind === 'sun') { d[0] = SERIES.sun[i * 3]; d[1] = SERIES.sun[i * 3 + 1]; d[2] = SERIES.sun[i * 3 + 2]; return altAz(b, d).el + sunRadius(SERIES.sunDist[i]); }
    d[0] = SERIES.earth[i * 3]; d[1] = SERIES.earth[i * 3 + 1]; d[2] = SERIES.earth[i * 3 + 2]; const te = topoDir(b.U, d, SERIES.earthDist[i], 0); return altAz(b, te).el + Math.asin(EARTH_R_KM / te[3]);
  };
  let prev = el(i0);
  for (let i = i0; i < last; i++) {
    const nx = el(i + 1); if ((prev < 0) === rising && (nx >= 0) === rising) { const t = prev / (prev - nx), ejd = SERIES.jd0 + (i + Math.min(1, Math.max(0, t))) * STEP; if (ejd > jd) return ejd; }
    prev = nx;
  }
  return null;
}
