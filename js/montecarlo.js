// Monte Carlo of landing descents: guidance dispersion at touchdown + schedule slip, judged against
// terrain slope, local shadow, and Sun/Earth availability during the first week on the surface.
import { skyNow, SERIES, STEP } from './analysis.js';

function randn(r) { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export function runMonteCarlo({ N = 3000, sigma = 0.5, slipHours = 6, A, jd, patch, cx = 0, cy = 0 }) {
  const r = rng(Math.floor(jd * 100) ^ 0x51ed), sky = skyNow(A, jd), az = sky.sun.az, dx = Math.sin(az), dn = Math.cos(az);
  const bins = new Map();
  const viability = (jdT) => {
    const key = Math.round((jdT - jd) * 12); if (bins.has(key)) return bins.get(key);
    const i0 = Math.max(0, Math.round(SERIES.index(jd + key / 12))), n = Math.min(SERIES.n - i0, Math.round(7 / STEP)); let both = 0, sun = 0, earth = 0;
    for (let k = 0; k < n; k++) { const s = A.sunM[i0 + k] > 0, e = A.earthM[i0 + k] > 0; if (s) sun++; if (e) earth++; if (s && e) both++; }
    const v = { both: both / n, sun: sun / n, earth: earth / n, ok: both / n >= 0.3 }; bins.set(key, v); return v;
  };
  const sunMarginAt = (jdT) => { const f = SERIES.index(jdT), i = Math.max(0, Math.min(SERIES.n - 2, Math.floor(f))); return A.sunM[i] * (1 - (f - i)) + A.sunM[i + 1] * (f - i); };
  const sunElAt = (jdT) => { const f = SERIES.index(jdT), i = Math.max(0, Math.min(SERIES.n - 2, Math.floor(f))); return (A.sunEl[i] * (1 - (f - i)) + A.sunEl[i + 1] * (f - i)) * Math.PI / 180; };
  const localLit = (e, nn, el) => {
    if (el <= 0) return false; const t = Math.tan(el), y0 = patch.at(e, nn) + 1.5;
    for (let s = 12; s < 9000; s *= 1.06) { const px = e + dx * s, pn = nn + dn * s; if (Math.abs(px) > 9900 || Math.abs(pn) > 9900) break; if (patch.at(px, pn) - s * s / 3474800 > y0 + s * t) return false; }
    return true;
  };
  const trials = []; let nOk = 0, nSlope = 0, nLit = 0, nVia = 0;
  const approachBase = Math.PI / 2;
  for (let i = 0; i < N; i++) {
    const aa = approachBase + randn(r) * 0.06, along = randn(r) * sigma, cross = randn(r) * sigma * 0.6;
    const e = cx + along * Math.sin(aa) + cross * Math.cos(aa), nn = cy + along * Math.cos(aa) - cross * Math.sin(aa);
    const em = Math.max(-9.8, Math.min(9.8, e)) * 1000, nm = Math.max(-9.8, Math.min(9.8, nn)) * 1000;
    const slope = patch.slopeDeg(em, nm), slopeOK = slope < 10;
    const jdT = jd + (randn(r) * slipHours) / 24, margin = sunMarginAt(jdT);
    const lit = margin > 0 && localLit(em, nm, sunElAt(jdT)), v = viability(jdT);
    const ok = slopeOK && lit && v.ok;
    if (ok) nOk++; if (slopeOK) nSlope++; if (lit) nLit++; if (v.ok) nVia++;
    trials.push({ e, n: nn, ok, lit, slope, range: 330 + randn(r) * 12, approachAz: aa });
  }
  return { N, sigma, slipHours, trials, pSuccess: nOk / N, pSlope: nSlope / N, pLit: nLit / N, pViable: nVia / N, nOk };
}

/** Half-width (km) of the landing-zone view: wide enough for the whole scatter. */
export const zoneExtent = (sigma) => Math.max(0.8, Math.min(9, sigma * 4.5));

/** Re-run a small Monte Carlo centred on a grid of nearby points; return the best 5, well separated. */
export function findAlternates({ sigma, slipHours, A, jd, patch, base }) {
  const ext = zoneExtent(sigma) * 0.85, G = 13, cells = [];
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const cx = ((i / (G - 1)) * 2 - 1) * ext, cy = ((j / (G - 1)) * 2 - 1) * ext;
    if (Math.hypot(cx, cy) < ext * 0.12 || Math.hypot(cx, cy) > ext) continue;
    const r = runMonteCarlo({ N: 140, sigma, slipHours, A, jd, patch, cx, cy });
    cells.push({ e: cx, n: cy, p: r.pSuccess, q: r.pSuccess + 0.05 * r.pLit * r.pSlope });
  }
  cells.sort((a, b) => b.q - a.q || Math.hypot(a.e, a.n) - Math.hypot(b.e, b.n));
  const out = [];
  for (const c of cells) { if (out.every((t) => Math.hypot(t.e - c.e, t.n - c.n) > ext * 0.3)) out.push(c); if (out.length >= 5) break; }
  return out.map((c) => ({ ...c, gain: c.p - base }));
}
