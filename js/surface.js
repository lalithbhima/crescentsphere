// First-person / chase surface view at the selected site. Real horizon, real Sun & Earth angular sizes,
// GPU ray-marched terrain shadows with physically-sized penumbra, no atmosphere.
import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/addons/OrbitControls.js';
import { EARTH_VS, EARTH_FS } from './space.js';
import { horizonAt } from './analysis.js';
import { R_EARTH, toBody } from './ephemeris.js';

function setPts(o, pts) {
  const g = o.geometry, a = g.getAttribute('position');
  if (!a || a.count < pts.length) { g.dispose(); o.geometry = new THREE.BufferGeometry().setFromPoints(pts); return; }
  for (let i = 0; i < pts.length; i++) a.setXYZ(i, pts[i].x, pts[i].y, pts[i].z);
  a.needsUpdate = true; g.setDrawRange(0, pts.length); g.computeBoundingSphere();
}

const SKY = 250000, D2R = Math.PI / 180;
const enu = (el, az) => new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));

const SHADE_FS = `precision highp float; precision highp int; uniform highp sampler2D uH; uniform float uSize,uN; uniform vec3 uSun; varying vec2 vUv;
float H(vec2 en){ vec2 g=(en/uSize+.5)*(uN-1.); g=clamp(g,vec2(0.),vec2(uN-1.01)); ivec2 i=ivec2(floor(g)); vec2 f=g-vec2(i);
  float a=texelFetch(uH,i,0).r,b=texelFetch(uH,i+ivec2(1,0),0).r,c=texelFetch(uH,i+ivec2(0,1),0).r,d=texelFetch(uH,i+ivec2(1,1),0).r; return mix(mix(a,b,f.x),mix(c,d,f.x),f.y); }
void main(){ vec2 en=(vUv-.5)*uSize; vec3 s=normalize(uSun); if(s.y<=0.0){ gl_FragColor=vec4(0.,0.,0.,1.); return; }
  vec2 hd=normalize(vec2(s.x,-s.z)); float tanEl=s.y/length(vec2(s.x,s.z)); float y0=H(en)+0.6; float t=14.; float mn=1e5;
  for(int i=0;i<150;i++){ vec2 p=en+hd*t; if(abs(p.x)>uSize*.5||abs(p.y)>uSize*.5) break; float curv=t*t/3474800.; float ang=((y0+t*tanEl)-(H(p)-curv))/t; mn=min(mn,ang); t*=1.034; }
  float c2=1.-s.y*s.y; float R=0.0125/max(c2,0.05); gl_FragColor=vec4(smoothstep(-R,R,mn),0.,0.,1.); }`;
const QUAD_VS = 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }';

const TERR_VS = `varying vec3 vP; varying vec3 vN; varying vec2 vUv; uniform float uSize;
void main(){ vP=position; vN=normal; vUv=position.xz*vec2(1.,-1.)/uSize+.5; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`;
const TERR_FS = `uniform sampler2D uShade,uDetail; uniform vec3 uSun,uEarthDir; uniform float uMask,uAmb,uAtmo,uSunI,uSize; uniform vec3 uSky,uFar;
varying vec3 vP; varying vec3 vN; varying vec2 vUv;
float hh(vec2 p){ return texture2D(uDetail,p*0.02).r*0.6+texture2D(uDetail,p*0.11).r*0.4; }
void main(){
  vec3 V=normalize(cameraPosition-vP); float dist=length(cameraPosition-vP); vec3 N=normalize(vN);
  float fade=exp(-dist/220.); vec2 q=vP.xz; float e=0.5;
  vec2 g=vec2(hh(q+vec2(e,0.))-hh(q-vec2(e,0.)),hh(q+vec2(0.,e))-hh(q-vec2(0.,e)))/(2.*e);
  N=normalize(N+vec3(-g.x,0.,-g.y)*(0.06*fade+0.008));
  float v=hh(q); vec3 alb=vec3(0.37,0.36,0.34)*(0.8+0.4*v);
  float bo=2.2/1024.; float sh=(texture2D(uShade,vUv).r*2.+texture2D(uShade,vUv+vec2(bo,0.)).r+texture2D(uShade,vUv-vec2(bo,0.)).r+texture2D(uShade,vUv+vec2(0.,bo)).r+texture2D(uShade,vUv-vec2(0.,bo)).r)/6.*uMask; float ndl=max(dot(N,uSun),0.); float ndv=max(dot(N,V),0.04);
  float lum=1.15*ndl/(ndl+ndv)*sh*uSunI; float eN=max(dot(N,uEarthDir),0.);
  vec3 col=alb*(lum+uAmb*(0.6+0.4*eN))+uAtmo*alb*0.5*uSky;
  col=mix(col,uSky*(0.4+0.6*uSunI*0.3),uAtmo*(1.-exp(-dist*0.00006)));
  // topography stays readable at any zoom or Sun angle: sun-independent hillshade, height tint and contour lines
  vec3 N0=normalize(vN); float hs=clamp(dot(N0,normalize(vec3(-0.45,0.78,0.42))),0.,1.), zoomK=smoothstep(120.,2500.,dist);
  float ht=clamp(vP.y/80.+0.5,0.,1.); vec3 topo=alb*(0.14+0.62*hs)*(0.6+0.4*ht);
  col=mix(col,max(col,topo),0.55+0.4*zoomK);
  float ed=max(abs(vP.x),abs(vP.z))/(uSize*0.5); col=mix(col,uFar,smoothstep(0.8,0.99,ed)*(1.-uAtmo));
  gl_FragColor=vec4(pow(col,vec3(1./2.2)),1.); }`;

function periodicNoiseTexture(size = 256) {
  const data = new Uint8Array(size * size * 4), hs = (x, y, s) => { let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 144665) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967295; };
  const val = new Float32Array(size * size);
  for (let o = 0; o < 5; o++) {
    const p = 4 << o, amp = Math.pow(0.55, o);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = (x / size) * p, fy = (y / size) * p, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = hs(ix % p, iy % p, o), b = hs((ix + 1) % p, iy % p, o), c = hs(ix % p, (iy + 1) % p, o), d = hs((ix + 1) % p, (iy + 1) % p, o);
      val[y * size + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
    }
  }
  let mn = 1e9, mx = -1e9; for (const v of val) { if (v < mn) mn = v; if (v > mx) mx = v; }
  for (let i = 0; i < val.length; i++) { const v = ((val[i] - mn) / (mx - mn)) * 255; data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = v; data[i * 4 + 3] = 255; }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.anisotropy = 8; t.needsUpdate = true; return t;
}

function buildLander() {
  const g = new THREE.Group(), gold = new THREE.MeshStandardMaterial({ color: 0xd4a72c, metalness: 0.85, roughness: 0.35 }), white = new THREE.MeshStandardMaterial({ color: 0xdcdcdc, metalness: 0.3, roughness: 0.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2b30, metalness: 0.5, roughness: 0.6 });
  const mk = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  mk(new THREE.CylinderGeometry(1.15, 1.25, 1.0, 8), gold, 0, 1.35, 0);
  mk(new THREE.CylinderGeometry(1.0, 1.0, 0.18, 8), white, 0, 1.94, 0);
  mk(new THREE.ConeGeometry(0.4, 0.7, 12, 1, true), dark, 0, 0.55, 0);
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4, lx = Math.cos(a), lz = Math.sin(a);
    const leg = mk(new THREE.CylinderGeometry(0.05, 0.06, 1.9, 6), white, lx * 1.65, 0.85, lz * 1.65); leg.rotation.set(lz * 0.5, 0, -lx * 0.5);
    mk(new THREE.CylinderGeometry(0.34, 0.38, 0.06, 12), dark, lx * 2.05, 0.03, lz * 2.05);
  }
  mk(new THREE.BoxGeometry(0.9, 0.5, 0.6), white, 0.55, 2.15, 0.2);
  // sun-tracking solar wing
  const panel = new THREE.Group(); panel.position.set(0, 2.55, 0); g.add(panel);
  mk(new THREE.CylinderGeometry(0.04, 0.04, 0.6, 6), white, 0, 2.3, 0);
  const pm = new THREE.MeshStandardMaterial({ color: 0x14246b, emissive: 0x2aa0ff, emissiveIntensity: 0, metalness: 0.6, roughness: 0.3 });
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.7, 0.05), pm); panel.add(wing);
  for (let i = -1; i <= 1; i += 2) { const fr = new THREE.Mesh(new THREE.BoxGeometry(0.03, 1.72, 0.07), white); fr.position.x = i * 0.7; panel.add(fr); }
  // Earth-pointing dish
  const dish = new THREE.Group(); dish.position.set(-0.6, 2.2, -0.3); g.add(dish);
  const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.42, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2.4), new THREE.MeshStandardMaterial({ color: 0xeeeeee, metalness: 0.4, roughness: 0.4, side: THREE.DoubleSide })); bowl.rotation.x = Math.PI / 2; dish.add(bowl);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 6), white); mast.position.y = -0.2; dish.add(mast);
  return { group: g, panel, wing, pm, dish, top: new THREE.Vector3(0, 3, 0) };
}

export function createSurface(renderer, labelRoot, tex) {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(62, 1, 0.25, 1.2e6);
  const detail = periodicNoiseTexture(), skyCol = new THREE.Color(0x6aa0ee), skyBase = new THREE.Color(0x6aa0ee);
  scene.background = new THREE.Color(0x000000);

  // stars
  const rnd = (() => { let s = 99; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const N = 9000, sp = new Float32Array(N * 3), sc = new Float32Array(N * 3), ss = new Float32Array(N);
  const gal = new THREE.Vector3(0.3, 0.8, -0.5).normalize(), a1 = new THREE.Vector3().crossVectors(gal, new THREE.Vector3(1, 0, 0)).normalize(), a2 = new THREE.Vector3().crossVectors(gal, a1);
  for (let i = 0; i < N; i++) {
    let v; const band = i > 3000;
    if (band) { const ph = rnd() * 6.2832, lat = (rnd() + rnd() + rnd() - 1.5) * 0.3 * (0.4 + rnd()); v = a1.clone().multiplyScalar(Math.cos(ph) * Math.cos(lat)).addScaledVector(a2, Math.sin(ph) * Math.cos(lat)).addScaledVector(gal, Math.sin(lat)); }
    else { const u = rnd() * 2 - 1, ph = rnd() * 6.2832, r = Math.sqrt(1 - u * u); v = new THREE.Vector3(r * Math.cos(ph), u, r * Math.sin(ph)); }
    sp.set([v.x * 700000, v.y * 700000, v.z * 700000], i * 3);
    const b = band ? 0.2 + rnd() * 0.3 : 0.3 + Math.pow(rnd(), 3) * 0.7, t = rnd(); sc.set([b * (0.8 + 0.2 * t), b * 0.9, b * (1.05 - 0.3 * t)], i * 3); ss[i] = band ? 1 + rnd() * 0.6 : 1 + Math.pow(rnd(), 6) * 2.4;
  }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3)); sg.setAttribute('color', new THREE.BufferAttribute(sc, 3)); sg.setAttribute('size', new THREE.BufferAttribute(ss, 1));
  const starMat = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, uniforms: { uVis: { value: 1 } }, vertexShader: 'attribute float size; varying vec3 vC; void main(){ vC=color; gl_PointSize=size; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }', fragmentShader: 'uniform float uVis; varying vec3 vC; void main(){ gl_FragColor=vec4(pow(vC,vec3(1./2.2)),uVis); }', vertexColors: true });
  const stars = new THREE.Points(sg, starMat); stars.frustumCulled = false; stars.renderOrder = -5; scene.add(stars);

  // Sun
  const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(SKY * Math.tan(0.2666 * D2R), 24, 12), new THREE.MeshBasicMaterial({ color: 0xfff6dd, fog: false })); scene.add(sunMesh);
  const gc = document.createElement('canvas'); gc.width = gc.height = 256; { const g = gc.getContext('2d'), gr = g.createRadialGradient(128, 128, 0, 128, 128, 128); gr.addColorStop(0, 'rgba(255,245,215,1)'); gr.addColorStop(0.05, 'rgba(255,235,190,.9)'); gr.addColorStop(0.25, 'rgba(255,200,120,.22)'); gr.addColorStop(1, 'rgba(255,170,80,0)'); g.fillStyle = gr; g.fillRect(0, 0, 256, 256); }
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(gc), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false })); glow.scale.setScalar(SKY * 0.22); scene.add(glow);
  const sunLight = new THREE.DirectionalLight(0xffffff, 3.2), earthLight = new THREE.DirectionalLight(0x9ec3ff, 0.18), amb = new THREE.AmbientLight(0x8899bb, 0.05);
  scene.add(sunLight, earthLight, amb);

  // Earth in the sky
  const eU = { uDay: { value: tex.dayT }, uNight: { value: tex.nightT }, uSpec: { value: tex.specT }, uCloud: { value: tex.cloudT }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uTime: { value: 0 } };
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), new THREE.ShaderMaterial({ uniforms: eU, vertexShader: EARTH_VS, fragmentShader: EARTH_FS })); earth.matrixAutoUpdate = false; scene.add(earth);

  // terrain
  const terrU = { uFar: { value: new THREE.Vector3(0.1, 0.1, 0.1) }, uShade: { value: null }, uDetail: { value: detail }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uEarthDir: { value: new THREE.Vector3(0, 1, 0) }, uMask: { value: 1 }, uAmb: { value: 0.012 }, uAtmo: { value: 0 }, uSunI: { value: 1.55 }, uSky: { value: skyCol }, uSize: { value: 20000 } };
  const terrMat = new THREE.ShaderMaterial({ uniforms: terrU, vertexShader: TERR_VS, fragmentShader: TERR_FS });
  let terrain = null, patch = null, heightTex = null;
  const shadeRT = new THREE.WebGLRenderTarget(1024, 1024, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  const shadeU = { uH: { value: null }, uSize: { value: 20000 }, uN: { value: 321 }, uSun: { value: new THREE.Vector3(0, 1, 0) } };
  const shadeScene = new THREE.Scene(), shadeCam = new THREE.Camera();
  shadeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms: shadeU, vertexShader: QUAD_VS, fragmentShader: SHADE_FS, depthTest: false })));
  terrU.uShade.value = shadeRT.texture;
  let lastShadeDir = new THREE.Vector3(9, 9, 9);

  // far ground + horizon wall
  const disc = new THREE.Mesh((() => { const sh = new THREE.Shape(), R = 62000, q = 9990; sh.moveTo(-R, -R); sh.lineTo(R, -R); sh.lineTo(R, R); sh.lineTo(-R, R); sh.closePath(); const hole = new THREE.Path(); hole.moveTo(-q, -q); hole.lineTo(-q, q); hole.lineTo(q, q); hole.lineTo(q, -q); hole.closePath(); sh.holes.push(hole); return new THREE.ShapeGeometry(sh); })(), new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide })); disc.rotation.x = -Math.PI / 2; disc.position.y = -2; scene.add(disc);
  const RING = 60000, RS = 180, rpos = new Float32Array(RS * 2 * 3), rcol = new Float32Array(RS * 2 * 3), ridx = [];
  for (let i = 0; i < RS; i++) { const a = (i / RS) * 2 * Math.PI; rpos.set([RING * Math.sin(a), -40, -RING * Math.cos(a), RING * Math.sin(a), 0, -RING * Math.cos(a)], i * 6); const j = (i + 1) % RS; ridx.push(i * 2, i * 2 + 1, j * 2, j * 2, i * 2 + 1, j * 2 + 1); }
  const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.BufferAttribute(rpos, 3)); rg.setAttribute('color', new THREE.BufferAttribute(rcol, 3)); rg.setIndex(ridx);
  const ring = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })); ring.frustumCulled = false; scene.add(ring);
  let horizon = null;

  // lander
  const L = buildLander(); scene.add(L.group);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.6, 90, 14, 1, true), new THREE.MeshBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })); beam.position.y = 45; scene.add(beam);
  const shadowMeshes = [], shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6, depthWrite: false });
  L.group.traverse((o) => { if (o.isMesh) { const m = new THREE.Mesh(o.geometry, shadowMat); m.matrixAutoUpdate = false; m.frustumCulled = false; scene.add(m); shadowMeshes.push([m, o]); } });
  const commGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, 1)]);
  const comm = new THREE.Line(commGeo, new THREE.LineDashedMaterial({ color: 0x40e0ff, dashSize: 14, gapSize: 9, transparent: true, opacity: 0.95 })); scene.add(comm);
  const sunRay = new THREE.Line(commGeo.clone(), new THREE.LineDashedMaterial({ color: 0xffd166, dashSize: 14, gapSize: 9, transparent: true, opacity: 0.8 })); scene.add(sunRay);

  // sky tracks
  const trackSun = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.8, fog: false })), trackEarth = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.8, fog: false }));
  const dayDotsS = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffd166, size: 5, sizeAttenuation: false, fog: false })), dayDotsE = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0x4cc9f0, size: 5, sizeAttenuation: false, fog: false }));
  const tracks = new THREE.Group(); tracks.add(trackSun, trackEarth, dayDotsS, dayDotsE); scene.add(tracks);

  // scatter pillars
  let scatter = null;

  // labels
  const labels = [];
  const mkLabel = (text, pos, cls) => { const el = document.createElement('div'); el.className = 'wlabel ' + cls; el.textContent = text; labelRoot.appendChild(el); const o = { el, pos, show: true }; labels.push(o); return o; };
  const landerLbl = mkLabel('LANDER', new THREE.Vector3(0, 6, 0), 'lander');
  const compass = [['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([t, a]) => mkLabel(t, new THREE.Vector3(8000 * Math.sin(a * D2R), 60, -8000 * Math.cos(a * D2R)), 'compass'));
  const sunLbl = mkLabel('SUN', new THREE.Vector3(), 'sunl'), earthLbl = mkLabel('EARTH', new THREE.Vector3(), 'earthl');
  const tmp = new THREE.Vector3();
  let visible = false;
  function updateLabels() {
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    for (const l of labels) {
      if (!visible || !l.show) { l.el.style.display = 'none'; continue; }
      tmp.copy(l.pos).project(camera);
      if (tmp.z > 1 || Math.abs(tmp.x) > 1.02 || Math.abs(tmp.y) > 1.02) { l.el.style.display = 'none'; continue; }
      l.el.style.display = 'block'; l.el.style.transform = `translate(${(tmp.x * 0.5 + 0.5) * w}px,${(-tmp.y * 0.5 + 0.5) * h}px)`;
    }
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08; controls.enablePan = false; controls.minDistance = 4; controls.maxDistance = 18000; controls.maxPolarAngle = Math.PI / 2 - 0.02; controls.rotateSpeed = 0.6; controls.zoomSpeed = 1.2;
  let viewMode = 'orbit';

  function setSite(p, horizonProfile) {
    patch = p; horizon = horizonProfile;
    if (terrain) { scene.remove(terrain); terrain.geometry.dispose(); }
    const n = p.n, size = p.sizeM, pos = new Float32Array(n * n * 3), idx = new Uint32Array((n - 1) * (n - 1) * 6);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const o = (j * n + i) * 3; pos[o] = (i / (n - 1) - 0.5) * size; pos[o + 1] = p.h[j * n + i]; pos[o + 2] = -((j / (n - 1) - 0.5) * size); }
    let k = 0; for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i, b = a + 1, c = a + n, d = c + 1; idx[k++] = a; idx[k++] = b; idx[k++] = c; idx[k++] = b; idx[k++] = d; idx[k++] = c; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1)); g.computeVertexNormals();
    terrain = new THREE.Mesh(g, terrMat); terrain.frustumCulled = false; scene.add(terrain);
    if (heightTex) heightTex.dispose();
    heightTex = new THREE.DataTexture(new Float32Array(p.h), n, n, THREE.RedFormat, THREE.FloatType); heightTex.minFilter = heightTex.magFilter = THREE.NearestFilter; heightTex.needsUpdate = true;
    shadeU.uH.value = heightTex; shadeU.uSize.value = size; shadeU.uN.value = n; terrU.uSize.value = size; lastShadeDir.set(9, 9, 9);
    // flat far-ground colour matched to terrain
    disc.position.y = -1;
    L.group.position.set(0, p.at(0, 0), 0); beam.position.y = p.at(0, 0) + 45;
  }

  function setView(mode, sunAz = 0) {
    viewMode = mode; const gy = patch ? patch.at(0, 0) : 0;
    if (mode === 'orbit') {
      const az = sunAz - Math.PI / 2; controls.enableZoom = true; controls.minDistance = 4; controls.target.set(0, gy + 1.8, 0);
      camera.position.set(Math.sin(az) * 19, gy + 6, -Math.cos(az) * 19);
    } else {
      controls.enableZoom = false; controls.minDistance = 0.01; controls.maxDistance = 0.02;
      const d = enu(0.04, mode === 'sun' ? sunAz : sunAz + Math.PI);
      camera.position.set(-d.x * 13 + d.z * 5, gy + 2.2, -d.z * 13 - d.x * 5); controls.target.copy(camera.position).addScaledVector(d, 0.015);
      camera.lookAt(controls.target);
    }
    controls.update();
  }
  function lookAt(dir) { // from the eye position
    controls.enableZoom = false; controls.minDistance = 0.01; controls.maxDistance = 0.02; viewMode = 'eye';
    const gy = patch ? patch.at(0, 0) : 0, dn = dir.clone().normalize(), hx = Math.hypot(dn.x, dn.z) || 1;
    camera.position.set(-(dn.x / hx) * 13 + (dn.z / hx) * 5, gy + 2.2, -(dn.z / hx) * 13 - (dn.x / hx) * 5); controls.target.copy(camera.position).addScaledVector(dn, 0.015); controls.update();
  }

  const proj = new THREE.Matrix4();
  function litAtLander(sunEl, sunAz) {
    if (!patch || sunEl <= 0) return 0;
    const dx = Math.sin(sunAz), dn = Math.cos(sunAz), t = Math.tan(sunEl), y0 = patch.at(0, 0) + 1.5; let mn = 1e9;
    for (let s = 10; s < 9500; s *= 1.05) { const ang = (y0 + s * t - (patch.at(dx * s, dn * s) - s * s / 3474800)) / s; if (ang < mn) mn = ang; }
    return Math.min(1, Math.max(0, (mn + 0.0047) / 0.0094));
  }

  let lastTrackKey = '';
  /** ctx: { sky, A, st, jd, atmo, showTracks, track, powerNote } */
  function update(dt, t, ctx) {
    if (!patch) return;
    const { sky, A, st } = ctx;
    const sunEl = sky.sun.el, sunAz = sky.sun.az, sd = enu(sunEl, sunAz), ed = enu(sky.earth.el, sky.earth.az);
    const loc = (v) => { const b = toBody(st.mf, v), q = A.b; return new THREE.Vector3(b[0] * q.E[0] + b[1] * q.E[1] + b[2] * q.E[2], b[0] * q.U[0] + b[1] * q.U[1] + b[2] * q.U[2], -(b[0] * q.N[0] + b[1] * q.N[1] + b[2] * q.N[2])); };
    // Sun
    const sunVisAngle = sunEl + (sky.sunRad || 0.2666 * D2R) - sky.sun.hz, mask = Math.min(1, Math.max(0, (sunVisAngle) / (0.5 * D2R)));
    sunMesh.position.copy(sd).multiplyScalar(SKY); glow.position.copy(sd).multiplyScalar(SKY);
    sunMesh.visible = glow.visible = true; glow.material.opacity = 1 - ctx.atmo * 0.35;
    terrU.uSun.value.copy(sd); terrU.uEarthDir.value.copy(ed); terrU.uMask.value = mask; terrU.uAtmo.value = ctx.atmo;
    // Earth
    const D = 200000, eDist = st.earthDist, rE = D * (R_EARTH / eDist);
    const ex = loc(st.ef.x), ep = loc(st.ef.p), ey = loc(st.ef.y);
    earth.matrix.makeBasis(ex.clone().multiplyScalar(rE), ep.clone().multiplyScalar(rE), ey.clone().negate().multiplyScalar(rE)).setPosition(ed.clone().multiplyScalar(D));
    eU.uSun.value.copy(sd); eU.uTime.value = t; earth.visible = true;
    // lights
    const litL = litAtLander(sunEl, sunAz) * (sunEl + (sky.sunRad || 0.2666 * D2R) > sky.sun.hz ? 1 : 0);
    sunLight.position.copy(sd).multiplyScalar(100).add(L.group.position); sunLight.target.position.copy(L.group.position); sunLight.target.updateMatrixWorld();
    sunLight.intensity = 3.2 * litL * (1 - 0.35 * ctx.atmo); earthLight.position.copy(ed).multiplyScalar(100).add(L.group.position); earthLight.target.position.copy(L.group.position); earthLight.target.updateMatrixWorld();
    amb.intensity = 0.05 + ctx.atmo * 0.9; amb.color.set(ctx.atmo > 0 ? 0xbcd2ff : 0x8899bb);
    // atmosphere compare
    const day = Math.max(0.05, Math.min(1, Math.sin(Math.max(sunEl, 0)) * 3 + 0.12)), sk = skyBase.clone().multiplyScalar(day);
    terrU.uSky.value.copy(sk); scene.background.copy(sk).multiplyScalar(ctx.atmo); starMat.uniforms.uVis.value = 1 - ctx.atmo * 0.97;
    scene.fog = ctx.atmo > 0.01 ? new THREE.FogExp2(sk.getHex(), 0.00006 * ctx.atmo) : null;
    // shade map
    if (sd.distanceTo(lastShadeDir) > 0.00035) { lastShadeDir.copy(sd); shadeU.uSun.value.copy(sd); renderer.setRenderTarget(shadeRT); renderer.render(shadeScene, shadeCam); renderer.setRenderTarget(null); }
    // lander animation
    L.panel.lookAt(L.panel.getWorldPosition(new THREE.Vector3()).add(sd));
    const pf = litL * (0.35 + 0.65 * Math.min(1, Math.max(0, sunEl / (10 * D2R)))); L.pm.emissiveIntensity = pf * 0.7;
    L.dish.lookAt(L.dish.getWorldPosition(new THREE.Vector3()).add(ed));
    const gy = L.group.position.y, dishW = L.dish.getWorldPosition(new THREE.Vector3()), panW = L.panel.getWorldPosition(new THREE.Vector3());
    const earthUp = sky.earth.el > sky.earth.hz; comm.visible = earthUp && ctx.beams; sunRay.visible = litL > 0.05 && ctx.beams;
    setPts(comm, [dishW, dishW.clone().addScaledVector(ed, 2500)]); comm.computeLineDistances(); comm.material.dashOffset -= dt * 6;
    setPts(sunRay, [panW, panW.clone().addScaledVector(sd, 1800)]); sunRay.computeLineDistances(); sunRay.material.dashOffset -= dt * 6;
    beam.material.opacity = 0.1 + 0.08 * Math.sin(t * 3); beam.visible = ctx.beacon;
    // planar shadows
    const Ly = Math.max(sd.y, 0.16), lit2 = sunEl + (sky.sunRad || 0.2666 * D2R) > sky.sun.hz && sunEl > 0;
    proj.set(1, -sd.x / Ly, 0, 0, 0, 0, 0, gy + 0.05, 0, -sd.z / Ly, 1, 0, 0, 0, 0, 1);
    for (const [m, o] of shadowMeshes) { m.visible = lit2 && litL > 0.5; m.matrix.multiplyMatrices(proj, o.matrixWorld); }
    // horizon wall
    const col = rg.attributes.color, pos = rg.attributes.position;
    const sE = Math.max(0, Math.sin(sunEl)), lumFar = 1.15 * sE / (sE + 0.15) * terrU.uSunI.value * mask * 0.36 + 0.004, farC = [lumFar * 1.03, lumFar, lumFar * 0.94];
    terrU.uFar.value.set(farC[0], farC[1], farC[2]);
    for (let i = 0; i < RS; i++) {
      const a = (i / RS) * 2 * Math.PI, hz = horizonAt(horizon, a), top = RING * Math.tan(hz) + 2;
      pos.setY(i * 2 + 1, top); col.setXYZ(i * 2, farC[0] * 0.95, farC[1] * 0.95, farC[2] * 0.95); col.setXYZ(i * 2 + 1, farC[0] * 0.8, farC[1] * 0.8, farC[2] * 0.8);
    }
    pos.needsUpdate = col.needsUpdate = true;
    (ring.material.color).set(0xffffff); ring.material.fog = true;
    disc.material.color.setRGB(farC[0], farC[1], farC[2]);
    // tracks
    tracks.visible = ctx.showTracks && !!ctx.track;
    if (tracks.visible) {
      const key = ctx.track.key; if (key !== lastTrackKey) {
        lastTrackKey = key; const sp = [], ep = [], sd2 = [], ed2 = [];
        ctx.track.pts.forEach((p, i) => { const s = enu(p.sun.el, p.sun.az).multiplyScalar(SKY * 0.98), e = enu(p.earth.el, p.earth.az).multiplyScalar(SKY * 0.97); sp.push(s); ep.push(e); if (i % 4 === 0) { sd2.push(s); ed2.push(e); } });
        setPts(trackSun, sp); setPts(trackEarth, ep); setPts(dayDotsS, sd2); setPts(dayDotsE, ed2);
      }
    }
    // camera: keep above terrain, track lander in orbit mode
    controls.update();
    if (viewMode === 'orbit') { const h = patch.at(camera.position.x, -camera.position.z) + 1.4; if (camera.position.y < h) camera.position.y = h; }
    // labels
    landerLbl.pos.set(0, gy + 6, 0); landerLbl.show = ctx.beacon && camera.position.length() > 8;
    sunLbl.pos.copy(sd).multiplyScalar(SKY * 0.9); sunLbl.show = sunEl > -0.02; earthLbl.pos.copy(ed).multiplyScalar(SKY * 0.9); earthLbl.show = sky.earth.el > -0.02;
    updateLabels();
  }

  function setMonteCarlo(res, show = true) {
    if (scatter) { scene.remove(scatter); scatter.geometry.dispose(); scatter = null; }
    if (!res || !patch) return;
    const n = Math.min(res.trials.length, 1800), pos = new Float32Array(n * 6), col = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const tr = res.trials[i], e = tr.e * 1000, nn = tr.n * 1000; if (Math.abs(e) > 9500 || Math.abs(nn) > 9500) continue;
      const y = patch.at(e, nn), c = tr.ok ? [0.3, 1, 0.65] : tr.lit ? [1, 0.55, 0.25] : [1, 0.3, 0.45], hgt = 25 + Math.min(100, res.sigma * 18);
      pos.set([e, y, -nn, e, y + hgt, -nn], i * 6); col.set([...c, c[0] * 0.15, c[1] * 0.15, c[2] * 0.15], i * 6);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    scatter = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })); scatter.frustumCulled = false; scatter.visible = show; scene.add(scatter);
  }

  function resize(w, h) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  return {
    shadeRT, terrU, scene, camera, controls, update, resize, setSite, setView, lookAt, setMonteCarlo, enu,
    setVisible(v) { visible = v; controls.enabled = v; }, get patch() { return patch; }, get viewMode() { return viewMode; },
  };
}
