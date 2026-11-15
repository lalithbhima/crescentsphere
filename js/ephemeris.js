// Analytical ephemeris: Sun, Moon (Meeus ch.47 truncated ELP-2000/82), lunar libration & rotation,
// Earth rotation. Accurate to ~0.02 deg for 2025-2035 — good for horizon/visibility work.
export const D2R = Math.PI / 180;
export const R_MOON = 1737.4, R_EARTH = 6371.0, R_SUN = 695700, AU = 149597870.7;
export const SYNODIC = 29.530588;
export const jdOf = (ms) => ms / 86400000 + 2440587.5;
export const msOf = (jd) => (jd - 2440587.5) * 86400000;
const mod360 = (d) => ((d % 360) + 360) % 360;
const sin = Math.sin, cos = Math.cos;

// [D, M, M', F, sumL (1e-6 deg), sumR (1e-3 km)]
const LR = [
  [0,0,1,0,6288774,-20905355],[2,0,-1,0,1274027,-3699111],[2,0,0,0,658314,-2955968],[0,0,2,0,213618,-569925],
  [0,1,0,0,-185116,48888],[0,0,0,2,-114332,-3149],[2,0,-2,0,58793,246158],[2,-1,-1,0,57066,-152138],
  [2,0,1,0,53322,-170733],[2,-1,0,0,45758,-204586],[0,1,-1,0,-40923,-129620],[1,0,0,0,-34720,108743],
  [0,1,1,0,-30383,104755],[2,0,0,-2,15327,10321],[0,0,1,2,-12528,0],[0,0,1,-2,10980,79661],
  [4,0,-1,0,10675,-34782],[0,0,3,0,10034,-23210],[4,0,-2,0,8548,-21636],[2,1,-1,0,-7888,24208],
  [2,1,0,0,-6766,30824],[1,0,-1,0,-5163,-8379],[1,1,0,0,4987,-16675],[2,-1,1,0,4036,-12831],
  [2,0,2,0,3994,-10445],[4,0,0,0,3861,-11650],[2,0,-3,0,3665,14403],[0,1,-2,0,-2689,-7003],
  [2,0,-1,2,-2602,0],[2,-1,-2,0,2390,10056],
];
const B = [
  [0,0,0,1,5128122],[0,0,1,1,280602],[0,0,1,-1,277693],[2,0,0,-1,173237],[2,0,-1,1,55413],
  [2,0,-1,-1,46271],[2,0,0,1,32573],[0,0,2,1,17198],[2,0,1,-1,9266],[0,0,2,-1,8822],
  [2,-1,0,-1,8216],[2,0,-2,-1,4324],[2,0,1,1,4200],[2,1,0,-1,-3359],
];

export function moonEcl(T) {
  const Lp = mod360(218.3164477 + 481267.88123421 * T - 0.0015786 * T * T) * D2R;
  const D = mod360(297.8501921 + 445267.1114034 * T - 0.0018819 * T * T) * D2R;
  const M = mod360(357.5291092 + 35999.0502909 * T - 0.0001536 * T * T) * D2R;
  const Mp = mod360(134.9633964 + 477198.8675055 * T + 0.0087414 * T * T) * D2R;
  const F = mod360(93.272095 + 483202.0175233 * T - 0.0036539 * T * T) * D2R;
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;
  const A1 = mod360(119.75 + 131.849 * T) * D2R, A2 = mod360(53.09 + 479264.29 * T) * D2R, A3 = mod360(313.45 + 481266.484 * T) * D2R;
  let sl = 0, sr = 0, sb = 0;
  for (const [d, m, mp, f, l, r] of LR) {
    const a = d * D + m * M + mp * Mp + f * F, e = Math.abs(m) === 1 ? E : Math.abs(m) === 2 ? E * E : 1;
    sl += l * e * sin(a); sr += r * e * cos(a);
  }
  for (const [d, m, mp, f, b] of B) {
    const a = d * D + m * M + mp * Mp + f * F, e = Math.abs(m) === 1 ? E : Math.abs(m) === 2 ? E * E : 1;
    sb += b * e * sin(a);
  }
  sl += 3958 * sin(A1) + 1962 * sin(Lp - F) + 318 * sin(A2);
  sb += -2235 * sin(Lp) + 382 * sin(A3) + 175 * sin(A1 - F) + 175 * sin(A1 + F) + 127 * sin(Lp - Mp) - 115 * sin(Lp + Mp);
  const lon = Lp + sl * 1e-6 * D2R, lat = sb * 1e-6 * D2R, dist = 385000.56 + sr / 1000;
  return { lon, lat, dist, vec: [dist * cos(lat) * cos(lon), dist * cos(lat) * sin(lon), dist * sin(lat)] };
}

export function sunEcl(T) {
  const L0 = mod360(280.46646 + 36000.76983 * T), M = mod360(357.52911 + 35999.05029 * T) * D2R;
  const e = 0.016708634 - 0.000042037 * T;
  const C = (1.914602 - 0.004817 * T) * sin(M) + 0.019993 * sin(2 * M) + 0.000289 * sin(3 * M);
  const lon = (L0 + C) * D2R, nu = M + C * D2R;
  const R = (1.000001018 * (1 - e * e) / (1 + e * cos(nu))) * AU;
  return { lon, dist: R, vec: [R * cos(lon), R * sin(lon), 0] };
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Apparent angular radius of the Sun seen from the Moon (radians), from the real distance in km. */
export const sunRadius = (distKm) => Math.asin(R_SUN / distKm);
/** Direction (unit, Moon body frame) of a distant body seen from a point on the surface: removes the parallax of standing off-centre. U = local up, dist in km, hKm = site height above the 1737.4 km sphere. */
export function topoDir(U, dir, dist, hKm) {
  const k = R_MOON + (hKm || 0), v = [dir[0] * dist - U[0] * k, dir[1] * dist - U[1] * k, dir[2] * dist - U[2] * k], l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l, l];
}
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

// Moon body axes in ecliptic coords: x = prime meridian (sub-Earth mean), y = east, p = north pole.
export function lunarFrame(T) {
  const Om = mod360(125.0445479 - 1934.1362891 * T + 0.0020754 * T * T) * D2R;
  const F = mod360(93.272095 + 483202.0175233 * T - 0.0036539 * T * T) * D2R;
  const I = 1.54242 * D2R;
  const p = [-sin(I) * sin(Om), sin(I) * cos(Om), cos(I)], n = [cos(Om), sin(Om), 0];
  const psi = F + Math.PI, pn = cross(p, n);
  const x = [cos(psi) * n[0] + sin(psi) * pn[0], cos(psi) * n[1] + sin(psi) * pn[1], cos(psi) * n[2] + sin(psi) * pn[2]];
  return { x, y: cross(p, x), p };
}
export function earthFrame(jd) {
  const T = (jd - 2451545) / 36525, eps = (23.439291 - 0.0130042 * T) * D2R;
  const gmst = mod360(280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * T * T) * D2R;
  const Xe = [1, 0, 0], Ye = [0, cos(eps), -sin(eps)], p = [0, sin(eps), cos(eps)];
  const x = [cos(gmst) * Xe[0] + sin(gmst) * Ye[0], cos(gmst) * Xe[1] + sin(gmst) * Ye[1], cos(gmst) * Xe[2] + sin(gmst) * Ye[2]];
  return { x, y: cross(p, x), p };
}
export const toBody = (f, v) => [dot(v, f.x), dot(v, f.y), dot(v, f.p)];

// ---- JPL Horizons data (DE441): Sun and Earth directions in the Moon's body frame plus distances, packed by tools/horizons_fetch.py.
let HZ = null;
export const ephemerisSource = () => (HZ ? 'NASA/JPL Horizons (DE441)' : 'Built-in analytical model');
export async function loadHorizons() {
  try {
    const [m, b, sb] = await Promise.all([fetch('tex/horizons_moon.json').then((r) => r.json()), fetch('tex/horizons_moon.bin').then((r) => r.arrayBuffer()), fetch('tex/horizons_scene.bin').then((r) => r.arrayBuffer())]);
    const d = new Float32Array(b), sc = new Float32Array(sb); if (d.length !== m.n * 8 || sc.length !== m.n * 21) throw new Error('size mismatch'); HZ = { ...m, d, sc };
  } catch (err) { console.warn('JPL Horizons file unavailable, using the built-in ephemeris', err); }
  return !!HZ;
}
/** Horizons sample interpolated at jd (null outside its span). Directions are re-normalised after linear interpolation of the 2-hour samples. */
function horizonsAt(jd) {
  if (!HZ) return null; const f = (jd - HZ.jd0) / HZ.stepDays, i = Math.floor(f); if (i < 0 || i >= HZ.n - 1) return null;
  const t = f - i, a = i * 8, d = HZ.d, L = (k) => d[a + k] * (1 - t) + d[a + 8 + k] * t, sun = [L(0), L(1), L(2)], earth = [L(3), L(4), L(5)];
  // scene data: the Moon is interpolated with cubic Hermite using its Horizons velocity, everything else linearly
  const c = HZ.sc, b0 = i * 21, b1 = b0 + 21, dtS = HZ.stepDays * 86400, t2 = t * t, t3 = t2 * t, h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  const S = (k) => c[b0 + k] * (1 - t) + c[b1 + k] * t, moonVec = [0, 1, 2].map((k) => h00 * c[b0 + k] + h10 * dtS * c[b0 + 6 + k] + h01 * c[b1 + k] + h11 * dtS * c[b1 + 6 + k]);
  const fp = norm([S(15), S(16), S(17)]), fx0 = [S(9), S(10), S(11)], kx = dot(fx0, fp), fx = norm([fx0[0] - kx * fp[0], fx0[1] - kx * fp[1], fx0[2] - kx * fp[2]]);
  return { sun: norm(sun), earth: norm(earth), sunDist: L(6), earthDist: L(7), moonVec, sunVec: [S(3), S(4), S(5)], moonVel: [S(6), S(7), S(8)], frame: { x: fx, y: cross(fp, fx), p: fp }, sunRate: S(18), earthRate: S(19), earthSunRate: S(20) };
}
/** Raw sample i (no interpolation), for building series on the same grid. */
export const horizonsGrid = () => HZ;

/** Full state at a Julian date. Vectors in km, ecliptic of date, geocentric unless noted. */
export function state(jd) {
  const T = (jd - 2451545) / 36525;
  const m = moonEcl(T), s = sunEcl(T), mf = lunarFrame(T), ef = earthFrame(jd);
  const toSun = [s.vec[0] - m.vec[0], s.vec[1] - m.vec[1], s.vec[2] - m.vec[2]];
  const toEarth = [-m.vec[0], -m.vec[1], -m.vec[2]];
  let sunDist = Math.hypot(...toSun), earthDist = m.dist;
  let sunBody = toBody(mf, norm(toSun)), earthBody = toBody(mf, norm(toEarth));
  const H = horizonsAt(jd); let moonObj = m, sunObj = s, frame = mf, sunDirEcl = norm(toSun), earthDirEcl = norm(toEarth), moonVel = null, rates = null;
  if (H) {
    sunBody = H.sun; earthBody = H.earth; sunDist = H.sunDist; earthDist = H.earthDist; frame = H.frame; moonVel = H.moonVel; rates = { earth: H.earthRate, sun: H.sunRate, earthSun: H.earthSunRate };
    moonObj = { ...m, vec: H.moonVec, dist: Math.hypot(...H.moonVec) }; sunObj = { ...s, vec: H.sunVec, dist: Math.hypot(...H.sunVec) };
    sunDirEcl = norm(sub3(H.sunVec, H.moonVec)); earthDirEcl = norm([-H.moonVec[0], -H.moonVec[1], -H.moonVec[2]]);
  }
  return {
    jd, T, moon: moonObj, sun: sunObj, mf: frame, ef, sunDist, earthDist, sunRad: sunRadius(sunDist), sunBody, earthBody, moonVel, rates, fromHorizons: !!H,
    sunDirEcl, earthDirEcl,
    libLon: Math.atan2(earthBody[1], earthBody[0]) / D2R, libLat: Math.asin(earthBody[2]) / D2R,
    sunSubLon: Math.atan2(sunBody[1], sunBody[0]) / D2R, sunSubLat: Math.asin(sunBody[2]) / D2R,
  };
}

/** Local topocentric basis (in Moon body coords) at a site. */
export function siteBasis(latDeg, lonDeg) {
  const f = latDeg * D2R, l = lonDeg * D2R, sf = sin(f), cf = cos(f), sl = sin(l), cl = cos(l);
  return { U: [cf * cl, cf * sl, sf], N: [-sf * cl, -sf * sl, cf], E: [-sl, cl, 0], lat: f, lon: l };
}
/** Elevation/azimuth (radians; az from North toward East) of a body-frame unit direction. */
export function altAz(b, d) {
  const u = dot(d, b.U), e = dot(d, b.E), n = dot(d, b.N);
  return { el: Math.asin(Math.max(-1, Math.min(1, u))), az: (Math.atan2(e, n) + 2 * Math.PI) % (2 * Math.PI) };
}

/** Precomputed series so scanning thousands of hours is cheap. */
export class Series {
  constructor(jd0, jd1, stepDays) {
    this.jd0 = jd0; this.step = stepDays; this.n = Math.floor((jd1 - jd0) / stepDays) + 1;
    this.sun = new Float32Array(this.n * 3); this.earth = new Float32Array(this.n * 3); this.sunDist = new Float32Array(this.n); this.earthDist = new Float32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const st = state(jd0 + i * stepDays);
      this.sun.set(st.sunBody, i * 3); this.earth.set(st.earthBody, i * 3); this.sunDist[i] = st.sunDist; this.earthDist[i] = st.earthDist;
    }
  }
  index(jd) { return (jd - this.jd0) / this.step; }
  /** Refill from the Horizons grid when it lines up with this series (otherwise from state()). */
  rebuild() {
    const H = HZ; if (!H) return;
    if (Math.abs(H.jd0 - this.jd0) < 1e-6 && Math.abs(H.stepDays - this.step) < 1e-9) {
      for (let i = 0; i < this.n && i < H.n; i++) { for (let k = 0; k < 3; k++) { this.sun[i * 3 + k] = H.d[i * 8 + k]; this.earth[i * 3 + k] = H.d[i * 8 + 3 + k]; } this.sunDist[i] = H.d[i * 8 + 6]; this.earthDist[i] = H.d[i * 8 + 7]; }
    } else for (let i = 0; i < this.n; i++) { const st = state(this.jd0 + i * this.step); this.sun.set(st.sunBody, i * 3); this.earth.set(st.earthBody, i * 3); this.sunDist[i] = st.sunDist; this.earthDist[i] = st.earthDist; }
  }
}
