// Small 2D visualisations: lunar-day curves, sky dome, time strip, polar illumination map.
import { D2R, SYNODIC, state, siteBasis, msOf } from './ephemeris.js';
import { SERIES, STEP, horizonAt } from './analysis.js';
import { polarXY, polarLL } from './terrain.js';
import { bilinear, rayClear, pixelGeometry, localDirAtPixel } from './shadow.js';

export const COL = { sun: '#ffd166', earth: '#4cc9f0', ok: '#80ffb0', bad: '#ef476f', ink: 'rgba(255,255,255,.82)', dim: 'rgba(255,255,255,.32)' };
const SUN_RAD = 0.2666 * D2R;

export function setupCanvas(c) {
  const dpr = Math.min(2, window.devicePixelRatio || 1), w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h); return { g, w, h };
}

/** Sun & Earth elevation over the lunar day around `jd`. */
export function drawCurves(c, A, jd, researcher, hover = null) {
  const { g, w, h } = setupCanvas(c), back = 3, span = 31, i0 = Math.round(SERIES.index(jd - back)), n = Math.round(span / STEP);
  const L = 46, R = 8, T = 22, B = 48, pw = w - L - R, ph = h - T - B, x = (k) => L + (k / n) * pw;
  let hi = 5, lo = -5; for (let k = 0; k < n; k++) { hi = Math.max(hi, A.sunEl[i0 + k], A.earthEl[i0 + k]); lo = Math.min(lo, A.sunEl[i0 + k], A.earthEl[i0 + k]); }
  const stepV = [5, 10, 15, 20, 30, 45].find((s) => (hi - lo) / s <= 5) || 45; hi = Math.ceil(hi * 1.08 / stepV) * stepV; lo = Math.floor(lo * 1.08 / stepV) * stepV;
  const y = (el) => T + (1 - (el - lo) / (hi - lo)) * ph, y0 = y(0);
  // grid and axis labels
  g.font = '10px Inter, system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let v = Math.ceil(lo / stepV) * stepV; v <= hi; v += stepV) { g.strokeStyle = v === 0 ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.09)'; g.lineWidth = v === 0 ? 1.4 : 1; g.beginPath(); g.moveTo(L, y(v)); g.lineTo(w - R, y(v)); g.stroke(); g.fillStyle = v === 0 ? '#fff' : COL.dim; g.fillText(v + '°', L - 5, y(v)); }
  g.save(); g.translate(9, T + ph / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.fillStyle = COL.dim; g.fillText('Elevation above horizon', 0, 0); g.restore();
  // x ticks: dates every 5 days
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  for (let d = Math.ceil(jd - back); d <= jd - back + span; d += 5) { const px = L + ((d - (jd - back)) / span) * pw, dt = new Date(msOf(d)); g.strokeStyle = 'rgba(255,255,255,.07)'; g.beginPath(); g.moveTo(px, T); g.lineTo(px, T + ph); g.stroke(); g.fillStyle = COL.dim; g.fillText(dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }), px, T + ph + 26); }
  // visible-window fills (above the local terrain horizon), like an in-transit window
  const fillVis = (arrM, arrEl, col) => {
    g.fillStyle = col; let k = 0;
    while (k < n) { if (arrM[i0 + k] > 0) { let k2 = k; while (k2 < n && arrM[i0 + k2] > 0) k2++; g.beginPath(); g.moveTo(x(k), y0); for (let q = k; q < k2; q++) g.lineTo(x(q), y(Math.max(0, arrEl[i0 + q]))); g.lineTo(x(k2 - 1), y0); g.closePath(); g.fill(); k = k2; } else k++; }
  };
  fillVis(A.sunM, A.sunEl, 'rgba(255,209,102,.20)'); fillVis(A.earthM, A.earthEl, 'rgba(76,201,240,.16)');
  const line = (arr, mar, col) => { // solid while visible, faint while hidden
    for (let k = 1; k < n; k++) { g.beginPath(); g.moveTo(x(k - 1), y(arr[i0 + k - 1])); g.lineTo(x(k), y(arr[i0 + k])); g.strokeStyle = col; g.globalAlpha = mar[i0 + k] > 0 ? 1 : 0.28; g.lineWidth = mar[i0 + k] > 0 ? 2.2 : 1.4; g.stroke(); }
    g.globalAlpha = 1;
  };
  line(A.earthEl, A.earthM, COL.earth); line(A.sunEl, A.sunM, COL.sun);
  // "both up" band under the plot
  const by = T + ph + 4, bh = 6; g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(L, by, pw, bh);
  for (let k = 0; k < n; k++) if (A.sunM[i0 + k] > 0 && A.earthM[i0 + k] > 0) { g.fillStyle = COL.ok; g.fillRect(x(k), by, pw / n + 0.6, bh); }
  let anyEcl = false; for (let k = 0; k < n; k++) if (A.sunM[i0 + k] > 0 && A.ecl[i0 + k] > 0.002) { g.fillStyle = 'rgba(255,255,255,.9)'; g.fillRect(x(k), by + bh + 3, pw / n + 0.6, 4); anyEcl = true; }
  g.textAlign = 'left'; g.fillStyle = 'rgba(255,255,255,.7)'; g.fillText('Both up', L, by + bh + 26); if (anyEcl) g.fillText('Earth eclipse of the Sun (white)', L + 62, by + bh + 26);
  // events: horizon crossings (small ticks only, no text)
  const ev = (arrM, col) => { for (let k = 1; k < n; k++) { const a = arrM[i0 + k - 1] > 0, b = arrM[i0 + k] > 0; if (a !== b) { const px = x(k); g.strokeStyle = col; g.globalAlpha = 0.9; g.lineWidth = 1; g.beginPath(); g.moveTo(px, y0 - 5); g.lineTo(px, y0 + 5); g.stroke(); g.globalAlpha = 1; } } };
  ev(A.sunM, COL.sun); ev(A.earthM, COL.earth);
  // now line
  const nx = L + (back / span) * pw; g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(nx, T - 4); g.lineTo(nx, T + ph); g.stroke();
  g.font = '700 10px Inter, system-ui, sans-serif'; g.fillStyle = '#fff'; g.textAlign = nx > w - 40 ? 'right' : 'left'; g.fillText('NOW', nx + (nx > w - 40 ? -4 : 4), 12);
  // hover readout
  if (hover != null && hover >= L && hover <= w - R) {
    const k = Math.max(0, Math.min(n - 1, Math.round(((hover - L) / pw) * n))), px = x(k), j = jd - back + (k * STEP), dt = new Date(msOf(j));
    g.strokeStyle = 'rgba(255,255,255,.6)'; g.lineWidth = 1; g.beginPath(); g.moveTo(px, T); g.lineTo(px, T + ph); g.stroke();
    for (const [arr, col] of [[A.sunEl, COL.sun], [A.earthEl, COL.earth]]) { g.beginPath(); g.arc(px, y(arr[i0 + k]), 3.5, 0, 7); g.fillStyle = col; g.fill(); }
    const tx = dt.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC', l1 = 'Sun ' + A.sunEl[i0 + k].toFixed(1) + '°' + (A.sunM[i0 + k] > 0 ? '' : ' hidden'), l2 = 'Earth ' + A.earthEl[i0 + k].toFixed(1) + '°' + (A.earthM[i0 + k] > 0 ? '' : ' hidden');
    g.font = '600 10px Inter, system-ui, sans-serif'; const bw = Math.max(g.measureText(tx).width, g.measureText(l1).width, g.measureText(l2).width) + 14, bx = px + 10 + bw > w ? px - bw - 10 : px + 10;
    g.fillStyle = 'rgba(8,12,28,.92)'; g.fillRect(bx, T + 4, bw, 44); g.strokeStyle = 'rgba(255,255,255,.25)'; g.strokeRect(bx, T + 4, bw, 44); g.textAlign = 'left'; g.fillStyle = '#fff'; g.fillText(tx, bx + 7, T + 17); g.fillStyle = '#fff'; g.fillText(l1, bx + 7, T + 30); g.fillText(l2, bx + 7, T + 42);
  }
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
}

/** Fisheye sky: centre = zenith, rim = horizon. Terrain silhouette, Sun/Earth tracks, current positions. */
export function drawSky(c, A, sky, track, opts = {}) {
  const { g, w, h } = setupCanvas(c), cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - (opts.mini ? 8 : 16);
  const rad = (el) => R * (1 - Math.sqrt(Math.max(0, el) / (Math.PI / 2)));
  const P = (az, el) => [cx + Math.sin(az) * rad(el), cy - Math.cos(az) * rad(el)];
  const bg = g.createRadialGradient(cx, cy, 0, cx, cy, R); bg.addColorStop(0, '#0b1230'); bg.addColorStop(1, '#03050f');
  g.fillStyle = bg; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1;
  for (const el of [10, 30, 60]) { g.beginPath(); g.arc(cx, cy, rad(el * D2R), 0, 7); g.stroke(); }
  // tracks
  const tr = (key, col) => { g.beginPath(); let pen = false; for (const p of track) { const a = p[key]; if (a.el < -0.02) { pen = false; continue; } const [x, y] = P(a.az, a.el); pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true; } g.strokeStyle = col; g.lineWidth = opts.mini ? 1.4 : 2; g.setLineDash([2, 3]); g.stroke(); g.setLineDash([]); };
  tr('earth', COL.earth); tr('sun', COL.sun);
  // terrain silhouette
  const prof = A.hz.profile, n = prof.length;
  g.save(); g.beginPath(); g.arc(cx, cy, R, 0, 7); g.clip();
  g.beginPath(); for (let i = 0; i < n; i++) { const az = (i / n) * 2 * Math.PI, e = Math.max(0, prof[i]); const [x, y] = P(az, e); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.closePath();
  g.moveTo(cx + R * 2, cy); g.arc(cx, cy, R * 2, 0, 7); g.fillStyle = '#1b1d26'; g.fill('evenodd'); g.restore();
  g.beginPath(); for (let i = 0; i <= n; i++) { const az = (i / n) * 2 * Math.PI, e = Math.max(0, prof[i % n]); const [x, y] = P(az, e); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1.2; g.stroke();
  g.strokeStyle = 'rgba(255,255,255,.25)'; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.stroke();
  if (!opts.mini) { g.fillStyle = COL.dim; g.font = '600 10px Inter, system-ui'; g.textAlign = 'center'; g.fillText('N', cx, cy - R - 4); g.fillText('S', cx, cy + R + 11); g.fillText('E', cx + R + 8, cy + 3); g.fillText('W', cx - R - 9, cy + 3); }
  // bodies
  const body = (b, col, r, glyph) => {
    const [x, y] = P(b.az, Math.max(b.el, 0)); const vis = b.el > b.hz;
    g.beginPath(); g.arc(x, y, vis ? r : r * 0.8, 0, 7); g.fillStyle = vis ? col : 'transparent'; g.strokeStyle = col; g.lineWidth = 2; if (vis) { g.shadowColor = col; g.shadowBlur = 12; g.fill(); g.shadowBlur = 0; } g.stroke();
    if (!opts.mini && b.el > -0.05) { g.fillStyle = '#fff'; g.font = '11px system-ui'; g.fillText(glyph, x + r + 8, y - r); }
  };
  body(sky.sun, COL.sun, opts.mini ? 4 : 6, 'Sun'); body(sky.earth, COL.earth, opts.mini ? 3.5 : 5, 'Earth');
}

/** 60-day strip: top row Sun, bottom row Earth; return mapping helpers for clicks. */
export function drawStrip(c, A, jd, startJd, days) {
  const { g, w, h } = setupCanvas(c), n = Math.round(days / STEP), i0 = Math.round(SERIES.index(startJd)), bw = w / n;
  const rh = (h - 12) / 3;
  const row = (arr, y, a, b) => { for (let k = 0; k < n; k++) { const v = arr[i0 + k]; g.fillStyle = v > 0 ? a : b; g.fillRect(k * bw, y, bw + 0.6, rh - 1); } };
  row(A.sunM, 0, 'rgba(255,209,102,.9)', 'rgba(255,255,255,.07)');
  row(A.earthM, rh, 'rgba(76,201,240,.9)', 'rgba(255,255,255,.07)');
  for (let k = 0; k < n; k++) { const both = A.sunM[i0 + k] > 0 && A.earthM[i0 + k] > 0; g.fillStyle = both ? 'rgba(128,255,176,.95)' : 'rgba(255,255,255,.07)'; g.fillRect(k * bw, rh * 2, bw + 0.6, rh - 1); }
  const nx = ((jd - startJd) / days) * w; g.fillStyle = '#fff'; g.fillRect(nx - 1, 0, 2, h - 10);
  g.beginPath(); g.moveTo(nx - 5, h - 10); g.lineTo(nx + 5, h - 10); g.lineTo(nx, h - 3); g.fill();
}

// ---------- polar map ----------
const STOPS = [[0, [53, 42, 135]], [0.2, [15, 92, 221]], [0.4, [18, 125, 216]], [0.55, [7, 156, 207]], [0.7, [21, 177, 180]], [0.85, [89, 189, 140]], [1, [249, 251, 14]]];
export function parula(v) {
  v = Math.max(0, Math.min(1, v));
  for (let i = 1; i < STOPS.length; i++) if (v <= STOPS[i][0]) { const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i], t = (v - a) / (b - a); return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t]; }
  return STOPS[STOPS.length - 1][1];
}

export class PolarMap {
  constructor(dem, flat = null) {
    this.dem = dem; this.flat = flat; this.stride = 2; this.m = Math.floor(dem.n / 2); this.half = (dem.n * dem.cell) / 2;
    const { h, n } = dem, m = this.m, hs = (this.hs = new Float32Array(m * m));
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
      const fx = i * 2 + 0.5, fy = j * 2 + 0.5, dx = bilinear(h, n, fx + 2, fy) - bilinear(h, n, fx - 2, fy), dy = bilinear(h, n, fx, fy + 2) - bilinear(h, n, fx, fy - 2);
      hs[j * m + i] = Math.max(0.55, Math.min(1.35, 1 + (dx * -0.5 + dy * 0.5) * 0.55));
    }
    this.avg = null; this.now = { lit: new Uint8Array(m * m), earth: new Uint8Array(m * m) };
    this.geo = new Array(m * m); for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) this.geo[j * m + i] = pixelGeometry(n, dem.cell, i * 2 + 0.5, j * 2 + 0.5, flat);
    this.off = document.createElement('canvas'); this.off.width = this.off.height = m; this.tex = null; this.mode = 'sun';
  }
  setAverage(a) { this.avg = a; this._tc = null; }
  proj(lat, lon) { if (!this.flat) return polarXY(lat, lon); const l0 = this.flat.lat0 * D2R; return [(lon - this.flat.lon0) * D2R * 1737.4 * Math.cos(l0), (lat - this.flat.lat0) * D2R * 1737.4]; }
  unproj(x, y) { if (!this.flat) return polarLL(x, y); const l0 = this.flat.lat0 * D2R; return [this.flat.lat0 + y / 1737.4 / D2R, this.flat.lon0 + x / (1737.4 * Math.cos(l0)) / D2R]; }
  inside(x, y) { return Math.abs(x) < this.half * 0.97 && Math.abs(y) < this.half * 0.97; }
  computeNow(sunBody, earthBody, sunRad = SUN_RAD) {
    const { h, n, cell, hmax } = this.dem, m = this.m, maxKm = n * cell * 0.8, L = this.now.lit, E = this.now.earth;
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
      const g = this.geo[j * m + i], fx = i * 2 + 0.5, fy = j * 2 + 0.5, h0 = bilinear(h, n, fx, fy);
      const s = localDirAtPixel(g, sunBody), e = localDirAtPixel(g, earthBody), o = j * m + i;
      L[o] = s[0] + sunRad > -0.002 && rayClear(h, n, cell, hmax, fx, fy, h0, s[1], s[2], Math.tan(s[0] + sunRad), maxKm) ? 1 : 0;
      E[o] = e[0] > 0 && rayClear(h, n, cell, hmax, fx, fy, h0, e[1], e[2], Math.tan(e[0]), maxKm) ? 1 : 0;
    }
  }
  paint(mode) {
    this.mode = mode; this.range = null; let rng = null;
    if (this.flat && this.avg && mode !== 'now') { const a = this.avg[mode === 'sun' || mode === 'earth' ? mode : 'both'], s = Float32Array.from(a).sort(), lo = s[Math.floor(s.length * 0.02)], hi = s[Math.floor(s.length * 0.98)]; const mid = (lo + hi) / 2, half = Math.max((hi - lo) / 2, 0.15); rng = [Math.max(0, mid - half), Math.min(1, mid + half)]; if (rng[1] - rng[0] < 0.3) rng = rng[0] <= 0 ? [0, 0.3] : [0.7, 1]; this.range = rng; }
    const m = this.m, g = this.off.getContext('2d'), img = g.createImageData(m, m), d = img.data;
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
      const o = j * m + i, p = ((m - 1 - j) * m + i) * 4, shade = this.hs[o]; let c;
      if (mode === 'now') {
        const l = this.now.lit[o], e = this.now.earth[o];
        c = l && e ? [70, 235, 130] : l ? [255, 209, 102] : e ? [76, 190, 240] : [14, 18, 52];
      } else if (this.avg) { const v = mode === 'sun' ? this.avg.sun[o] : mode === 'earth' ? this.avg.earth[o] : this.avg.both[o]; c = parula(rng ? (v - rng[0]) / (rng[1] - rng[0]) : v); }
      else c = [30, 40, 90];
      d[p] = Math.min(255, c[0] * shade * (mode === 'now' ? 1 : 0.9 + 0.1 * shade)); d[p + 1] = Math.min(255, c[1] * shade); d[p + 2] = Math.min(255, c[2] * shade); d[p + 3] = 255;
    }
    g.putImageData(img, 0, 0); return this.off;
  }
  top(mode, k = 5) {
    if (!this.avg) return [];
    const ck = (mode === 'sun' || mode === 'earth' ? mode : 'both') + k; this._tc = this._tc || {}; if (this._tc.avg !== this.avg) this._tc = { avg: this.avg }; if (this._tc[ck]) return this._tc[ck];
    const a = this.avg[mode === 'sun' || mode === 'earth' ? mode : 'both'], m = this.m, step = (2 * this.half) / m, out = [];
    const cand = []; for (let o = 0; o < m * m; o++) { const i = o % m, j = (o / m) | 0, x = (i + 0.5) * step - this.half, y = (j + 0.5) * step - this.half; if (Math.hypot(x, y) < this.half * 0.55) cand.push([a[o], x, y]); }
    cand.sort((p, q) => q[0] - p[0]);
    for (const [v, x, y] of cand) { if (out.every((t) => Math.hypot(t.x - x, t.y - y) > (this.flat ? 8 : 14))) out.push({ x, y, v }); if (out.length >= k) break; }
    this._tc[ck] = out; return out;
  }
  value(x, y) {
    const m = this.m, i = Math.floor(((x + this.half) / (2 * this.half)) * m), j = Math.floor(((y + this.half) / (2 * this.half)) * m);
    if (i < 0 || j < 0 || i >= m || j >= m || !this.avg) return null; const o = j * m + i;
    return { sun: this.avg.sun[o], earth: this.avg.earth[o], both: this.avg.both[o], nowSun: this.now.lit[o], nowEarth: this.now.earth[o] };
  }
  draw(c, extra = {}) {
    const { g, w, h } = setupCanvas(c), S = Math.min(w, h), ox = (w - S) / 2, oy = (h - S) / 2;
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(this.off, ox, oy, S, S);
    const kx = (x) => ox + ((x + this.half) / (2 * this.half)) * S, ky = (y) => oy + S - ((y + this.half) / (2 * this.half)) * S;
    g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 1.2; g.setLineDash([5, 4]);
    if (this.flat) { g.fillStyle = '#fff'; g.font = '600 10px Inter, system-ui'; const km = Math.round(this.half / 2.5), L = (km / (2 * this.half)) * S; g.setLineDash([]); g.lineWidth = 2; g.beginPath(); g.moveTo(ox + 10, oy + S - 12); g.lineTo(ox + 10 + L, oy + S - 12); g.stroke(); g.fillText(km + ' km', ox + 10, oy + S - 18); g.setLineDash([5, 4]); }
    else for (const [lat, lab] of [[-84, '84°S'], [-87, '87°S']]) { const r = (Math.hypot(...polarXY(lat, 0)) / (2 * this.half)) * S; g.beginPath(); g.arc(ox + S / 2, oy + S / 2, r, 0, 7); g.stroke(); g.fillStyle = '#fff'; g.font = '600 10px Inter, system-ui'; g.fillText(lab, ox + S / 2 + r * 0.7 + 3, oy + S / 2 - r * 0.7 - 3); }
    g.beginPath(); g.moveTo(ox, oy + S / 2); g.lineTo(ox + S, oy + S / 2); g.moveTo(ox + S / 2, oy); g.lineTo(ox + S / 2, oy + S); g.stroke(); g.setLineDash([]);
    for (const s of extra.sites || []) { const [x, y] = this.proj(s.lat, s.lon); if (!this.inside(x, y) || (!this.flat && s.lat > -83.4)) continue; g.beginPath(); g.arc(kx(x), ky(y), 3.2, 0, 7); g.fillStyle = 'rgba(255,255,255,.9)'; g.fill(); g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 1; g.stroke(); }
    (extra.pinned || []).forEach((s, i) => { const [x, y] = this.proj(s.lat, s.lon); if (!this.inside(x, y)) return; g.beginPath(); g.arc(kx(x), ky(y), 6, 0, 7); g.strokeStyle = ['#ff9f1c', '#2ec4b6', '#e71d36', '#9b5de5'][i % 4]; g.lineWidth = 2.5; g.stroke(); });
    if (extra.selected && this.inside(...this.proj(extra.selected.lat, extra.selected.lon))) {
      const [x, y] = this.proj(extra.selected.lat, extra.selected.lon), t = (performance.now() / 700) % 1;
      g.beginPath(); g.arc(kx(x), ky(y), 5 + t * 9, 0, 7); g.strokeStyle = `rgba(255,255,255,${1 - t})`; g.lineWidth = 2; g.stroke();
      g.beginPath(); g.arc(kx(x), ky(y), 5, 0, 7); g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1.5; g.stroke();
    }
    if (extra.best) { const X = kx(extra.best.x), Y = ky(extra.best.y); g.beginPath(); for (let k = 0; k < 10; k++) { const rr = k % 2 ? 5 : 12, a = -Math.PI / 2 + k * Math.PI / 5; g[k ? 'lineTo' : 'moveTo'](X + rr * Math.cos(a), Y + rr * Math.sin(a)); } g.closePath(); g.fillStyle = '#ffd166'; g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1.5; g.stroke(); g.fillStyle = '#fff'; g.font = '700 10px Inter, system-ui'; g.fillText('BEST', X + 13, Y + 3); }
    (extra.top || []).forEach((t, i) => { const X = kx(t.x), Y = ky(t.y); g.beginPath(); g.arc(X, Y, 8, 0, 7); g.fillStyle = 'rgba(255,209,102,.95)'; g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1.5; g.stroke(); g.fillStyle = '#000'; g.font = '700 10px Inter, system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(i + 1, X, Y + 0.5); g.textAlign = 'start'; g.textBaseline = 'alphabetic'; });
    if (extra.hover) { g.beginPath(); g.arc(kx(extra.hover.x), ky(extra.hover.y), 4, 0, 7); g.strokeStyle = '#fff'; g.stroke(); }
    this.geom = { ox, oy, S };
  }
  /** canvas px -> km coords + lat/lon */
  pick(c, px, py) {
    const r = c.getBoundingClientRect(), S = Math.min(r.width, r.height), ox = (r.width - S) / 2, oy = (r.height - S) / 2;
    const u = (px - r.left - ox) / S, v = (py - r.top - oy) / S; if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const x = (u - 0.5) * 2 * this.half, y = (0.5 - v) * 2 * this.half; return { x, y };
  }
  texture(THREE) {
    const c = document.createElement('canvas'); c.width = c.height = 512; const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.drawImage(this.off, 0, 0, 512, 512);
    if (!this.tex) { this.tex = new THREE.CanvasTexture(c); this.tex.colorSpace = THREE.SRGBColorSpace; this.texCanvas = c; this.tex.anisotropy = 8; } else { this.texCanvas.getContext('2d').drawImage(this.off, 0, 0, 512, 512); this.tex.needsUpdate = true; }
    return this.tex;
  }
}

/** Top-down landing-zone map: terrain shading, every simulated touchdown, 95% spread ellipse, best nearby alternates. */
export function drawLandingZone(cv, mc, patch, ext, sunAz, alts, hover) {
  const { g, w, h } = setupCanvas(cv), S = Math.min(w, h), ox = (w - S) / 2, oy = (h - S) / 2, key = ext + '|' + sunAz.toFixed(2) + '|' + Math.round(S);
  if (!cv._bg || cv._key !== key || cv._patch !== patch) {
    const R = 120, off = document.createElement('canvas'); off.width = off.height = R; const og = off.getContext('2d'), img = og.createImageData(R, R);
    const lx = Math.sin(sunAz), ly = Math.cos(sunAz), E = ext * 1000;
    for (let j = 0; j < R; j++) for (let i = 0; i < R; i++) {
      const e = ((i + 0.5) / R * 2 - 1) * E, n = (1 - (j + 0.5) / R * 2) * E, d = E / R * 0.9;
      const dx = (patch.at(e + d, n) - patch.at(e - d, n)) / (2 * d), dy = (patch.at(e, n + d) - patch.at(e, n - d)) / (2 * d);
      const sh = Math.max(0.12, Math.min(1.4, 0.62 + (dx * lx + dy * ly) * 2.2)), p = (j * R + i) * 4, v = 120 * sh;
      img.data[p] = v; img.data[p + 1] = v * 0.98; img.data[p + 2] = v * 0.92; img.data[p + 3] = 255;
    }
    og.putImageData(img, 0, 0); cv._bg = off; cv._key = key; cv._patch = patch;
  }
  g.imageSmoothingEnabled = true; g.drawImage(cv._bg, ox, oy, S, S);
  const kx = (km) => ox + (km / ext * 0.5 + 0.5) * S, ky = (km) => oy + (0.5 - km / ext * 0.5) * S;
  g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(ox, oy, S, S);
  const col = (t) => (t.ok ? '#4de8a6' : t.lit ? '#ff8c40' : '#ff4d73');
  for (const t of mc.trials) { g.fillStyle = col(t); g.globalAlpha = 0.7; g.fillRect(kx(t.e) - 1, ky(t.n) - 1, 2, 2); }
  g.globalAlpha = 1;
  // 95% spread ellipse (east 2σ, north 1.2σ)
  g.strokeStyle = 'rgba(255,255,255,.9)'; g.setLineDash([5, 4]); g.lineWidth = 1.5; g.beginPath(); g.ellipse(kx(0), ky(0), (2 * mc.sigma / ext * 0.5) * S, (1.2 * mc.sigma / ext * 0.5) * S, 0, 0, 7); g.stroke(); g.setLineDash([]);
  // target cross
  g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(kx(0) - 8, ky(0)); g.lineTo(kx(0) + 8, ky(0)); g.moveTo(kx(0), ky(0) - 8); g.lineTo(kx(0), ky(0) + 8); g.stroke();
  g.fillStyle = '#fff'; g.font = '700 10px Inter, system-ui'; g.fillText('TARGET', kx(0) + 10, ky(0) - 8);
  (alts || []).forEach((a, i) => {
    const X = kx(a.e), Y = ky(a.n); g.beginPath(); g.arc(X, Y, hover === i ? 11 : 9, 0, 7); g.fillStyle = '#ffd166'; g.fill(); g.strokeStyle = '#000'; g.lineWidth = 1.5; g.stroke();
    g.fillStyle = '#000'; g.font = '700 11px Inter, system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(i + 1, X, Y + 0.5); g.textAlign = 'start'; g.textBaseline = 'alphabetic';
  });
  const km = ext >= 4 ? 2 : ext >= 1.5 ? 1 : 0.5, L = (km / ext * 0.5) * S; g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.moveTo(ox + 10, oy + S - 12); g.lineTo(ox + 10 + L, oy + S - 12); g.stroke(); g.fillStyle = '#fff'; g.font = '600 10px Inter, system-ui'; g.fillText((km < 1 ? km * 1000 + ' m' : km + ' km'), ox + 10, oy + S - 17);
  cv._geom = { ox, oy, S, ext };
}
