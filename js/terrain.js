// Terrain model. The polar DEM is synthesised from the real crater catalogue positions/diameters
// (Shackleton, Haworth, Shoemaker, Faustini, de Gerlache, ...) plus fractal relief and a
// power-law population of smaller craters. The same Dem interface accepts real LOLA tiles.
import { RM, bilinear, horizonAngle } from './shadow.js';

const D2R = Math.PI / 180;
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy) * 2 - 1;
}
export function fbm(x, y, seed, oct = 5) {
  let a = 1, f = 1, s = 0, n = 0;
  for (let i = 0; i < oct; i++) { s += a * vnoise(x * f, y * f, seed + i * 17); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
const smooth = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

function craterProfile(u, depth, rim) {
  if (u < 1) {
    const bowl = u < 0.35 ? -depth : -depth * (1 - smooth((u - 0.35) / 0.65));
    const t = (1 - u) / 0.14;
    return bowl + rim * Math.exp(-t * t);
  }
  const t = (u - 1) / 0.2;
  return rim * (0.65 * Math.exp(-t * t) + 0.35 * Math.pow(u, -3.2));
}
function stamp(h, n, cell, cx, cy, rad, depth, rim, span = 3) {
  const x0 = Math.max(0, Math.floor((cx - rad * span) / cell)), x1 = Math.min(n - 1, Math.ceil((cx + rad * span) / cell));
  const y0 = Math.max(0, Math.floor((cy - rad * span) / cell)), y1 = Math.min(n - 1, Math.ceil((cy + rad * span) / cell));
  for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) {
    const d = Math.hypot(i * cell - cx, j * cell - cy);
    if (d < rad * span) h[j * n + i] += craterProfile(d / rad, depth, rim);
  }
}

export const polarXY = (latDeg, lonDeg) => {
  const colat = (latDeg + 90) * D2R, r = 2 * RM * Math.tan(colat / 2), l = lonDeg * D2R;
  return [r * Math.sin(l), r * Math.cos(l)];
};
export const polarLL = (x, y) => {
  const r = Math.hypot(x, y), colat = 2 * Math.atan(r / (2 * RM));
  return [colat / D2R - 90, Math.atan2(x, y) / D2R];
};

// name, lat, lon(E), diameter km, depth km
export const POLAR_CRATERS = [
  ['Shackleton', -89.66, 127.8, 21, 4.2], ['Haworth', -87.5, -5, 51, 4.4], ['Shoemaker', -88.1, 44.9, 51, 4.3],
  ['Faustini', -87.3, 77, 39, 3.4], ['de Gerlache', -88.5, -87.1, 32, 3.3], ['Sverdrup', -88.5, -152, 30, 3.1],
  ['Nobile', -85.2, 53.3, 73, 3.5], ['Cabeus', -84.9, -35.5, 98, 4.0], ['Amundsen', -84.5, 82.8, 101, 4.1],
  ['Slater', -88.1, 38, 20, 2.2], ['Idel’son', -84.2, 111, 60, 3.0], ['Wiechert J', -85.2, -120, 40, 2.8],
];

export class Dem {
  constructor(h, n, cell, kind) {
    this.h = h; this.n = n; this.cell = cell; this.kind = kind;
    let mx = -1e9; for (let i = 0; i < h.length; i++) if (h[i] > mx) mx = h[i];
    this.hmax = mx;
  }
  fx(x) { return x / this.cell + this.n / 2 - 0.5; }
  height(x, y) { return bilinear(this.h, this.n, this.fx(x), this.fx(y)); }
  xy(latDeg, lonDeg) { return this.kind === 'polar' ? polarXY(latDeg, lonDeg) : [0, 0]; }
  /** local N/E unit vectors in grid space */
  axes(x, y) {
    if (this.kind !== 'polar') return { Nx: 0, Ny: 1, Ex: 1, Ey: 0 };
    const l = Math.atan2(x, y); return { Nx: Math.sin(l), Ny: Math.cos(l), Ex: Math.cos(l), Ey: -Math.sin(l) };
  }
  /** terrain horizon (radians) for every azimuth step (0 = North, clockwise) as seen from (x,y) */
  horizon(x, y, steps = 180, maxKm = this.n * this.cell * 0.6) {
    const out = new Float32Array(steps), a = this.axes(x, y), fx = this.fx(x), fy = this.fx(y), h0 = this.height(x, y);
    for (let k = 0; k < steps; k++) {
      const az = (k / steps) * 2 * Math.PI, c = Math.cos(az), s = Math.sin(az);
      out[k] = horizonAngle(this.h, this.n, this.cell, fx, fy, h0, c * a.Nx + s * a.Ex, c * a.Ny + s * a.Ey, maxKm);
    }
    return out;
  }
}

export function buildPolarDem(n = 384, half = 200, onTick) {
  const cell = (2 * half) / n, h = new Float32Array(n * n), rng = mulberry32(20260331);
  const px = (km) => km + half; // stamp() uses coords from the corner
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = (i + 0.5) * cell - half, y = (j + 0.5) * cell - half;
    h[j * n + i] = 1.1 * fbm(x / 90 + 7, y / 90 + 3, 11, 4) + 0.35 * fbm(x / 20, y / 20, 29, 4) + 0.06 * fbm(x / 3.5, y / 3.5, 53, 3);
  }
  // population of small/medium craters (cumulative N(>D) ~ D^-2)
  for (let c = 0; c < 1100; c++) {
    const D = Math.min(28, 1.6 / Math.sqrt(1 - rng() * 0.995)), r = D / 2;
    stamp(h, n, cell, px((rng() - 0.5) * 2 * half * 1.05) / 1, px((rng() - 0.5) * 2 * half * 1.05), r, (0.09 + rng() * 0.09) * D, (0.012 * D + 0.03), 2.6);
  }
  for (const [, lat, lon, D, dep] of POLAR_CRATERS) {
    const [x, y] = polarXY(lat, lon);
    stamp(h, n, cell, px(x), px(y), D / 2, dep, 0.012 * D + 0.09, 3);
  }
  // Malapert massif (~5 km), Leibnitz-beta-like plateau, and the Shackleton–de Gerlache connecting ridge
  const mm = polarXY(-85.9, 2), lp = polarXY(-85.4, -33);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = (i + 0.5) * cell - half, y = (j + 0.5) * cell - half;
    h[j * n + i] += 4.6 * Math.exp(-((x - mm[0]) ** 2 + (y - mm[1]) ** 2) / (2 * 11 * 11)) + 2.4 * Math.exp(-((x - lp[0]) ** 2 + (y - lp[1]) ** 2) / (2 * 22 * 22));
    // ridge: segment (0,0)->(-45,2)
    const t = Math.min(1, Math.max(0, (x * -45 + y * 2) / (45 * 45 + 4))), rx = -45 * t, ry = 2 * t;
    h[j * n + i] += 1.5 * Math.exp(-((x - rx) ** 2 + (y - ry) ** 2) / (2 * 2.2 * 2.2)) * (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, t * 1.15)));
  }
  return new Dem(h, n, cell, 'polar');
}

/** Regional (flat-grid) DEM around a non-polar site: 102 km at 400 m. rough: 0.2 mare ... 1 highland. */
export function buildRegionalDem(lat, lon, rough = 0.5) {
  const n = 256, cell = 0.4, h = new Float32Array(n * n), seed = (Math.floor((lat + 90) * 100) * 7919 + Math.floor((lon + 180) * 100) * 104729) | 0, rng = mulberry32(seed);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = i * cell, y = j * cell;
    h[j * n + i] = rough * (0.9 * fbm(x / 30, y / 30, seed, 4) + 0.25 * fbm(x / 6, y / 6, seed + 9, 3) + 0.04 * fbm(x / 1.2, y / 1.2, seed + 4, 2));
  }
  const nc = 40 + Math.floor(rough * 200);
  for (let c = 0; c < nc; c++) {
    const D = Math.min(18, 0.9 / Math.sqrt(1 - rng() * 0.995)), r = D / 2;
    stamp(h, n, cell, rng() * n * cell, rng() * n * cell, r, (0.1 + rng() * 0.08) * D, 0.012 * D + 0.01, 2.6);
  }
  return new Dem(h, n, cell, 'flat');
}

/** High-resolution local patch (metres) around a site for the 3D surface view. */
export function buildPatch(dem, siteLat, siteLon, rough, n = 641, sizeM = 20000, local = null) {
  const polar = dem.kind === 'polar';
  const [sx, sy] = polar ? polarXY(siteLat, siteLon) : [dem.n * dem.cell / 2, dem.n * dem.cell / 2];
  const ax = dem.axes(polar ? sx : 0, polar ? sy : 0);
  const gx = (e, nn) => (polar ? sx : sx) + e * ax.Ex + nn * ax.Nx, gy = (e, nn) => sy + e * ax.Ey + nn * ax.Ny;
  // a real high-resolution local DEM (east/north grid centred on the site, heights in km) replaces the coarse regional one inside the patch
  const demH = local ? (e, nn) => bilinear(local.h, local.n, e / local.cell + local.n / 2 - 0.5, nn / local.cell + local.n / 2 - 0.5)
    : (e, nn) => polar ? dem.height(gx(e, nn), gy(e, nn)) : bilinear(dem.h, dem.n, gx(e, nn) / dem.cell, gy(e, nn) / dem.cell);
  const hh = new Float32Array(n * n), step = sizeM / (n - 1), seed = (Math.floor((siteLat + 90) * 131) + Math.floor((siteLon + 180) * 71)) | 0;
  const h0 = demH(0, 0);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const e = (i * step - sizeM / 2) / 1000, nn = (j * step - sizeM / 2) / 1000;
    const x = i * step, y = j * step;
    hh[j * n + i] = (demH(e, nn) - h0) * 1000 + (local ? 0 : (dem.real ? 6 : 22) * rough * fbm(x / 900, y / 900, seed, 4)) + (local ? 0.35 : dem.real ? 0.8 : 1.0) * rough * fbm(x / (local ? 45 : 160), y / (local ? 45 : 160), seed + 5, 3);
  }
  const rng = mulberry32(seed ^ 0x9e3779b9);
  for (let c = 0; c < (local ? 0 : 260); c++) {   // invented craters only where there is no real high-resolution terrain
    const D = Math.min(1800, 240 / Math.sqrt(1 - rng() * 0.995)), r = D / 2;
    const cx = rng() * sizeM, cy = rng() * sizeM;
    if (Math.hypot(cx - sizeM / 2, cy - sizeM / 2) < r + 45) continue; // keep the landing zone clear
    stamp(hh, n, step, cx, cy, r, (0.13 + rng() * 0.07) * D, 0.03 * D, 2.4);
  }
  const taper = (local ? 1400 : 2600) / step; // ease the heights to zero at the tile edge so it blends into the surrounding plain
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const d = Math.min(i, j, n - 1 - i, n - 1 - j) / taper, w = d >= 1 ? 1 : d * d * (3 - 2 * d); hh[j * n + i] *= w; }
  const at = (e, nn) => bilinear(hh, n, e / step + (n - 1) / 2, nn / step + (n - 1) / 2);
  const slopeDeg = (e, nn, d = 12) => {
    const gxs = (at(e + d, nn) - at(e - d, nn)) / (2 * d), gys = (at(e, nn + d) - at(e, nn - d)) / (2 * d);
    return Math.atan(Math.hypot(gxs, gys)) / D2R;
  };
  return { h: hh, n, sizeM, step, at, slopeDeg, h0km: h0, real: !!local, src: local ? `${local.source}, ${local.res_m} m` : (dem.real ? 'LOLA, coarse grid plus generated detail' : 'generated') };
}

// ---- terrain registry ----
let polarDem = null, realPolar = null, realSites = null; const regional = new Map();
/** Real NASA LOLA elevation: south-polar cap (+-200 km, 384x384) and 208x208 (0.5 km) crops around each curated mid-latitude site, resampled from LDEM_64 (64 px/deg). */
export async function loadRealDems() {
  try {
    const [pb, sb, sj] = await Promise.all([fetch('tex/polar_dem.bin').then((r) => r.arrayBuffer()), fetch('tex/site_dems.bin').then((r) => r.arrayBuffer()), fetch('tex/site_dems.json').then((r) => r.json())]);
    const p = new Int16Array(pb), h = new Float32Array(p.length); for (let i = 0; i < p.length; i++) h[i] = p[i] * 0.0005;
    realPolar = new Dem(h, 384, 400 / 384, 'polar'); realPolar.real = true; realSites = { meta: sj, all: new Int16Array(sb) };
  } catch (e) { console.warn('Real LOLA grids unavailable, using generated terrain', e); }
}
export function getPolarDem(onTick) { return polarDem || (polarDem = realPolar || buildPolarDem(384, 200, onTick)); }
export function terrainFor(site) {
  if (site.lat < -83.6) return getPolarDem();
  const key = `${site.lat.toFixed(2)},${site.lon.toFixed(2)}`, ri = realSites ? realSites.meta.ids.indexOf(site.id) : -1;
  if (ri >= 0 && !regional.has(key)) { const { n } = realSites.meta, cell = realSites.meta.cells ? realSites.meta.cells[ri] : realSites.meta.cell, o = ri * n * n, h = new Float32Array(n * n); for (let i = 0; i < n * n; i++) h[i] = realSites.all[o + i] * 0.0005; const d = new Dem(h, n, cell, 'flat'); d.real = true; regional.set(key, d); }
  if (!regional.has(key)) { if (regional.size > 24) regional.delete(regional.keys().next().value); regional.set(key, buildRegionalDem(site.lat, site.lon, site.rough ?? 0.5)); }
  return regional.get(key);
}
export function siteXY(dem, site) {
  return dem.kind === 'polar' ? polarXY(site.lat, site.lon) : [dem.n * dem.cell / 2, dem.n * dem.cell / 2];
}
export function siteHorizon(site) {
  const dem = terrainFor(site), [x, y] = siteXY(dem, site);
  // flat DEMs index from a corner; shift into centred km coordinates
  const cx = dem.kind === 'polar' ? x : x - dem.n * dem.cell / 2, cy = dem.kind === 'polar' ? y : y - dem.n * dem.cell / 2;
  return { dem, profile: dem.horizon(cx, cy, 180), x: cx, y: cy };
}

/** lat/lon of a point eKm east / nKm north of a site (grid-aware near the pole). */
export function offsetLL(site, eKm, nKm) {
  if (site.lat < -83.6) { const [sx, sy] = polarXY(site.lat, site.lon), l = Math.atan2(sx, sy); return polarLL(sx + eKm * Math.cos(l) + nKm * Math.sin(l), sy - eKm * Math.sin(l) + nKm * Math.cos(l)); }
  return [site.lat + nKm / RM / D2R, site.lon + eKm / (RM * Math.cos(site.lat * D2R)) / D2R];
}

/** True when real LOLA terrain exists for the site (south polar cap or one of the curated 104 km crops). */
export function hasRealTerrain(site) {
  if (site.lat < -83.6) return !!realPolar;
  return !!(realSites && site.id && realSites.meta.ids.includes(site.id));
}

// ------------------------------------------------------------------ high-resolution local DEMs (24 km windows cut from the LOLA grids by tools/lola_local.py)
let localMeta = null; const localDems = new Map();
const localKey = (site) => (site.id && site.id !== 'custom' ? site.id : `c:${site.lat.toFixed(3)},${site.lon.toFixed(3)}`);
export async function loadLocalMeta() { try { localMeta = await (await fetch('tex/local_dems.json')).json(); } catch (e) { console.warn('local DEM index unavailable', e); } }
export const localDemFor = (site) => localDems.get(localKey(site)) || null;
const toDem = (buf, m) => { const d = new Int16Array(buf), h = new Float32Array(d.length); for (let i = 0; i < d.length; i++) h[i] = d[i] * 0.0005; return { h, n: m.n, cell: m.cell, source: m.source, res_m: m.res_m }; };
// ------------------------------------------------------------------ global LOLA tiles (static, any coordinate on the Moon)
// tex/global holds NASA LOLA LDEM_128 (128 px/deg, 237 m) as 4x4 degree gzip tiles (built by tools/make_global_tiles.py), so every
// lat/lon has real elevation even on a static host. Sharper data (shipped sites, localhost cutter) is preferred when it exists.
let gIndex = null; const gTiles = new Map();
async function gunzip(buf) {
  const ds = new DecompressionStream('gzip'), w = ds.writable.getWriter(); w.write(buf); w.close();
  return new Response(ds.readable).arrayBuffer();
}
function gTile(r, c) {
  const k = r * 1000 + c; if (gTiles.has(k)) return gTiles.get(k);
  const p = fetch(`tex/global/t_${r}_${c}.bin.gz`).then(async (res) => {
    if (!res.ok) throw new Error('tile ' + r + '_' + c);
    const a = new Int16Array(await gunzip(await res.arrayBuffer())), n = gIndex.n;
    for (let j = 0; j < n; j++) { let acc = 0; for (let i = 0; i < n; i++) { acc = (acc + a[j * n + i]) << 16 >> 16; a[j * n + i] = acc; } }   // undo the column delta (int16 wrap)
    return a;
  });
  gTiles.set(k, p); p.catch(() => gTiles.delete(k)); return p;
}
/** Elevation (km) at lat/lon arrays from the global tiles; cubic = Catmull-Rom (smooth when upsampling), otherwise bilinear. */
async function globalSample(lats, lons, cubic) {
  if (!gIndex) gIndex = await (await fetch('tex/global/index.json')).json();
  const { ppd: P, tile_deg: T, n: TN, rows, cols, scale } = gIndex, TP = T * P, H = 180 * P, W = 360 * P, N = lats.length;
  const fr = new Float64Array(N), fc = new Float64Array(N), need = new Set(), m = cubic ? 2 : 1;
  for (let k = 0; k < N; k++) {
    fr[k] = (90 - Math.max(-89.999, Math.min(89.999, lats[k]))) * P - 0.5; fc[k] = ((((lons[k] % 360) + 360) % 360)) * P - 0.5;
    const r0 = Math.floor(fr[k]), c0 = Math.floor(fc[k]);
    for (const [R, C] of [[r0 - m + 1, c0 - m + 1], [r0 + m, c0 + m], [r0 - m + 1, c0 + m], [r0 + m, c0 - m + 1]]) need.add(Math.min(rows - 1, Math.max(0, Math.floor(Math.min(H - 1, Math.max(0, R)) / TP))) * 1000 + Math.floor((((C % W) + W) % W) / TP));
  }
  const tl = new Map(await Promise.all([...need].map(async (k) => [k, await gTile(Math.floor(k / 1000), k % 1000)])));
  let lastK = -1, lastT = null;
  const px = (R, C) => {
    R = R < 0 ? 0 : R > H - 1 ? H - 1 : R; C = ((C % W) + W) % W;
    const tr = Math.floor(R / TP), tc = Math.floor(C / TP), k = tr * 1000 + tc; if (k !== lastK) { lastK = k; lastT = tl.get(k); if (!lastT) lastT = gTile(tr, tc); }
    return lastT[(R - tr * TP) * TN + (C - tc * TP)];
  };
  const cr = (t, a, b, c, d) => b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
  const out = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const r0 = Math.floor(fr[k]), c0 = Math.floor(fc[k]), ty = fr[k] - r0, tx = fc[k] - c0;
    if (!cubic) { out[k] = ((px(r0, c0) * (1 - tx) + px(r0, c0 + 1) * tx) * (1 - ty) + (px(r0 + 1, c0) * (1 - tx) + px(r0 + 1, c0 + 1) * tx) * ty) * scale; continue; }
    const rr = [0, 0, 0, 0]; for (let j = 0; j < 4; j++) { const R = r0 - 1 + j; rr[j] = cr(tx, px(R, c0 - 1), px(R, c0), px(R, c0 + 1), px(R, c0 + 2)); }
    out[k] = cr(ty, rr[0], rr[1], rr[2], rr[3]) * scale;
  }
  return out;
}
/** east/north grid centred on a site (heights as km above the 1737.4 km sphere), same convention as tools/lola_local.py */
async function globalWindow(lat0, lon0, halfKm, cellKm, exact) {
  const n = Math.round(2 * halfKm / cellKm), lat = new Float64Array(n * n), lon = new Float64Array(n * n), p0 = lat0 * D2R;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const X = (i + 0.5 - n / 2) * cellKm, Y = (j + 0.5 - n / 2) * cellKm, q = j * n + i;
    if (!exact) { lat[q] = lat0 + Y / RM / D2R; lon[q] = lon0 + X / (RM * Math.cos(p0)) / D2R; continue; }
    const d = Math.hypot(X, Y) / RM, th = Math.atan2(X, Y), la = Math.asin(Math.sin(p0) * Math.cos(d) + Math.cos(p0) * Math.sin(d) * Math.cos(th));
    lat[q] = la / D2R; lon[q] = lon0 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p0), Math.cos(d) - Math.sin(p0) * Math.sin(la)) / D2R;
  }
  return { n, h: await globalSample(lat, lon, exact) };
}
/** Fetches the sharpest real terrain for the site: shipped file (curated sites) > dev server's on-demand LOLA cutter (localhost) > global LOLA tiles (everywhere, static). Resolves true when a new DEM arrived. */
export async function ensureLocalDem(site) {
  const key = localKey(site); if (localDems.has(key)) return false;
  try {
    if (localMeta && localMeta[site.id]) { const m = localMeta[site.id], b = await (await fetch(`tex/local/${site.id}.bin`)).arrayBuffer(); localDems.set(key, toDem(b, m)); return true; }
  } catch (e) { /* fall through */ }
  try {
    const r = await fetch(`/api/dem?kind=local&lat=${site.lat.toFixed(4)}&lon=${site.lon.toFixed(4)}`);
    if (r.ok && r.headers.get('X-Dem-Meta')) { localDems.set(key, toDem(await r.arrayBuffer(), JSON.parse(r.headers.get('X-Dem-Meta')))); return true; }
  } catch (e) { /* static host: no cutter */ }
  try {
    const w = await globalWindow(site.lat, site.lon, 12, 0.06, true);
    localDems.set(key, { h: w.h, n: w.n, cell: 0.06, source: 'LOLA LDEM_128 (global)', res_m: 237 }); return true;
  } catch (e) { return false; }
}
/** Replaces a generated regional DEM (custom spot) with a real 104 km LOLA window. Resolves true on success. */
export async function ensureRegionalDem(site) {
  if (hasRealTerrain(site)) return false; const key = `${site.lat.toFixed(2)},${site.lon.toFixed(2)}`; if (realRegional.has(key)) return false;
  const put = (q) => { const d = new Dem(q.h, q.n, q.cell, 'flat'); d.real = true; regional.set(key, d); realRegional.add(key); return true; };
  try {
    const r = await fetch(`/api/dem?kind=regional&lat=${site.lat.toFixed(4)}&lon=${site.lon.toFixed(4)}`);
    if (r.ok && r.headers.get('X-Dem-Meta')) return put(toDem(await r.arrayBuffer(), JSON.parse(r.headers.get('X-Dem-Meta'))));
  } catch (e) { /* static host */ }
  try { const w = await globalWindow(site.lat, site.lon, 52, 0.5, false); return put({ h: w.h, n: w.n, cell: 0.5 }); } catch (e) { return false; }
}
const realRegional = new Set();
export const regionalIsReal = (site) => realRegional.has(`${site.lat.toFixed(2)},${site.lon.toFixed(2)}`);
export const localIds = () => (localMeta ? Object.keys(localMeta) : []);
