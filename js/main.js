import * as THREE from './vendor/three.module.js';
import { state, altAz, jdOf, msOf, D2R, SYNODIC, loadHorizons, ephemerisSource } from './ephemeris.js';
import { SITES, CATS, customSite } from './sites.js';
import { loadRealDems, loadLocalMeta, localDemFor, ensureLocalDem, ensureRegionalDem, regionalIsReal, localIds, hasRealTerrain, getPolarDem, terrainFor, buildPatch, polarLL, offsetLL } from './terrain.js';
import { analyze, dropAnalysis, windowStats, nextEvent, fmtDur, skyTrack, horizonAt, earthTopo, eclipseInfo, localSolarTime, fmtClock, geoEvent, SERIES, STEP, JD_MIN, JD_MAX, clamp } from './analysis.js';
import { createSpace } from './space.js';
import { createSurface } from './surface.js';
import { PolarMap, drawCurves, drawSky, COL, parula } from './charts.js';
import { createTerrainView } from './polarview.js';
import { simulateTransfers, FAMILIES } from './trajectory.js';
import { runMonteCarlo, findAlternates, zoneExtent } from './montecarlo.js';

const $ = (id) => document.getElementById(id), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = { dist: true, jd: clamp(jdOf(Date.now())), speed: 0.0416667, view: 'space', site: null, A: null, patch: null, researcher: false, mapMode: 'now', pinned: [], atmo: 0, atmoTarget: 0, mc: null, mcT: -1, mcJd: 0, heat: false, tracks: true, beams: false, scale: false, busy: false };
const patchCache = new Map();
let space, surface, pmap, polarMap, renderer, worker, openPoleView = null;
const localMaps = new Map();

function toast(msg, ms = 3200) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms); }
const loadMsg = (m, p) => { $('loadmsg').textContent = m; if (p != null) $('loadbar').style.width = p * 100 + '%'; };
const fade = (v) => ($('fade').style.opacity = v);
const fmtDate = (jd) => new Date(msOf(jd)).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
const pct = (v) => Math.round(v * 100) + '%';

const sunArgs = (st) => [st.sunBody, st.earthBody, st.sunRad];
function skyFrom(A, st) {
  const s = altAz(A.b, st.sunBody), e = altAz(A.b, earthTopo(A, st));
  return { st, sunRad: st.sunRad, sun: { ...s, hz: horizonAt(A.hz.profile, s.az) }, earth: { ...e, hz: horizonAt(A.hz.profile, e.az) } };
}

// ------------------------------------------------------------------ boot
function pickShowDate() {
  // start at a date when the near side is mostly lit and Earth shows a nice phase (sub-solar lon ~ -50)
  let best = S.jd, bd = 1e9; const j0 = Math.floor(S.jd) + 0.5;
  for (let k = 0; k < 30; k += 0.25) { const st = state(j0 + k), d = Math.abs(((st.sunSubLon + 50 + 540) % 360) - 180); if (d < bd) { bd = d; best = j0 + k; } }
  S.jd = clamp(best);
}
async function boot() {
  pickShowDate();
  const canvas = $('gl');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
  loadMsg('Loading real Earth & Moon imagery…', 0.1);
  space = await createSpace(renderer, $('labels'));
  surface = createSurface(renderer, $('labels'), space.tex);
  loadMsg('Sculpting the south pole terrain (Shackleton, Haworth, Faustini…)', 0.4);
  await sleep(30);
  await Promise.all([loadRealDems(), loadHorizons(), loadMissions(), loadRTS(), loadLocalMeta()]); SERIES.rebuild();
  const dem = getPolarDem();
  pmap = polarMap = new PolarMap(dem);
  loadMsg('Computing Sun & Earth positions for 7 years…', 0.6);
  await sleep(30);
  analyze(SITES[0]);
  space.setSites(SITES);
  space.setHeatTexture(pmap.texture(THREE));
  buildSiteList();
  bindUI();
  setTimeout(() => startAverageWorker(dem, null, polarMap, 72), 2500);
  pmap.computeNow(...sunArgs(state(S.jd))); pmap.paint('now');
  await ensureLocalDem(SITES.find((s) => s.id === 'ar1')); selectSite(SITES.find((s) => s.id === 'ar1'), { fly: false });
  onResize(); window.addEventListener('resize', onResize);
  loadMsg('Ready', 1);
  setTimeout(() => { $('loader').style.opacity = 0; setTimeout(() => $('loader').remove(), 900); }, 200);
  setView('space', true);
  requestAnimationFrame(frame); console.log('boot done', Math.round(performance.now()));
  const q = new URLSearchParams(location.search);
  if (q.has('date')) S.jd = clamp(jdOf(Date.parse(q.get('date') + 'Z')));
  if (q.has('speed')) { S.speed = +q.get('speed'); syncSpeedButtons(); }
  if (q.has('site')) { const qs = SITES.find((s) => s.id === q.get('site')) || S.site; await ensureLocalDem(qs); selectSite(qs, { fly: !q.has('land') }); }
  (async () => { for (const id of localIds()) { const s = SITES.find((x) => x.id === id); if (s) await ensureLocalDem(s); } })();   // warm every shipped site in the background
  if (q.has('land')) setTimeout(() => { S.busy = false; land(); }, 800);
  else if (!q.has('notour')) setTimeout(introCalm, 600);
}

const workers = new Set();
function startAverageWorker(dem, flat, target, K = 72, quiet = false) {
  const sun = new Float32Array(K * 3), earth = new Float32Array(K * 3);
  for (let k = 0; k < K; k++) { const st = state(S.jd + (((k * 0.6180339887) % 1) * 365.25)); sun.set(st.sunBody, k * 3); earth.set(st.earthBody, k * 3); }
  const finish = (r) => { target.setAverage(r); if (target === pmap) { $('mapProg').style.width = '0'; repaintMap(); if (!quiet) toast('Illumination heat-map ready — ' + K + ' dates sampled across a year'); } else if (target === polarMap) repaintMap(); };
  try {
    const w = new Worker('js/worker.js', { type: 'module' }); workers.add(w);
    w.onmessage = (ev) => {
      if (ev.data.progress != null) { if (target === pmap) $('mapProg').style.width = ev.data.progress * 100 + '%'; return; }
      if (ev.data.done) { finish(ev.data); w.terminate(); workers.delete(w); }
    };
    w.onerror = () => { workers.delete(w); fallbackAverage(dem, flat, sun, earth, finish); };
    w.postMessage({ h: dem.h.slice(), n: dem.n, cell: dem.cell, hmax: dem.hmax, flat, sunDirs: sun, earthDirs: earth, stride: 2 });
  } catch (e) { fallbackAverage(dem, flat, sun, earth, finish); }
}
async function fallbackAverage(dem, flat, sun, earth, finish) {
  const { averageVisibility } = await import('./shadow.js');
  finish(averageVisibility({ h: dem.h, n: dem.n, cell: dem.cell, hmax: dem.hmax, flat }, sun.slice(0, 48 * 3), earth.slice(0, 48 * 3), 2));
}

/** The map follows the selection: polar sites use the pole map, anywhere else gets its own 100 km map generated on the spot. */
function localMapFor(site) {
  const key = site.lat.toFixed(2) + ',' + site.lon.toFixed(2); let map = localMaps.get(key);
  if (!map) {
    if (localMaps.size > 6) localMaps.delete(localMaps.keys().next().value);
    const flat = { lat0: site.lat, lon0: site.lon }, dem = terrainFor(site); dem.flat = flat;
    map = new PolarMap(dem, flat); map.computeNow(...sunArgs(state(S.jd))); localMaps.set(key, map);
    startAverageWorker(dem, flat, map, 48);
  }
  return map;
}
function mapFor(site) {
  let map = polarMap, title = 'South-pole map · 400 km across';
  if (site.lat >= -83.6) {
    map = localMapFor(site);
    title = 'Local map · 100 km around ' + site.name;
  }
  if (map !== pmap) { pmap = map; pmap.computeNow(...sunArgs(state(S.jd))); }
  $('mapTitle').textContent = title; $('mapBest').textContent = 'Go to the best spot'; repaintMap();
}

// ------------------------------------------------------------------ site handling
function patchFor(site) {
  const loc = localDemFor(site), key = site.lat.toFixed(3) + ',' + site.lon.toFixed(3) + (loc ? 'L' : '');
  if (!patchCache.has(key)) { if (patchCache.size > 8) patchCache.delete(patchCache.keys().next().value); patchCache.set(key, buildPatch(terrainFor(site), site.lat, site.lon, site.rough ?? 0.5, 641, 20000, loc)); }
  return patchCache.get(key);
}
// Terrain is always loaded BEFORE a site is shown, so the ground never changes under the user a few seconds after a click.
const triedTerrain = new Set(); let selToken = 0;
const terrainKey = (site) => (site.id && site.id !== 'custom' ? site.id : 'c:' + site.lat.toFixed(3) + ',' + site.lon.toFixed(3));
const needsTerrain = (site) => !triedTerrain.has(terrainKey(site)) && (!localDemFor(site) || (!hasRealTerrain(site) && !regionalIsReal(site)));
function showTerrainLoading(on, name) { const el = $('terrainLoad'); if (on) $('terrainLoadName').textContent = name; el.classList.toggle('on', !!on); }
async function loadThenSelect(site, opts) {
  const mine = ++selToken; showTerrainLoading(true, site.name.replace(/ ·.*/, ''));
  await Promise.race([Promise.all([ensureRegionalDem(site), ensureLocalDem(site)]), sleep(30000)]);
  triedTerrain.add(terrainKey(site)); dropAnalysis(site); showTerrainLoading(false);
  if (mine === selToken) selectSite(site, opts);
}
function selectSite(site, opts = {}) {
  if (needsTerrain(site)) { loadThenSelect(site, opts); return; }
  selToken++; showTerrainLoading(false); applySite(site, opts);
}
function applySite(site, { fly = true } = {}) {
  S.site = site; S.A = analyze(site); S.patch = patchFor(site);
  surface.setSite(S.patch, S.A.hz.profile);
  space.setSelected(site); clearMC(); if (pmap) mapFor(site);
  $('siteName').textContent = site.name; $('siteCat').textContent = (CATS[site.cat]?.label || 'Site') + (site.year ? ' · ' + site.year : '') + (site.approx ? ' · approx.' : '');
  $('siteCoord').textContent = `${Math.abs(site.lat).toFixed(2)}°${site.lat < 0 ? 'S' : 'N'}  ${Math.abs(site.lon).toFixed(2)}°${site.lon < 0 ? 'W' : 'E'}`;
  document.querySelectorAll('.srow').forEach((r) => r.classList.toggle('on', r.dataset.id === site.id));
  $('cLat').value = site.lat.toFixed(2); $('cLon').value = site.lon.toFixed(2);
  lastUI = 0; lastWin = null;
  if (fly && S.view !== 'surface') flyToSite(site);
}
function flyToSite(site, dist) {
  const wasMoon = S.view === 'moon'; setCrumb('moon'); S.view = 'moon'; document.body.className = document.body.className.replace(/v-\w+/, 'v-moon') || 'v-moon';
  const keep = wasMoon && space.camDist() < 14; // already looking at the Moon: glide over, keep the user's zoom
  const d = dist ?? (keep ? space.camDist() : 5.2), ang = keep ? space.angleToDir(space.siteDirWorld(site.lat, site.lon)) : 3;
  if (keep && ang < 0.01) return;
  space.flyToSite(site.lat, site.lon, d, keep ? Math.max(0.35, Math.min(1.1, 0.3 + ang * 0.8)) : 1.8);
}
function setCrumb(v) { document.querySelectorAll('#crumbs button').forEach((b) => b.classList.toggle('on', b.dataset.view === v)); }
function setBodyView(v) { S.view = v; document.body.classList.remove('v-space', 'v-moon', 'v-surface'); document.body.classList.add('v-' + v); setCrumb(v); }

function setView(v, instant = false) {
  if (v === 'space') {
    if (S.view === 'surface') return orbit().then(() => setView('space'));
    setBodyView('space'); S.scale = false; space.scaleGroup.visible = false; $('bScale').classList.remove('on');
    space.flyTo({ to: 'mid', dist: 1100, dir: new THREE.Vector3(0.18, 0.62, 0.76), dur: instant ? 0.01 : 2.6 });
  } else if (v === 'moon') {
    if (S.view === 'surface') return orbit();
    setBodyView('moon'); flyToSite(S.site);
  } else if (v === 'surface') land();
}

async function land() {
  if (S.view === 'surface' || S.busy) return; S.busy = true;
  if (S.view === 'space') setBodyView('moon');
  fade(1); await sleep(320);
  // landing from a Monte Carlo result: the clock jumps to the touchdown moment of the best route and runs on from there
  const mc = S.trMC; let landed = null;
  if (mc && mc.best && !S.mcLanded && S.mcSite && S.mcSite.lat === S.site.lat && S.mcSite.lon === S.site.lon) { setJd(mc.best.land); S.mcLanded = true; landed = mc.best.land; }
  setBodyView('surface'); space.setVisible(false); surface.setVisible(true);
  const sk = skyFrom(S.A, state(S.jd)); surface.setView('orbit', sk.sun.az); setActive('vChase');
  await sleep(120); fade(0); S.busy = false;
  toast(landed ? 'Touchdown on ' + fmtDate(landed) + '. The clock now runs on from this moment.' : 'Drag to look around · scroll to zoom · the dashed lines show Sun (yellow) and Earth (cyan)', 4500);
}
async function orbit() {
  if (S.view !== 'surface' || S.busy) return; S.busy = true;
  fade(1); await sleep(320);
  surface.setVisible(false); space.setVisible(true); setBodyView('moon'); space.flyTo({ to: 'moon', dist: 4.4, dirFn: () => space.siteDirWorld(S.site.lat, S.site.lon), dur: 0.02 });
  await sleep(60); fade(0); S.busy = false;
}

async function introCalm() {
  if (S.busy) return; S.busy = true; setBodyView('moon'); S.speed = 0.0416667; syncSpeedButtons();
  await new Promise((res) => space.flyTo({ to: 'moon', dist: 6, dir: space.siteDirWorld(S.site.lat, S.site.lon), dur: 3.5, done: res, cancel: res }));   // cancel: clicking a site mid-intro replaces the flight, so release the busy flag
  toast('Click any pin — or anywhere on the Moon — to choose a landing site. Use Surface in the top bar to drive on it.', 5000); S.busy = false;
}
// ------------------------------------------------------------------ tour
async function tour(intro = false) {
  if (S.busy || S.view === 'surface') return; S.busy = true;
  setBodyView('space'); S.scale = true; space.scaleGroup.visible = true; $('bScale').classList.add('on');
  if (intro) S.speed = 0.5; else S.speed = 0.25;
  syncSpeedButtons();
  await new Promise((res) => space.flyTo({ to: 'earth', dist: 11, dir: new THREE.Vector3(0.6, 0.25, 0.75), dur: 0.02, done: res, cancel: res }));
  toast('Everything you see is true scale — Earth, Moon and the gap between them.', 4200);
  await new Promise((res) => space.flyTo({ to: 'mid', dist: 1050, dir: new THREE.Vector3(0.18, 0.5, 0.84), dur: 13, done: res, cancel: res }));
  toast('384,400 km — thirty Earths fit between us and the Moon.', 4800);
  await sleep(3800); if (S.view !== 'space') { S.busy = false; return; }
  setBodyView('moon'); S.scale = false; space.scaleGroup.visible = false; $('bScale').classList.remove('on');
  await new Promise((res) => space.flyTo({ to: 'moon', dist: 5.2, dir: space.siteDirWorld(S.site.lat, S.site.lon), dur: 7, done: res, cancel: res }));
  toast('Click any pin — or anywhere on the Moon — to choose a landing site.', 4500);
  S.speed = 0.0416667; syncSpeedButtons(); S.busy = false;
}

// ------------------------------------------------------------------ UI binding
let lastUI = 0, lastWin = null, lastWinKey = '', trackKey = '', trackPts = null;
function buildSiteList() {
  const list = $('siteList'), q = ''; list.innerHTML = '';
  for (const cat of ['apollo', 'clps', 'intl', 'artemis', 'terrain']) {
    const items = SITES.filter((s) => s.cat === cat && s.name.toLowerCase().includes(q)); if (!items.length) continue;
    const h = document.createElement('div'); h.className = 'cat'; h.innerHTML = `<i style="background:${CATS[cat].color}"></i>${CATS[cat].label}`; list.appendChild(h);
    if (cat === 'terrain') { const r = document.createElement('div'); r.className = 'srow'; r.innerHTML = '<span>South pole terrain</span><span class="y"></span>'; r.onclick = () => openPoleView && openPoleView(); list.appendChild(r); }
    for (const s of items) { const r = document.createElement('div'); r.className = 'srow' + (S.site && S.site.id === s.id ? ' on' : ''); r.dataset.id = s.id; r.innerHTML = `<span>${s.name}</span><span class="y">${s.year || ''}</span>`; r.onclick = () => selectSite(s); list.appendChild(r); }
  }
}
function setActive(id) { for (const b of ['vChase', 'vSun', 'vEarth']) $(b).classList.toggle('on', b === id); }
function syncSpeedButtons() { document.querySelectorAll('#speeds button').forEach((b) => b.classList.toggle('on', Math.abs(+b.dataset.s - S.speed) < 1e-9)); }

function bindUI() {
  if (innerWidth < 1100) { $('siteBody').classList.add('hide'); $('sitesToggle').textContent = '+'; }
  $('sitesToggle').onclick = () => { $('siteBody').classList.toggle('hide'); $('sitesToggle').textContent = $('siteBody').classList.contains('hide') ? '+' : '–'; };
  $('cGo').onclick = () => { const la = parseFloat($('cLat').value), lo = parseFloat($('cLon').value); if (isFinite(la) && isFinite(lo)) selectSite(customSite(Math.max(-90, Math.min(90, la)), lo)); };
  document.querySelectorAll('#crumbs button').forEach((b) => (b.onclick = () => setView(b.dataset.view)));
  { let tv = null;
    const show = (cfg) => { tv = tv || createTerrainView(); tv.open(cfg); };
    openPoleView = () => { polarMap.computeNow(...sunArgs(state(S.jd))); show({ key: 'pole', kind: 'polar', dem: getPolarDem(), title: 'South pole terrain', sub: 'Real LOLA elevation data, polar stereographic, 400 km across', getLit: () => polarMap.now.lit }); }; space.setPoleHandler(openPoleView);
    space.setTerrainSites(SITES.filter((s) => s.lat >= -83.6 && hasRealTerrain(s)));
    space.setTerrainHandler((site) => { if (!site) return; const map = localMapFor(site); map.computeNow(...sunArgs(state(S.jd))); show({ key: 'site:' + site.id, kind: 'flat', lat0: site.lat, lon0: site.lon, name: site.name.replace(/ ·.*/, ''), dem: terrainFor(site), title: site.name, sub: `Real LOLA elevation data, ${(terrainFor(site).n * terrainFor(site).cell).toFixed(0)} km across, ${terrainFor(site).cell} km grid`, getLit: () => map.now.lit }); });
  }
  $('mExp').onclick = () => setMode(false); $('mRes').onclick = () => setMode(true);
  $('bTour').onclick = () => tour(); $('bPole').onclick = () => { if (S.view === 'surface') return; setBodyView('moon'); space.flyTo({ to: 'moon', dist: 4.6, dir: space.poleDirWorld(), dur: 2.4 }); S.heat = true; syncHeat(); };
  $('bScale').onclick = () => { S.scale = !S.scale; space.scaleGroup.visible = S.scale; $('bScale').classList.toggle('on', S.scale); if (S.scale && S.view !== 'space') setView('space'); };
  $('bHeat').onclick = () => { S.heat = !S.heat; syncHeat(); }; $('bLand').onclick = land; $('bUp').onclick = orbit;
  $('vChase').onclick = () => { const sk = skyFrom(S.A, state(S.jd)); surface.setView('orbit', sk.sun.az); setActive('vChase'); };
  $('vSun').onclick = () => { const sk = skyFrom(S.A, state(S.jd)); surface.lookAt(surface.enu(Math.max(sk.sun.el, 0.03), sk.sun.az)); setActive('vSun'); };
  $('vEarth').onclick = () => { const sk = skyFrom(S.A, state(S.jd)); surface.lookAt(surface.enu(Math.max(sk.earth.el, 0.03), sk.earth.az)); setActive('vEarth'); };
  $('bTracks').onclick = () => { S.tracks = !S.tracks; $('bTracks').classList.toggle('on', S.tracks); };
  $('bBeams').onclick = () => { S.beams = !S.beams; $('bBeams').classList.toggle('on', S.beams); };
  $('bAtmo').onclick = () => { S.atmoTarget = S.atmoTarget ? 0 : 1; $('bAtmo').classList.toggle('on', !!S.atmoTarget); toast(S.atmoTarget ? 'Earth-like sky: scattered light fills the shadows and hides the stars. On the Moon, none of that happens.' : 'No atmosphere: hard black shadows, stars at noon.', 3800); };
  // time
  document.querySelectorAll('#speeds button').forEach((b) => (b.onclick = () => { S.speed = +b.dataset.s; syncSpeedButtons(); }));
  $('dt').onchange = () => { const v = $('dt').value; if (v) setJd(jdOf(Date.parse(v + ':00Z'))); };
  $('jNow').onclick = () => setJd(jdOf(Date.now()));
  $('distBtn').onclick = () => { S.dist = !S.dist; $('distOut').classList.toggle('hide', !S.dist); $('distBtn').classList.toggle('on', S.dist); $('distBtn').textContent = S.dist ? 'Hide distances' : 'See distances between Earth, Moon and Sun'; if (!S.dist) space.setDistances(false); lastUI = 0; };
  $('jBest').onclick = findBest;

  { const cv = $('cvCurves'); cv.onpointermove = (e) => { S.curveHover = e.clientX - cv.getBoundingClientRect().left; lastUI = 0; }; cv.onpointerleave = () => { S.curveHover = null; lastUI = 0; }; }
  // map
  document.querySelectorAll('#mapChips button').forEach((b) => (b.onclick = () => { S.mapMode = b.dataset.m; document.querySelectorAll('#mapChips button').forEach((x) => x.classList.toggle('on', x === b)); repaintMap(); }));
  let topIdx = 0;
  const goTop = (i) => { const t = pmap.top('both', 5)[i]; if (!t) { toast('Still computing the year-long illumination, a few seconds…', 2500); return; } const [lat, lon] = pmap.unproj(t.x, t.y); selectSite(customSite(lat, lon)); toast(`Best spot #${i + 1}: Sun and Earth both up ${Math.round(t.v * 100)}% of the year`, 3500); };
  $('mapBest').onclick = () => { goTop(topIdx % 5); topIdx++; $('mapBest').textContent = 'Next best spot'; };
  $('mapFull').onclick = () => { S.fullHeat = !S.fullHeat; syncFullHeat(); };
  const mc = $('cvMap');
  mc.onclick = (e) => { const p = pmap.pick(mc, e.clientX, e.clientY); if (!p) return; const [lat, lon] = pmap.unproj(p.x, p.y); if (!pmap.flat && lat > -83.3) return; selectSite(customSite(lat, lon)); };
  mc.onpointermove = (e) => { const p = pmap.pick(mc, e.clientX, e.clientY), tip = $('mapTip'); if (!p) { tip.style.display = 'none'; return; } pmap.hover = p; const [lat, lon] = pmap.unproj(p.x, p.y), v = pmap.value(p.x, p.y), r = mc.getBoundingClientRect(); tip.style.display = 'block'; tip.style.left = Math.min(e.clientX - r.left + 10, r.width - 150) + 'px'; tip.style.top = e.clientY - r.top + 10 + 'px'; tip.textContent = `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'} ${Math.abs(lon).toFixed(1)}°${lon < 0 ? 'W' : 'E'}` + (v ? ` · Sun ${pct(v.sun)} · Earth ${pct(v.earth)}` : ''); };
  mc.onpointerleave = () => { pmap.hover = null; $('mapTip').style.display = 'none'; };
  // Monte Carlo
  { const toLocal = (jd) => new Date(msOf(jd)).toISOString().slice(0, 16); S.dest = S.jd + 5; $('destDate').value = toLocal(S.dest); $('destDate').onchange = () => { const v = $('destDate').value; if (v) { const j = jdOf(Date.parse(v + ':00Z')), c = Math.min(JD_MAX - 1, Math.max(JD_MIN + 4, j)); if (c !== j) { toast('The ephemeris covers June 2025 to December 2040, so the date was moved to the nearest day inside that range.', 4500); $('destDate').value = toLocal(c); } S.dest = c; } }; const lim = (id) => { $(id).min = toLocal(JD_MIN); $(id).max = toLocal(JD_MAX); }; lim('destDate'); lim('dt'); }
  $('mcRun').onclick = () => { $('mcRun').textContent = 'Calculating…'; requestAnimationFrame(() => setTimeout(runSim, 30)); };
  // compare
  $('pinBtn').onclick = pinCurrent;
  $('csv').onclick = exportCsv;
  // canvas interaction
  const cv = $('gl'); let down = null;
  cv.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY, t: performance.now() }));
  cv.addEventListener('pointerup', (e) => {
    if (!down || S.view === 'surface' || S.busy) return; const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null; if (moved > 5) return;
    const pin = space.pickPin(e.clientX, e.clientY); if (pin) return selectSite(pin);
    if (space.camDistToMoonSurface() < 40) { const h = space.pickMoon(e.clientX, e.clientY); if (h) selectSite(customSite(h.lat, h.lon)); }
  });
  cv.addEventListener('dblclick', (e) => { if (S.view !== 'surface' && space.camDistToMoonSurface() < 40) land(); });
  cv.addEventListener('pointermove', (e) => {
    const tip = $('tip'); if (S.view === 'surface' || space.camDistToMoonSurface() > 40) { tip.style.display = 'none'; return; }
    const pin = space.pickPin(e.clientX, e.clientY); if (pin) { tip.style.display = 'block'; tip.style.left = e.clientX + 14 + 'px'; tip.style.top = e.clientY + 10 + 'px'; tip.textContent = pin.name; cv.style.cursor = 'pointer'; } else { tip.style.display = 'none'; cv.style.cursor = 'grab'; }
  });
  window.addEventListener('keydown', (e) => { if (e.target.tagName === 'INPUT') return; if (e.code === 'Space') { e.preventDefault(); S.speed = S.speed === 0 ? 0.0416667 : 0; syncSpeedButtons(); } });
  syncSpeedButtons();
}
const clampF = (v) => Math.max(0, Math.min(1, v));
const fmtKm = (k) => (k < 1 ? Math.round(k * 1000) + ' m' : k.toFixed(1) + ' km');
function setMode(r) { S.researcher = r; space.setTrajVisible(r && !!S.trMC); document.body.classList.toggle('researcher', r); document.body.classList.toggle('explorer', !r); $('mRes').classList.toggle('on', r); $('mExp').classList.toggle('on', !r); lastUI = 0; }
function setJd(jd) { S.jd = clamp(jd); lastUI = 0; }
function syncHeat() { space.heat.visible = S.heat; $('bHeat').classList.toggle('on', S.heat); if (S.heat && S.view === 'space') flyToSite(S.site); }
function syncFullHeat() {
  space.setGlobalHeat(!!S.fullHeat); $('mapFull').classList.toggle('on', !!S.fullHeat); $('mapFull').textContent = S.fullHeat ? 'Hide full heatmap' : 'Show full heatmap on the Moon';
  if (S.fullHeat && S.view !== 'surface') { if (S.view === 'space') { setBodyView('moon'); space.flyTo({ to: 'moon', dist: 6.5, dirFn: () => space.siteDirWorld(S.site.lat, S.site.lon), dur: 1.8 }); } toast('Whole Moon, live: green is Sun and Earth both up, yellow Sun only, blue Earth only, dark neither. Change the date or press play and it moves.', 5600); }
}

function repaintMap() {
  const src = S.mapMode; pmap.paint(src);
  const cb = $('mapLegend');
  if (src === 'now') { cb.className = 'cbar now'; cb.nextElementSibling?.remove(); cb.insertAdjacentHTML('afterend', '<div class="lg"><span>dark</span><span>Earth only</span><span>Sun only</span><span>both</span></div>'); }
  else { cb.className = 'cbar'; cb.nextElementSibling?.remove(); cb.insertAdjacentHTML('afterend', `<div class="lg"><span>${pmap.range ? Math.round(pmap.range[0] * 100) : 0}%</span><span>${src === 'sun' ? 'time in sunlight' : src === 'earth' ? 'time Earth is visible' : 'time both are on'}</span><span>${pmap.range ? Math.round(pmap.range[1] * 100) : 100}%</span></div>`); }
}

// ------------------------------------------------------------------ Monte Carlo (Earth to Moon routes)
function clearMC() { simToken++; S.trMC = null; space.setTransfers(null); space.setTrajVisible(false); $('mcText').textContent = ''; $('mcRank').innerHTML = ''; $('mcRun').textContent = 'Find the best landing site'; }
function showTrajView() { if (S.view === 'surface') return; setBodyView('space'); space.flyTo({ to: 'mid', dist: 1050, dir: new THREE.Vector3(0.18, 0.5, 0.84), dur: 1.6 }); }
let simToken = 0;
async function runSim() {
  const dest = S.dest || S.jd; setJd(dest - 2.5); // the clock sits a couple of days before the arrival date
  const region = $('mcRegion').value, prio = $('mcPrio').value, P = { balanced: [0.12, 1], comms: [0.5, 3], fuel: [0.03, 1] }[prio];
  const sites = SITES.filter((s) => region === 'all' || (region === 'south' && s.lat < -80) || (region === 'near' && Math.abs(s.lon) <= 90) || (region === 'far' && Math.abs(s.lon) > 90));
  if (!sites.length) { $('mcRun').textContent = 'Find the best landing site'; return toast('No sites in that region'); }
  const res = simulateTransfers({ jd: dest, sites, analyze, weight: P[0], minRun: P[1] }); res.minRun = P[1]; res.prio = prio;
  if (!res.winner || !res.best) { clearMC(); $('mcText').textContent = 'No simulated flight reached the Moon.'; return; }
  await ensureLocalDem(res.winner); triedTerrain.add(terrainKey(res.winner)); selectSite(res.winner, { fly: false }); // selecting clears the previous result, so store the new one afterwards
  const tok = ++simToken; S.trMC = res; S.mcJd = dest; S.mcSite = res.winner; S.mcLanded = false; space.setTransfers(res, res.winner); space.setTrajVisible(S.researcher);
  $('mcText').textContent = explain(res); $('mcRun').textContent = 'Recalculate'; showTrajView();
  const rows = res.ranking.slice(0, 5).map((s, k) => `<tr><td>${k + 1}</td><td>${s.site.name.replace(/ ·.*/, '')}</td><td>${s.run.toFixed(1)} d, ${s.dv.toFixed(2)} km/s</td></tr>`).join('');
  $('mcRank').innerHTML = `<div class="rh">Top sites for this date</div><table>${rows}</table><div class="cnote" style="margin-top:6px">Days with Sun and Earth both up after landing, and the fuel needed.</div>`;
  // stage 2: every other route disappears, the camera goes to the winning site and the route ends on the green dot
  setTimeout(() => { if (tok !== simToken || !S.trMC || S.view === 'surface') return; space.finishTransfers(); setBodyView('moon'); space.flyToSite(S.site.lat, S.site.lon, 3.4, 2.2); }, 3200);
}
/** Plain-language reasoning built from the simulation numbers (no language model involved). */
function explain(res) {
  const b = res.best, w = res.winner, fam = FAMILIES[b.fam].toLowerCase(), lat = Math.abs(w.lat).toFixed(1) + (w.lat < 0 ? '°S' : '°N');
  const kinds = FAMILIES.map((n, i) => (res.famCount[i] ? `${res.famCount[i]} ${n.toLowerCase()}` : null)).filter(Boolean).join(', ');
  const top = res.ranking[0], second = res.ranking[1], cheap = res.ranking.reduce((a, c) => (c.dv > 0 && c.dv < a.dv ? c : a), { dv: 1e9 });
  const out = [`${res.N.toLocaleString()} routes that reach the Moon were found among ${res.flights.toLocaleString()} simulated flights (${kinds}). Each was scored against ${res.nSites} sites for a landing on ${fmtDate(S.mcJd)}.`,
    `The best site is ${w.name} (${lat}). The best route is ${/^[aeiou]/.test(fam) ? 'an' : 'a'} ${fam} one that leaves Earth on ${fmtDate(b.launch)}, flies ${b.tof.toFixed(1)} days and lands on ${fmtDate(b.land)}. It needs ${b.dv.toFixed(2)} km/s in total: ${b.tli.toFixed(2)} for the trans-lunar burn, ${b.loi.toFixed(2)} to brake into lunar orbit and ${b.plane.toFixed(2)} to change the orbit plane for ${lat}.`];
  if (top.viable) {
    out.push(`After landing there, the Sun and Earth are both above the local horizon for ${top.run.toFixed(1)} days in a row, which gives solar power and a direct link to Earth. ${res.nOk} of ${res.nSites} sites had at least ${res.minRun} such ${res.minRun === 1 ? 'day' : 'days'} on this date.`);
    if (second) out.push(`Runner-up: ${second.site.name.replace(/ ·.*/, '')}, with ${second.run.toFixed(1)} days of Sun and Earth and ${second.dv.toFixed(2)} km/s.`);
    if (cheap.site && cheap.site !== w) out.push(`The lowest fuel cost, ${cheap.dv.toFixed(2)} km/s, belongs to ${cheap.site.name.replace(/ ·.*/, '')}, but it ${cheap.viable ? `has only ${cheap.run.toFixed(1)} days of Sun and Earth together against ${top.run.toFixed(1)} here` : 'does not have enough Sun and Earth time after landing'}.`);
  } else out.push(`No site has at least ${res.minRun} ${res.minRun === 1 ? 'day' : 'days'} of Sun and Earth together after landing on this date, so this is simply the cheapest option. Try another date or region.`);
  return out.join(' ');
}



// ------------------------------------------------------------------ real spacecraft paths (JPL Horizons)
let MIS = null, misOn = null;
async function loadMissions() {
  try {
    const [meta, buf] = await Promise.all([fetch('tex/missions.json').then((r) => r.json()), fetch('tex/missions.bin').then((r) => r.arrayBuffer())]);
    MIS = { list: meta.missions, d: new Float32Array(buf) }; const box = $('misList'); box.innerHTML = '';
    const gord = ['NASA', 'Korea', 'Japan', 'India', 'Apollo']; MIS.list.sort((a, b) => gord.indexOf(a.group) - gord.indexOf(b.group) || +b.year - +a.year);
    let grp = ''; for (const m of MIS.list) {
      if (m.group !== grp) { grp = m.group; const g = document.createElement('div'); g.className = 'mg'; g.textContent = { NASA: 'NASA', Korea: 'South Korea', Japan: 'Japan', India: 'India', Apollo: 'Apollo era' }[grp] || grp; box.appendChild(g); }
      const r = document.createElement('div'); r.className = 'mrow'; r.dataset.id = m.id; r.innerHTML = `<span>${m.name}</span><span>${m.year}</span>`; r.onclick = () => showMission(m.id); box.appendChild(r);
    }
    $('misHide').onclick = hideMission;
  } catch (e) { console.warn('Mission paths unavailable', e); $('misList').textContent = 'Mission data could not be loaded.'; }
}
function showMission(id) {
  const m = MIS.list.find((x) => x.id === id); if (!m) return; misOn = id;
  const t = new Float32Array(m.n), pts = new Float32Array(m.n * 3);
  for (let i = 0; i < m.n; i++) { const o = (m.offset + i) * 4; t[i] = MIS.d[o]; pts[i * 3] = MIS.d[o + 1]; pts[i * 3 + 1] = MIS.d[o + 2]; pts[i * 3 + 2] = MIS.d[o + 3]; }
  space.setMission({ name: m.name, n: m.n, t, pts, days: m.days });
  document.querySelectorAll('#misList .mrow').forEach((r) => r.classList.toggle('on', r.dataset.id === id)); $('misHide').style.display = '';
  const km = (v) => Math.round(v).toLocaleString() + ' km', row = (a, b) => `<tr><td>${a}</td><td>${b}</td></tr>`;
  $('misInfo').innerHTML = `<div>${m.what}</div><table>${row('Start', m.start.slice(0, 17) + ' UTC')}${row('End', m.stop.slice(0, 17) + ' UTC')}${row('Duration', m.days.toFixed(1) + ' days')}${row('Farthest from Earth', km(m.maxEarthKm))}${row('Closest to the Moon', km(m.minMoonAltKm) + ' above the surface')}</table>`;
  if (S.view !== 'surface') { setBodyView('space'); space.flyTo({ to: 'mid', dist: Math.max(1050, m.maxEarthKm / 1000 * 1.15), dir: new THREE.Vector3(0.18, 0.5, 0.84), dur: 1.6 }); }
}
function hideMission() { misOn = null; space.setMission(null); document.querySelectorAll('#misList .mrow').forEach((r) => r.classList.remove('on')); $('misHide').style.display = 'none'; $('misInfo').innerHTML = ''; }


// ------------------------------------------------------------------ Horizons rise/set cross-check (Researcher)
let RTS = null;
async function loadRTS() { try { RTS = await (await fetch('tex/horizons_rts.json')).json(); } catch (e) { console.warn('Horizons rise/set file unavailable', e); } }
function horizonsRows(A, jd, row) {
  const rec = RTS && RTS.sites[A.site.id]; if (!rec) return '';
  const fmt = (j) => new Date(msOf(j)).toISOString().slice(5, 16).replace('T', ' '), out = [];
  for (const [kind, list, name] of [['sun', rec.sun, 'Sun'], ['earth', rec.earth, 'Earth']]) {
    const nx = (list || []).find(([j]) => j > jd); if (!nx) { if (kind === 'sun') out.push(row(`Horizons check: ${name}`, 'file covers Nov 2026 to Feb 2027')); continue; }
    const rising = nx[1] === 'r', mine = geoEvent(A.site, nx[0] - 0.5, kind, rising); if (mine === null) continue;
    const dm = (mine - nx[0]) * 1440;
    out.push(row(`Next ${name.toLowerCase()}${rising ? 'rise' : 'set'}, flat horizon, upper limb`, `Horizons ${fmt(nx[0])}, here ${fmt(mine)} (${dm >= 0 ? '+' : ''}${dm.toFixed(0)} min)`));
  }
  return out.join('');
}

// ------------------------------------------------------------------ compare
const PCOL = ['#ff9f1c', '#2ec4b6', '#e71d36', '#9b5de5'];
function pinCurrent() {
  if (S.pinned.some((p) => p.site.lat === S.site.lat && p.site.lon === S.site.lon && Math.abs(p.jd - S.jd) < 0.5)) return toast('This site and date is already pinned');
  if (S.pinned.length >= 4) S.pinned.shift();
  S.pinned.push({ site: S.site, jd: S.jd, base: windowStats(S.A, S.jd).score, baseJd: S.jd }); renderCards(true); space.setPinned(S.pinned.map((p) => p.site));
}
let cardEls = new Map(), lastCards = 0;
function renderCards(rebuild) {
  const box = $('cards'); if (rebuild) { box.innerHTML = ''; cardEls.clear(); }
  $('compare').style.display = 'flex';
  const scores = S.pinned.map((p) => windowStats(analyze(p.site), p.jd)), best = Math.max(...scores.map((s) => s.score), -1);
  S.pinned.forEach((p, i) => {
    let el = cardEls.get(p);
    if (!el) {
      el = document.createElement('div'); el.className = 'ccard';
      el.innerHTML = `<div class="cname"><span></span><button class="x">Remove</button></div><div class="cdate"></div><div class="cs">Sun <b class="vs"></b></div><div class="ce">Earth <b class="ve"></b></div>`;
      el.querySelector('.x').onclick = (ev) => { ev.stopPropagation(); S.pinned.splice(S.pinned.indexOf(p), 1); renderCards(true); space.setPinned(S.pinned.map((q) => q.site)); };
      el.onclick = () => { selectSite(p.site); setJd(p.jd); }; box.appendChild(el); cardEls.set(p, el);
    }
    const w = scores[i];
    el.querySelector('.cname span').textContent = `Site ${i + 1}: ` + p.site.name.replace(/ ·.*/, ''); el.querySelector('.cdate').textContent = fmtDate(p.jd) + ', next 7 days';
    el.querySelector('.vs').textContent = pct(w.sunFrac); el.querySelector('.ve').textContent = pct(w.earthFrac);
  });
  $('compare').querySelector('.cnote').style.display = S.pinned.length ? 'none' : '';
}

function findBest() {
  const A = S.A, i0 = Math.round(SERIES.index(S.jd)), W = Math.round(7 / STEP), N = Math.round(90 / STEP); let cur = 0, best = -1, bi = 0;
  for (let k = 0; k < W; k++) if (A.sunM[i0 + k] > 0 && A.earthM[i0 + k] > 0) cur++;
  for (let k = 0; k < N; k++) { if (cur > best) { best = cur; bi = k; } const out = A.sunM[i0 + k] > 0 && A.earthM[i0 + k] > 0, inn = A.sunM[i0 + k + W] > 0 && A.earthM[i0 + k + W] > 0; cur += (inn ? 1 : 0) - (out ? 1 : 0); }
  setJd(SERIES.jd0 + (i0 + bi) * STEP); toast(`Best 7-day window in the next 90 days: Sun and Earth both available ${pct(best / W)} of the time.`, 4500);
}
function exportCsv() {
  const A = S.A, rows = ['utc,sun_elevation_deg,sun_above_horizon,earth_elevation_deg,earth_above_horizon'], i0 = Math.round(SERIES.index(S.jd));
  for (let k = 0; k < 30 * 4; k++) { const i = i0 + k * 3; rows.push([new Date(msOf(SERIES.jd0 + i * STEP)).toISOString(), A.sunEl[i].toFixed(2), A.sunM[i] > 0 ? 1 : 0, A.earthEl[i].toFixed(2), A.earthM[i] > 0 ? 1 : 0].join(',')); }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' })); a.download = `visibility_${S.site.id}.csv`; a.click();
}

// ------------------------------------------------------------------ per-frame UI
function pillClass(el, up, dt) { el.className = 'irow ' + (up ? (dt < 0.125 ? 'crit' : dt < 1 ? 'warn' : 'up') : 'down'); }
function updateUI(now) {
  const A = S.A, st = state(S.jd), sk = skyFrom(A, st), jd = S.jd;
  // countdowns
  const ns = nextEvent(A, jd, 'sun'), ne = nextEvent(A, jd, 'earth');
  const sunUp = sk.sun.el + sk.sunRad > sk.sun.hz, earthUp = sk.earth.el > sk.earth.hz;
  const nm = (n, up, a, b, always, never) => (isFinite(n.dt) ? [up ? a : b, fmtDur(n.dt)] : [up ? always : never, '']);
  let [l, v] = nm(ns, sunUp, 'Sunset in', 'Sunrise in', 'Sun never sets', 'Permanent shadow'); $('sunLabel').textContent = l; $('sunBig').textContent = v || (sunUp ? 'Always' : '-'); pillClass($('sunPill'), sunUp, ns.dt);
  $('sunSmall').textContent = sunUp ? `${(sk.sun.el / D2R).toFixed(1)}° above horizon` : `${(sk.sun.el / D2R).toFixed(1)}° below horizon`;
  [l, v] = nm(ne, earthUp, 'Earthset in', 'Earthrise in', 'Earth always in view', 'Earth never visible'); $('earthLabel').textContent = l; $('earthBig').textContent = v || (earthUp ? 'Always' : '-'); pillClass($('earthPill'), earthUp, ne.dt);
  $('earthSmall').textContent = `${(sk.earth.el / D2R).toFixed(1)}° ${earthUp ? 'above' : 'below'} horizon`;
  { // Earth eclipsing the Sun, and local solar time at the site
    const ei = eclipseInfo(A, jd), hrs = (d) => (d * 24).toFixed(1) + ' h';
    if (ei.cur) { $('eclLabel').textContent = 'Earth is eclipsing the Sun'; $('eclVal').textContent = `${Math.round(ei.now * 100)}% covered, ends in ${fmtDur(ei.cur.end - jd)}`; }
    else if (ei.next) { $('eclLabel').textContent = 'Next Earth eclipse of the Sun'; $('eclVal').textContent = `in ${fmtDur(ei.next.start - jd)}, ${hrs(ei.next.end - ei.next.start)}, ${ei.next.total ? 'total' : Math.round(ei.next.max * 100) + '% at most'}`; }
    else { $('eclLabel').textContent = 'Earth eclipse of the Sun'; $('eclVal').textContent = 'none in the next year'; }
    $('eclRow').className = 'irow' + (ei.cur ? ' warn' : '');
    $('lstVal').textContent = fmtClock(localSolarTime(A.site, st)) + ' (lunar day = 24 h)';
  }
  // window stats
  const key = A.key + ':' + Math.round(jd * 8); if (key !== lastWinKey) { lastWinKey = key; lastWin = windowStats(A, jd); }
  const w = lastWin || (lastWin = windowStats(A, jd));
  if (S.researcher) {
    const row = (a, b) => `<tr><td>${a}</td><td>${b}</td></tr>`, d = (r) => (r / D2R).toFixed(2) + '°';
    const hz = Math.max(...A.hz.profile) / D2R;
    $('resStats').innerHTML = '<table>' + row('Sun elevation / azimuth', `${d(sk.sun.el)} / ${(sk.sun.az / D2R).toFixed(1)}°`) + row('Terrain horizon toward Sun', d(sk.sun.hz)) + row('Earth elevation / azimuth', `${d(sk.earth.el)} / ${(sk.earth.az / D2R).toFixed(1)}°`) + row('Earth libration lon / lat', `${st.libLon.toFixed(2)}° / ${st.libLat.toFixed(2)}°`) + row('Earth distance', Math.round(st.earthDist).toLocaleString() + ' km') + row('Sun distance', (st.sunDist / 149597870.7).toFixed(4) + ' AU') + row('Sub-solar point', `${st.sunSubLat.toFixed(2)}°, ${st.sunSubLon.toFixed(1)}°`) + row('Highest horizon (any azimuth)', hz.toFixed(2) + '°') + row('Peak Sun elevation (29.5 d)', w.maxSunEl.toFixed(1) + '°') + row('Longest night', w.darkDays.toFixed(1) + ' d') + row('Longest comms blackout', w.noEarthDays.toFixed(1) + ' d') + row('Surface view terrain', S.patch ? S.patch.src : '-') + row('Sun angular diameter', (2 * st.sunRad / D2R).toFixed(4) + '°') + row('Ephemeris source', ephemerisSource()) + (st.moonVel ? row('Moon speed (geocentric)', Math.hypot(...st.moonVel).toFixed(3) + ' km/s') : '') + row('Julian date', jd.toFixed(3)) + horizonsRows(A, jd, row) + '</table>';
    // upcoming events
    const ev = []; for (const [k, nme] of [['sun', 'Sun'], ['earth', 'Earth']]) { let t = jd; for (let i = 0; i < 3; i++) { const e = nextEvent(A, t, k); if (!isFinite(e.dt)) break; ev.push([e.jd, `${nme}${e.up ? 'set' : 'rise'}`]); t = e.jd + 0.05; } }
    ev.sort((a, b) => a[0] - b[0]); $('resTable').innerHTML = '<table>' + ev.slice(0, 6).map(([j, n]) => row(n, new Date(msOf(j)).toISOString().slice(5, 16).replace('T', ' '))).join('') + '</table>';
  }
  // date input
  if (document.activeElement !== $('dt')) $('dt').value = new Date(msOf(jd)).toISOString().slice(0, 16);
  // charts
  drawCurves($('cvCurves'), A, jd, S.researcher, S.curveHover);
  if (S.dist) {
    const em = st.earthDist, es = Math.hypot(...st.sun.vec), ms = st.sunDist, km = (v) => Math.round(v).toLocaleString() + ' km', lt = (v) => { const s = v / 299792.458; return s < 120 ? s.toFixed(2) + ' s' : (s / 60).toFixed(1) + ' min'; };
    const rt = (r) => (r == null ? '' : (r >= 0 ? 'receding ' : 'closing ') + Math.abs(r).toFixed(2) + ' km/s'), R = st.rates || {};
    const row = (a, b, v, ref, rate) => `<div class="drow"><div><b>${a} to ${b}</b><small>light takes ${lt(v)}${rate == null ? '' : ', ' + rt(rate)}</small></div><div><b>${km(v)}</b><small>${(v / ref).toFixed(v > 2e7 ? 3 : 1)} ${v > 2e7 ? 'AU' : 'Earth-Moon distances'}</small></div></div>`;
    space.setDistances(true, [km(em) + (R.earth == null ? '' : ' · ' + rt(R.earth)), km(es) + (R.earthSun == null ? '' : ' · ' + rt(R.earthSun)), km(ms) + (R.sun == null ? '' : ' · ' + rt(R.sun))]);
    $('distOut').innerHTML = row('Earth', 'Moon', em, 384400, R.earth) + row('Earth', 'Sun', es, 149597870.7, R.earthSun) + row('Moon', 'Sun', ms, 149597870.7, R.sun);
  }
  const tk = A.key + Math.round(jd * 2); if (tk !== trackKey) { trackKey = tk; trackPts = skyTrack(A, jd, 29.5, 6); }
  // map
  if (S.mapMode === 'now' || S.heat) { if (now - (updateUI.mapT || 0) > 380) { updateUI.mapT = now; if (S.mapMode === 'now') pmap.computeNow(...sunArgs(st)); if (S.heat && (pmap !== polarMap || S.mapMode !== 'now')) polarMap.computeNow(...sunArgs(st)); if (S.heat || S.mapMode === 'now') repaintMapLight(); } }
  // MC stale?
  if (S.trMC && Math.abs(S.jd - S.mcJd) > 4) $('mcRun').textContent = 'Recalculate for this date';
  if (now - lastCards > 900 && S.pinned.length) { lastCards = now; renderCards(false); }
}
function repaintMapLight() { if (S.mapMode === 'now') pmap.paint('now'); if (S.heat) { polarMap.paint(S.mapMode); space.setHeatTexture(polarMap.texture(THREE)); } }

// ------------------------------------------------------------------ frame loop
let last = performance.now(), t0 = last, mapDrawT = 0;
function frame(nowMs) {
  const dt = Math.min(0.1, (nowMs - last) / 1000); last = nowMs; const t = (nowMs - t0) / 1000;
  if (S.speed) { S.jd = S.jd + dt * S.speed; if (S.jd > JD_MAX) S.jd = JD_MIN; if (S.jd < JD_MIN) S.jd = JD_MAX; }
  const st = state(S.jd);
  S.atmo += (S.atmoTarget - S.atmo) * Math.min(1, dt * 3);
  if (S.view === 'surface') {
    space.controls.enabled = false; surface.controls.enabled = !S.busy;
    const sk = skyFrom(S.A, st), tk = S.A.key + Math.floor(S.jd * 4);
    surface.update(dt, t, { sky: sk, A: S.A, st, jd: S.jd, atmo: S.atmo, showTracks: S.tracks, track: trackPts && { key: tk, pts: trackPts }, beams: S.beams, beacon: false });
    renderer.render(surface.scene, surface.camera);
  } else {
    space.update(dt, st, S.jd, t); renderer.render(space.scene, space.camera);
  }
  if (nowMs - lastUI > 110) { lastUI = nowMs; updateUI(nowMs); }
  if (nowMs - mapDrawT > 60) { mapDrawT = nowMs; pmap.draw($('cvMap'), { sites: SITES, selected: S.site, pinned: S.pinned.map((p) => p.site), hover: pmap.hover }); }
  requestAnimationFrame(frame);
}
function onResize() { const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w, h, false); space.resize(w, h); surface.resize(w, h); lastUI = 0; }

boot().catch((e) => { console.error(e); loadMsg('Error: ' + e.message); });
window.__app = { S, get renderer() { return renderer; }, get space() { return space; }, get surface() { return surface; }, setJd, selectSite, land, orbit, runSim };
