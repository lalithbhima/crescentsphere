// Terrain viewer: a real LOLA DEM (south pole cap or a 104 km site crop) as a navigable 3D surface with slope and shadow read-outs.
import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/addons/OrbitControls.js';
import { polarLL, polarXY, POLAR_CRATERS } from './terrain.js';

const D2R = Math.PI / 180, RM = 1737.4;
const NAMED = ['Shackleton', 'Haworth', 'Shoemaker', 'Faustini', 'de Gerlache', 'Sverdrup', 'Nobile', 'Cabeus', 'Amundsen'];

// slope ramp: gentle ground stays dark and neutral, steep ground warms toward orange
const RAMP = [[0, [30, 38, 56]], [10, [96, 110, 138]], [20, [214, 200, 176]], [30, [255, 168, 96]], [40, [255, 96, 56]]];
function ramp(deg) {
  for (let i = 1; i < RAMP.length; i++) if (deg <= RAMP[i][0]) { const [a, ca] = RAMP[i - 1], [b, cb] = RAMP[i], t = (deg - a) / (b - a); return ca.map((v, k) => (v + (cb[k] - v) * t) / 255); }
  return RAMP[RAMP.length - 1][1].map((v) => v / 255);
}

export function createTerrainView({ onClose } = {}) {
  const root = document.getElementById('poleView'), cv = document.getElementById('pvCanvas');
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true }); renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x05070d);
  const camera = new THREE.PerspectiveCamera(42, 1, 1, 8000); camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, cv); controls.enableDamping = true; controls.dampingFactor = 0.08; controls.maxPolarAngle = Math.PI * 0.49;
  const sun = new THREE.DirectionalLight(0xffffff, 2.1); scene.add(sun, sun.target); scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const lblRoot = document.getElementById('pvLabels'), readout = document.getElementById('pvRead'), hoverMarker = document.getElementById('pvMark'), sb = (id) => document.getElementById(id);
  const st = { shade: 'slope', shadow: false, exag: 3 }; let M = null, raf = 0, open = false, last = 0; const v3 = new THREE.Vector3(), ray = new THREE.Raycaster(), ndc = new THREE.Vector2();

  function build(cfg) {
    if (M) { scene.remove(M.mesh); M.geo.dispose(); }
    const dem = cfg.dem, n = dem.n, cell = dem.cell, half = (n * cell) / 2, h = dem.h, polar = cfg.kind === 'polar', lat0 = (cfg.lat0 || 0) * D2R;
    const slope = new Float32Array(n * n), asp = new Float32Array(n * n); let hi = -1e9, lo = 1e9, hiI = 0, loI = 0, mean = 0;
    for (let i = 0; i < n * n; i++) { const v = h[i]; mean += v; if (v > hi) { hi = v; hiI = i; } if (v < lo) { lo = v; loI = i; } } mean /= n * n;
    for (let j = 1; j < n - 1; j++) for (let i = 1; i < n - 1; i++) {
      const gx = (h[j * n + i + 1] - h[j * n + i - 1]) / (2 * cell), gy = (h[(j + 1) * n + i] - h[(j - 1) * n + i]) / (2 * cell), o = j * n + i;
      slope[o] = Math.atan(Math.hypot(gx, gy)) / D2R; asp[o] = Math.atan2(-gx, -gy);
    }
    const sorted = Float32Array.from(slope).sort(), q = (p) => sorted[Math.floor(sorted.length * p)], share = (d) => { let c = 0; for (let i = 0; i < sorted.length; i++) if (sorted[i] > d) c++; return c / sorted.length; };
    const stats = { median: q(0.5), p95: q(0.95), max: sorted[sorted.length - 1], s10: share(10), s20: share(20), s30: share(30), relief: hi - lo };
    const ll = (x, y) => (polar ? polarLL(x, y) : [cfg.lat0 + y / RM / D2R, cfg.lon0 + x / (RM * Math.cos(lat0)) / D2R]);
    const cellLL = (i) => ll((i % n + 0.5 - n / 2) * cell, (Math.floor(i / n) + 0.5 - n / 2) * cell);
    const pos = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3), idx = new Uint32Array((n - 1) * (n - 1) * 6);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const o = (j * n + i) * 3; pos[o] = (i + 0.5 - n / 2) * cell; pos[o + 1] = (j + 0.5 - n / 2) * cell; pos[o + 2] = h[j * n + i] - mean; }
    let t = 0; for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i, b = a + 1, c = a + n, d = c + 1; idx[t++] = a; idx[t++] = b; idx[t++] = c; idx[t++] = b; idx[t++] = d; idx[t++] = c; }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); geo.setIndex(new THREE.BufferAttribute(idx, 1)); geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })); scene.add(mesh);
    const hAt = (x, y) => { const fx = Math.max(0, Math.min(n - 1.001, x / cell + n / 2 - 0.5)), fy = Math.max(0, Math.min(n - 1.001, y / cell + n / 2 - 0.5)), ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, k = iy * n + ix; return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - ty) + (h[k + n] * (1 - tx) + h[k + n + 1] * tx) * ty; };
    lblRoot.innerHTML = '';
    const items = polar ? POLAR_CRATERS.filter((c) => NAMED.includes(c[0])).map((c) => { const [x, y] = polarXY(c[1], c[2]); return [c[0], x, y, false]; }) : [[cfg.name, 0, 0, true]];
    const labels = items.map(([name, x, y, main]) => { const el = document.createElement('div'); el.className = 'pvlabel' + (main ? ' pole' : ''); el.textContent = name; lblRoot.appendChild(el); return { el, x, y }; });
    M = { cfg, dem, n, cell, half, h, polar, slope, asp, mean, geo, mesh, col, stats, lo, hi, loI, hiI, cellLL, ll, hAt, labels };
    sb('pvTitle').textContent = cfg.title; sb('pvSub').textContent = cfg.sub;
    const rows = [['Map size', `${(n * cell).toFixed(0)} km across, ${cell.toFixed(2)} km grid`], ['Elevation range', `${stats.relief.toFixed(1)} km`], ['Lowest point', `${lo.toFixed(2)} km, ${cellLL(loI).map((v) => v.toFixed(1) + '°').join(', ')}`], ['Highest point', `${hi.toFixed(2)} km, ${cellLL(hiI).map((v) => v.toFixed(1) + '°').join(', ')}`], ['Median slope', stats.median.toFixed(1) + '°'], ['Steepest 5% starts at', stats.p95.toFixed(1) + '°'], ['Ground steeper than 10°', Math.round(stats.s10 * 100) + '%'], ['Ground steeper than 20°', Math.round(stats.s20 * 100) + '%'], ['Ground steeper than 30°', Math.round(stats.s30 * 100) + '%']];
    sb('pvStats').innerHTML = '<table>' + rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('') + '</table>';
    controls.minDistance = half * 0.04; controls.maxDistance = half * 4.5; camera.far = half * 30; camera.updateProjectionMatrix();
    recolor(); setExag(st.exag); sync(); showReadout(null);
  }
  function recolor() {
    if (!M) return; const { n, col, slope, geo, cfg } = M, lit = st.shadow && cfg.getLit ? cfg.getLit() : null, m = lit ? Math.round(Math.sqrt(lit.length)) : 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const o = j * n + i; let c = st.shade === 'slope' ? ramp(slope[o]) : [0.62, 0.62, 0.62];
      if (lit && !lit[Math.min(m - 1, (j * m / n) | 0) * m + Math.min(m - 1, (i * m / n) | 0)]) c = c.map((v) => v * 0.28);
      col[o * 3] = c[0]; col[o * 3 + 1] = c[1]; col[o * 3 + 2] = c[2];
    }
    geo.attributes.color.needsUpdate = true;
  }
  function setExag(v) { st.exag = v; if (M) { M.mesh.scale.z = v; M.mesh.updateMatrixWorld(); } }
  function pick(cx, cy) {
    const r = cv.getBoundingClientRect(); ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera);
    const o = ray.ray.origin, d = ray.ray.direction, { half, hAt, mean } = M, far = half * 14; let tt = 0, prev = null; const s0 = Math.max(0.15 * M.cell, half * 0.003);
    for (let s = 0; s < 3200; s++) {
      const px = o.x + d.x * tt, py = o.y + d.y * tt, pz = o.z + d.z * tt;
      if (Math.abs(px) < half && Math.abs(py) < half && pz < (hAt(px, py) - mean) * st.exag) { if (prev !== null) tt -= (tt - prev) * 0.5; return { x: o.x + d.x * tt, y: o.y + d.y * tt }; }
      prev = tt; tt += Math.max(s0, tt * 0.004); if (tt > far) break;
    }
    return null;
  }
  function describe(p) {
    const { n, cell, asp, slope, polar, hAt } = M, fx = Math.round(p.x / cell + n / 2 - 0.5), fy = Math.round(p.y / cell + n / 2 - 0.5), k = Math.max(1, Math.min(n - 2, fy)) * n + Math.max(1, Math.min(n - 2, fx));
    const [lat, lon] = M.ll(p.x, p.y), l = polar ? Math.atan2(p.x, p.y) : 0, a = asp[k];
    const nx = Math.sin(l), ny = Math.cos(l), ex = Math.cos(l), ey = -Math.sin(l), gx = Math.sin(a), gy = Math.cos(a), az = (Math.atan2(gx * ex + gy * ey, gx * nx + gy * ny) / D2R + 360) % 360;
    const dirs = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    return { lat, lon, elev: hAt(p.x, p.y), slope: slope[k], dir: dirs[Math.round(az / 45) % 8], r: Math.hypot(p.x, p.y) };
  }
  function showReadout(p) {
    if (!p || !M) { readout.innerHTML = '<div class="pvhint">Move over the terrain to read its slope and height. Drag to rotate, scroll to zoom.</div>'; hoverMarker.style.display = 'none'; return; }
    const d = describe(p);
    readout.innerHTML = `<table><tr><td>Latitude / longitude</td><td>${d.lat.toFixed(2)}°, ${d.lon.toFixed(2)}°</td></tr><tr><td>${M.polar ? 'Distance from the pole' : 'Distance from the site'}</td><td>${d.r.toFixed(1)} km</td></tr><tr><td>Elevation (vs. 1737.4 km sphere)</td><td>${d.elev.toFixed(2)} km</td></tr><tr><td>Slope</td><td><b>${d.slope.toFixed(1)}°</b></td></tr><tr><td>Faces (downhill)</td><td>${d.dir}</td></tr></table>`;
  }
  cv.addEventListener('pointermove', (e) => { cv._pt = [e.clientX, e.clientY]; });
  cv.addEventListener('pointerleave', () => { cv._pt = null; showReadout(null); });
  function resize() { const w = cv.clientWidth, hh = cv.clientHeight; renderer.setSize(w, hh, false); camera.aspect = w / hh; camera.updateProjectionMatrix(); }
  function frame(now) {
    if (!open) return; raf = requestAnimationFrame(frame); controls.update(); sun.position.set(-1.2, -0.8, 0.55).multiplyScalar(M.half * 2).add(controls.target);
    renderer.render(scene, camera);
    const w = cv.clientWidth, hh = cv.clientHeight, { hAt, mean } = M;
    for (const l of M.labels) { v3.set(l.x, l.y, (hAt(l.x, l.y) - mean) * st.exag + M.half * 0.002).project(camera); const ok = v3.z < 1 && Math.abs(v3.x) < 1 && Math.abs(v3.y) < 1; l.el.style.display = ok ? 'block' : 'none'; if (ok) l.el.style.transform = `translate(${(v3.x * 0.5 + 0.5) * w}px,${(-v3.y * 0.5 + 0.5) * hh}px)`; }
    if (cv._pt && now - last > 60) { last = now; const p = pick(cv._pt[0], cv._pt[1]); showReadout(p); if (p) { v3.set(p.x, p.y, (hAt(p.x, p.y) - mean) * st.exag).project(camera); hoverMarker.style.display = 'block'; hoverMarker.style.transform = `translate(${(v3.x * 0.5 + 0.5) * w}px,${(-v3.y * 0.5 + 0.5) * hh}px)`; } }
  }
  function sync() { sb('pvSlope').classList.toggle('on', st.shade === 'slope'); sb('pvHill').classList.toggle('on', st.shade === 'hill'); sb('pvShadow').classList.toggle('on', st.shadow); sb('pvLegend').style.display = st.shade === 'slope' ? '' : 'none'; sb('pvExagV').textContent = st.exag.toFixed(1) + '×'; sb('pvExag').value = st.exag; }
  sb('pvSlope').onclick = () => { st.shade = 'slope'; recolor(); sync(); }; sb('pvHill').onclick = () => { st.shade = 'hill'; recolor(); sync(); };
  sb('pvShadow').onclick = () => { st.shadow = !st.shadow; recolor(); sync(); };
  sb('pvExag').oninput = (e) => { setExag(+e.target.value); sync(); }; sb('pvClose').onclick = () => close();
  function openView(cfg) {
    if (!M || M.cfg.key !== cfg.key) build(cfg); else { M.cfg = cfg; recolor(); }
    open = true; root.classList.add('open'); resize(); controls.target.set(0, 0, 0); camera.position.set(0, -M.half * 1.8, M.half * 1.35); controls.update(); cancelAnimationFrame(raf); raf = requestAnimationFrame(frame);
  }
  function close() { open = false; cancelAnimationFrame(raf); root.classList.remove('open'); onClose && onClose(); }
  window.addEventListener('resize', () => open && resize());
  window.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') close(); });
  return { open: openView, close, get isOpen() { return open; } };
}
