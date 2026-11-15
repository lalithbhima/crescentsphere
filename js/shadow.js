// Heightfield ray-marching shared by main thread and worker.
// Heights are km on a square grid, index i -> x, j -> y. Curvature of the Moon is included.
export const RM = 1737.4;

export function bilinear(h, n, fx, fy) {
  if (fx < 0) fx = 0; else if (fx > n - 1.001) fx = n - 1.001;
  if (fy < 0) fy = 0; else if (fy > n - 1.001) fy = n - 1.001;
  const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, k = iy * n + ix;
  return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - ty) + (h[k + n] * (1 - tx) + h[k + n + 1] * tx) * ty;
}

/** Is a ray leaving grid point (fx,fy) at height h0 along unit grid dir (dx,dy) with slope tanA clear of terrain? */
export function rayClear(h, n, cell, hmax, fx, fy, h0, dx, dy, tanA, maxKm) {
  const step = cell * 0.9;
  for (let s = step; s < maxKm; s += step * (1 + s / 120)) {
    const px = fx + (dx * s) / cell, py = fy + (dy * s) / cell;
    if (px < 0 || py < 0 || px > n - 1 || py > n - 1) return true;
    const curv = (s * s) / (2 * RM);
    if (h0 + s * tanA + curv > hmax) return true;
    if (bilinear(h, n, px, py) - curv > h0 + s * tanA) return false;
  }
  return true;
}

/** Max elevation angle (rad) of terrain along a grid direction from (fx,fy). */
export function horizonAngle(h, n, cell, fx, fy, h0, dx, dy, maxKm) {
  let best = -1e9;
  const step = cell * 0.9;
  for (let s = step; s < maxKm; s += step * (1 + s / 150)) {
    const px = fx + (dx * s) / cell, py = fy + (dy * s) / cell;
    if (px < 0 || py < 0 || px > n - 1 || py > n - 1) break;
    const t = (bilinear(h, n, px, py) - (s * s) / (2 * RM) - h0) / s;
    if (t > best) best = t;
  }
  return Math.atan(best === -1e9 ? 0 : best);
}

const SUN_RAD = 0.2666 * Math.PI / 180;

/**
 * Compute illumination for polar-stereographic pixels.
 * px: list of [ix,iy] float grid positions; dirs: Float32Array(K*3) body-frame unit vectors.
 * Returns per pixel the fraction of samples where the direction is above the horizon.
 */
export function pixelGeometry(n, cell, ix, iy, flat) {
  const x = (ix + 0.5 - n / 2) * cell, y = (iy + 0.5 - n / 2) * cell, r = Math.hypot(x, y);
  if (flat) { // regional flat grid: x = east km, y = north km from (lat0, lon0) in degrees
    const l0 = flat.lat0 * Math.PI / 180, lat = l0 + y / RM, lon = flat.lon0 * Math.PI / 180 + x / (RM * Math.cos(l0));
    return { lat, lon, sl: Math.sin(lon), cl: Math.cos(lon), sf: Math.sin(lat), cf: Math.cos(lat), gsl: 0, gcl: 1 };
  }
  const colat = 2 * Math.atan(r / (2 * RM)), lat = -Math.PI / 2 + colat, lon = Math.atan2(x, y);
  return { lat, lon, sl: Math.sin(lon), cl: Math.cos(lon), sf: Math.sin(lat), cf: Math.cos(lat), gsl: Math.sin(lon), gcl: Math.cos(lon) };
}

/** Local frame components of a body-frame direction at a pixel; returns [elevationRad, gridDx, gridDy]. */
export function localDirAtPixel(g, d) {
  const eU = g.cf * g.cl * d[0] + g.cf * g.sl * d[1] + g.sf * d[2];
  const eE = -g.sl * d[0] + g.cl * d[1];
  const eN = -g.sf * g.cl * d[0] - g.sf * g.sl * d[1] + g.cf * d[2];
  const hz = Math.hypot(eE, eN) || 1, a = eN / hz, b = eE / hz;
  // grid dir = a * Nhat + b * Ehat ; Nhat=(sin lon, cos lon) Ehat=(cos lon, -sin lon)
  return [Math.asin(Math.max(-1, Math.min(1, eU))), a * g.gsl + b * g.gcl, a * g.gcl - b * g.gsl];
}

export function averageVisibility(dem, sunDirs, earthDirs, stride, onProgress) {
  const { h, n, cell, hmax, flat } = dem, m = Math.floor(n / stride);
  const sunA = new Float32Array(m * m), earA = new Float32Array(m * m), bothA = new Float32Array(m * m);
  const K = sunDirs.length / 3, maxKm = 190;
  const sd = [0, 0, 0], ed = [0, 0, 0];
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      const fx = i * stride + (stride - 1) / 2, fy = j * stride + (stride - 1) / 2;
      const g = pixelGeometry(n, cell, fx, fy, flat), h0 = bilinear(h, n, fx, fy);
      let cs = 0, ce = 0, cb = 0;
      for (let k = 0; k < K; k++) {
        sd[0] = sunDirs[k * 3]; sd[1] = sunDirs[k * 3 + 1]; sd[2] = sunDirs[k * 3 + 2];
        ed[0] = earthDirs[k * 3]; ed[1] = earthDirs[k * 3 + 1]; ed[2] = earthDirs[k * 3 + 2];
        const s = localDirAtPixel(g, sd), e = localDirAtPixel(g, ed);
        const sl = s[0] + SUN_RAD > -0.002 && rayClear(h, n, cell, hmax, fx, fy, h0, s[1], s[2], Math.tan(s[0] + SUN_RAD), maxKm);
        const el = e[0] > 0 && rayClear(h, n, cell, hmax, fx, fy, h0, e[1], e[2], Math.tan(e[0]), maxKm);
        if (sl) cs++; if (el) ce++; if (sl && el) cb++;
      }
      const o = j * m + i; sunA[o] = cs / K; earA[o] = ce / K; bothA[o] = cb / K;
    }
    if (onProgress && j % 8 === 0) onProgress(j / m);
  }
  return { sun: sunA, earth: earA, both: bothA, m };
}
