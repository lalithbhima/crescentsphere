// True-scale Earth–Moon–Sun scene. Units: 1 unit = 1000 km. Sun is placed on its true direction at a
// reduced distance with its true angular size (parallax across the Earth–Moon system is negligible).
import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/addons/OrbitControls.js';
import { R_MOON, R_EARTH, state, moonEcl } from './ephemeris.js';
import { CATS } from './sites.js';

function setPts(o, pts) {
  const g = o.geometry, a = g.getAttribute('position');
  if (!a || a.count < pts.length) { g.dispose(); o.geometry = new THREE.BufferGeometry().setFromPoints(pts); return; }
  for (let i = 0; i < pts.length; i++) a.setXYZ(i, pts[i].x, pts[i].y, pts[i].z);
  a.needsUpdate = true; g.setDrawRange(0, pts.length); g.computeBoundingSphere();
}

const RM = R_MOON / 1000, RE = R_EARTH / 1000, SUN_DIST = 6000, SUN_R = SUN_DIST * Math.tan(0.2666 * Math.PI / 180);
const conv = (v) => new THREE.Vector3(v[0], v[2], -v[1]);
export const bodyToLocal = (b) => new THREE.Vector3(b[0], b[2], -b[1]);
export function basisMatrix(f, pos) {
  const m = new THREE.Matrix4().makeBasis(conv(f.x), conv(f.p), conv(f.y).negate());
  m.setPosition(pos); return m;
}
const ease = (t) => t * t * (3 - 2 * t);

function glowTexture(inner = 'rgba(255,240,200,1)', mid = 'rgba(255,190,90,0.35)') {
  const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
  const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, inner); gr.addColorStop(0.12, inner); gr.addColorStop(0.35, mid); gr.addColorStop(1, 'rgba(255,160,60,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 256); return new THREE.CanvasTexture(c);
}
function pinTexture(color) {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.beginPath(); g.arc(32, 32, 20, 0, 7); g.fillStyle = 'rgba(0,0,0,.55)'; g.fill();
  g.lineWidth = 5; g.strokeStyle = color; g.stroke();
  g.beginPath(); g.arc(32, 32, 8, 0, 7); g.fillStyle = color; g.fill();
  return new THREE.CanvasTexture(c);
}
function ringTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  g.lineWidth = 6; g.strokeStyle = '#fff'; g.beginPath(); g.arc(64, 64, 52, 0, 7); g.stroke();
  return new THREE.CanvasTexture(c);
}

export const EARTH_VS = `varying vec3 vN; varying vec3 vP; varying vec2 vUv; varying vec3 vO;
void main(){ vUv=uv; vO=position; vN=normalize(mat3(modelMatrix)*normal); vec4 w=modelMatrix*vec4(position,1.); vP=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`;
export const EARTH_FS = `uniform sampler2D uDay,uNight,uSpec,uCloud; uniform vec3 uSun; uniform float uTime;
varying vec3 vN; varying vec3 vP; varying vec2 vUv; varying vec3 vO;
float eh(vec3 p){ return fract(sin(dot(p,vec3(12.9898,78.233,37.719)))*43758.5453); }
float en(vec3 p){ vec3 i=floor(p),f=fract(p); f=f*f*(3.-2.*f); return mix(mix(mix(eh(i),eh(i+vec3(1,0,0)),f.x),mix(eh(i+vec3(0,1,0)),eh(i+vec3(1,1,0)),f.x),f.y),mix(mix(eh(i+vec3(0,0,1)),eh(i+vec3(1,0,1)),f.x),mix(eh(i+vec3(0,1,1)),eh(i+vec3(1,1,1)),f.x),f.y),f.z); }
float clouds(vec3 p){ float a=0.,w=.5; for(int i=0;i<5;i++){ a+=w*en(p); p=p*2.03+vec3(1.7,9.2,3.1); w*=.5; } return smoothstep(.46,.78,a); }
void main(){
  vec3 N=normalize(vN), V=normalize(cameraPosition-vP); float ndl=dot(N,uSun);
  vec3 day=texture2D(uDay,vUv).rgb; float cl=clouds(normalize(vO)*3.2+vec3(uTime*0.004,0.,0.))*0.85; float sp=texture2D(uSpec,vUv).r;
  vec3 H=normalize(uSun+V); float s=pow(max(dot(N,H),0.),70.)*sp*1.1;
  vec3 dc=mix(day,vec3(1.),cl*0.85)*max(ndl,0.)*1.35+vec3(s)*step(0.,ndl);
  vec3 nc=texture2D(uNight,vUv,2.5).rgb*(1.-cl*0.75)*1.6;
  float lit=smoothstep(-0.06,0.22,ndl);
  vec3 col=mix(nc,dc,lit);
  float fr=pow(1.-max(dot(N,V),0.),3.); col+=vec3(0.25,0.5,1.)*fr*(0.25+0.9*smoothstep(-0.3,0.5,ndl))*0.9;
  gl_FragColor=vec4(pow(col,vec3(1./2.2)),1.);
}`;
const ATMO_FS = `uniform vec3 uSun; varying vec3 vN; varying vec3 vP;
void main(){ vec3 N=normalize(vN), V=normalize(cameraPosition-vP); float d=1.+dot(N,V); float i=pow(clamp(d,0.,1.),3.2);
  float l=smoothstep(-0.35,0.5,dot(normalize(vP),uSun)); gl_FragColor=vec4(vec3(0.3,0.55,1.)*i*(0.15+l)*1.6,i*(0.15+l)); }`;
const HEAT_VS = `varying vec3 vL; void main(){ vL=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`;
const HEAT_FS = `uniform sampler2D uMap; uniform float uHalf,uR,uOp; varying vec3 vL;
void main(){ vec3 n=normalize(vL); float lat=asin(n.y), lon=atan(-n.z,n.x); float colat=lat+1.5707963;
  float r=2.*uR*tan(colat/2.); vec2 xy=vec2(r*sin(lon),r*cos(lon)); vec2 uv=xy/(2.*uHalf)+.5;
  if(uv.x<0.||uv.x>1.||uv.y<0.||uv.y>1.) discard;
  float edge=smoothstep(uHalf*0.99,uHalf*0.82,length(xy)); vec4 t=texture2D(uMap,uv);
  gl_FragColor=vec4(t.rgb,t.a*uOp*edge); }`;
const TRAIL_VS = `attribute float aT; attribute float aSeed; attribute vec3 aCol; varying float vT; varying float vS; varying vec3 vC;
void main(){ vT=aT; vS=aSeed; vC=aCol; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }`;
const TRAIL_FS = `uniform float uTime; varying float vT; varying float vS; varying vec3 vC;
void main(){ float head=fract(uTime*0.28+vS); float d=head-vT; d+= d<0.?1.:0.; float tr=exp(-d*7.)*step(d,0.7);
  float a=0.035+0.45*tr; gl_FragColor=vec4(mix(vC,vec3(1.),tr*0.25),a); }`;

export async function createSpace(renderer, labelRoot) {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(42, 1, 0.001, 40000);
  const TL = new THREE.TextureLoader(), load = (u, srgb = true) => TL.loadAsync(u).then((t) => { if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t; });
  const [dayT, nightT, specT, cloudT, moonT] = await Promise.all([
    load('tex/earth_atmos_2048.jpg'), load('tex/earth_lights_2048.png'), load('tex/earth_specular_2048.jpg', false),
    load('tex/earth_clouds_1024.png', false), load('tex/moon_color_4k.jpg'),
  ]);
  // ---- real lunar topography: NASA LOLA (LRO) elevation, 2880x1440, h_km = DN*0.0005 - 10.19 relative to the 1737.4 km sphere
  const HW = 2880, HH = 1440, HGT = new Float32Array(HW * HH), EX = 6; // EX = vertical exaggeration so relief is visible from orbit
  await new Promise((res) => { const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = HW; c.height = HH; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0); const d = g.getImageData(0, 0, HW, HH).data; for (let i = 0; i < HW * HH; i++) HGT[i] = ((d[i * 4] << 8) | d[i * 4 + 1]) * 0.0005 - 10.19; res(); }; im.onerror = res; im.src = 'tex/ldem_2880.png'; });
  const hAt = (lat, lon) => { // km, bilinear; lon -180..180 (image centre = 0)
    const fx = (((lon + 180) % 360 + 360) % 360) / 360 * HW - 0.5, fy = Math.max(0, Math.min(HH - 1.001, (90 - lat) / 180 * HH - 0.5)), x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, X0 = (x0 + HW) % HW, X1 = (x0 + 1 + HW) % HW;
    return (HGT[y0 * HW + X0] * (1 - tx) + HGT[y0 * HW + X1] * tx) * (1 - ty) + (HGT[(y0 + 1) * HW + X0] * (1 - tx) + HGT[(y0 + 1) * HW + X1] * tx) * ty;
  };
  const surfR = (lat, lon) => RM + hAt(lat, lon) * EX * 0.001;
  function moonGeometry(offset = 0, W = 768, Hs = 384) {
    const g = new THREE.SphereGeometry(1, W, Hs), p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) { const lon = (uv.getX(i) - 0.5) * 360, lat = (uv.getY(i) - 0.5) * 180, r = RM + hAt(lat, lon) * EX * 0.001 + offset; p.setXYZ(i, p.getX(i) * r, p.getY(i) * r, p.getZ(i) * r); }
    g.computeVertexNormals(); const n = g.attributes.normal; // stitch the texture seam so shading is continuous
    for (let j = 0; j <= Hs; j++) { const a = j * (W + 1), b = a + W, x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b), l = Math.hypot(x, y, z) || 1; n.setXYZ(a, x / l, y / l, z / l); n.setXYZ(b, x / l, y / l, z / l); }
    return g;
  }
  for (const t of [dayT, nightT, specT, cloudT, moonT]) { t.wrapS = THREE.RepeatWrapping; }

  // ---- stars
  {
    const rnd = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
    const N = 14000, pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N);
    const gal = new THREE.Vector3(0.18, 0.92, 0.34).normalize(), a1 = new THREE.Vector3().crossVectors(gal, new THREE.Vector3(0, 0, 1)).normalize(), a2 = new THREE.Vector3().crossVectors(gal, a1);
    for (let i = 0; i < N; i++) {
      let v; const band = i > 4000;
      if (band) { const ph = rnd() * 6.2832, lat = (rnd() + rnd() + rnd() - 1.5) * 0.28 * (0.5 + rnd()); v = a1.clone().multiplyScalar(Math.cos(ph) * Math.cos(lat)).addScaledVector(a2, Math.sin(ph) * Math.cos(lat)).addScaledVector(gal, Math.sin(lat)); }
      else { const u = rnd() * 2 - 1, ph = rnd() * 6.2832, r = Math.sqrt(1 - u * u); v = new THREE.Vector3(r * Math.cos(ph), u, r * Math.sin(ph)); }
      pos.set([v.x * 15000, v.y * 15000, v.z * 15000], i * 3);
      const t = rnd(), b = band ? 0.25 + rnd() * 0.35 : 0.35 + Math.pow(rnd(), 3) * 0.65;
      col.set([b * (0.75 + 0.25 * t), b * (0.85 + 0.1 * t), b * (1 - 0.25 * t)], i * 3);
      size[i] = band ? 1 + rnd() * 0.8 : 1 + Math.pow(rnd(), 6) * 2.6;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('size', new THREE.BufferAttribute(size, 1));
    const m = new THREE.ShaderMaterial({
      vertexColors: true, transparent: true, depthWrite: false,
      vertexShader: 'attribute float size; varying vec3 vC; void main(){ vC=color; gl_PointSize=size; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: 'varying vec3 vC; void main(){ gl_FragColor=vec4(pow(vC,vec3(1./2.2)),1.); }',
    });
    const pts = new THREE.Points(g, m); pts.frustumCulled = false; pts.renderOrder = -10; scene.add(pts);
  }

  // ---- Sun
  const sunGroup = new THREE.Group(); scene.add(sunGroup);
  const sunMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: 'varying vec3 vN; varying vec3 vL; void main(){ vN=normalize(normalMatrix*normal); vL=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `uniform float uTime; varying vec3 vN; varying vec3 vL;
      float h(vec3 p){ return fract(sin(dot(p,vec3(12.9898,78.233,37.719)))*43758.5453); }
      float n(vec3 p){ vec3 i=floor(p),f=fract(p); f=f*f*(3.-2.*f); return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+vec3(1,1,1)),f.x),f.y),f.z); }
      void main(){ vec3 p=normalize(vL)*6.; float g=n(p*2.+uTime*0.05)*0.6+n(p*5.-uTime*0.08)*0.4; float mu=clamp(vN.z,0.,1.);
        vec3 c=mix(vec3(1.,.45,.1),vec3(1.,.93,.7),mu*0.7+g*0.4); gl_FragColor=vec4(c*(1.2+g*0.3),1.); }`,
  });
  const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(SUN_R, 32, 16), sunMat); sunGroup.add(sunDisc);
  const glowT = glowTexture();
  const glow1 = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowT, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  glow1.scale.setScalar(SUN_R * 9); sunGroup.add(glow1);
  const glow2 = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowT, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.4 }));
  glow2.scale.setScalar(SUN_R * 24); sunGroup.add(glow2);
  const sunLight = new THREE.DirectionalLight(0xffffff, 3.4); scene.add(sunLight, sunLight.target);
  scene.add(new THREE.AmbientLight(0x6688cc, 0.06));

  // ---- Earth
  const earthU = { uDay: { value: dayT }, uNight: { value: nightT }, uSpec: { value: specT }, uCloud: { value: cloudT }, uSun: { value: new THREE.Vector3(1, 0, 0) }, uTime: { value: 0 } };
  const earth = new THREE.Mesh(new THREE.SphereGeometry(RE, 128, 64), new THREE.ShaderMaterial({ uniforms: earthU, vertexShader: EARTH_VS, fragmentShader: EARTH_FS }));
  scene.add(earth);
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(RE * 1.035, 96, 48), new THREE.ShaderMaterial({ uniforms: { uSun: earthU.uSun }, vertexShader: EARTH_VS, fragmentShader: ATMO_FS, side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  scene.add(atmo);

  // ---- Moon
  moonT.anisotropy = 8;
  const moon = new THREE.Mesh(moonGeometry(0), new THREE.MeshStandardMaterial({ map: moonT, bumpMap: moonT, bumpScale: 1.2, roughness: 1, metalness: 0 }));
  moon.matrixAutoUpdate = false; scene.add(moon);
  const heatU = { uMap: { value: null }, uHalf: { value: 200 }, uR: { value: R_MOON }, uOp: { value: 0.85 } };
  const heat = new THREE.Mesh(moonGeometry(RM * 0.0015, 768, 384), new THREE.ShaderMaterial({ uniforms: heatU, vertexShader: HEAT_VS, fragmentShader: HEAT_FS, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  heat.visible = false; moon.add(heat);
  // Whole-Moon live illumination: Sun and Earth visibility ray-marched through the real LOLA heightfield (mountains and crater walls cast shadows)
  const hTex = new THREE.DataTexture(HGT, HW, HH, THREE.RedFormat, THREE.FloatType); hTex.minFilter = hTex.magFilter = THREE.NearestFilter; hTex.wrapS = THREE.RepeatWrapping; hTex.needsUpdate = true;
  const gheatU = { uSun: { value: new THREE.Vector3(1, 0, 0) }, uEarth: { value: new THREE.Vector3(1, 0, 0) }, uOp: { value: 0.8 }, uH: { value: hTex } };
  const GH_FS = `precision highp float; uniform sampler2D uH; uniform vec3 uSun,uEarth; uniform float uOp; varying vec3 vP; varying vec3 vN;
  const float PI=3.14159265, R0=1737.4; const vec2 SZ=vec2(2880.,1440.);
  float tx(vec2 i){ return texture2D(uH,(vec2(mod(i.x,SZ.x),clamp(i.y,0.,SZ.y-1.))+.5)/SZ).r; }
  float H(vec3 d){ float lat=asin(clamp(d.y,-1.,1.)), lon=atan(-d.z,d.x); vec2 f=vec2(lon/(2.*PI)+.5,.5-lat/PI)*SZ-.5; vec2 i=floor(f), t=f-i; return mix(mix(tx(i),tx(i+vec2(1,0)),t.x),mix(tx(i+vec2(0,1)),tx(i+vec2(1,1)),t.x),t.y); }
  float vis(vec3 n, float h0, vec3 L){
    float up=dot(n,L); if(up<-0.0046) return 0.;
    vec3 p0=n*(R0+h0+0.05); float s=2.5;
    for(int k=0;k<40;k++){ s*=1.16; vec3 q=p0+L*s; float r=length(q); if(r<R0+H(q/r)) return 0.; if(r>R0+12.) break; }
    return smoothstep(-0.0046,0.003,up);
  }
  void main(){ vec3 n=normalize(vP); float h0=H(n); float s=vis(n,h0,normalize(uSun)), e=vis(n,h0,normalize(uEarth));
    vec3 c=mix(mix(vec3(0.055,0.07,0.2),vec3(0.3,0.75,0.94),e),mix(vec3(1.,0.82,0.4),vec3(0.27,0.92,0.51),e),s); float sh=0.5+0.75*clamp(dot(normalize(vN),normalize(uSun)),0.,1.); gl_FragColor=vec4(c*mix(1.,sh,0.85),uOp); }`;
  const gheat = new THREE.Mesh(moonGeometry(RM * 0.0012, 768, 384), new THREE.ShaderMaterial({ uniforms: gheatU, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    vertexShader: 'varying vec3 vP; varying vec3 vN; void main(){ vP=position; vN=normal; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }', fragmentShader: GH_FS }));
  gheat.visible = false; moon.add(gheat);

  // pins
  const pinGroup = new THREE.Group(); moon.add(pinGroup);
  const pinTex = {}; for (const k in CATS) pinTex[k] = pinTexture(CATS[k].color);
  const pins = [];
  const llToLocal = (lat, lon, rIn) => { const r = rIn === 1 ? 1 : surfR(lat, lon) + (rIn === undefined ? RM * 0.004 : rIn - RM), f = lat * Math.PI / 180, l = lon * Math.PI / 180; return new THREE.Vector3(Math.cos(f) * Math.cos(l), Math.sin(f), -Math.cos(f) * Math.sin(l)).multiplyScalar(r); };
  function setSites(sites) {
    pinGroup.clear(); pins.length = 0;
    for (const s of sites) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: pinTex[s.cat], depthWrite: false, transparent: true, sizeAttenuation: false }));
      sp.scale.setScalar(0.024); sp.position.copy(llToLocal(s.lat, s.lon)); sp.userData.site = s; pinGroup.add(sp); pins.push(sp);
    }
  }
  const selSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), color: 0xffffff, depthWrite: false, transparent: true, sizeAttenuation: false, depthTest: false }));
  selSprite.scale.setScalar(0.05); selSprite.renderOrder = 20; moon.add(selSprite);
  const pinned = new THREE.Group(); moon.add(pinned);

  // orbit + ruler
  const orbitGeo = new THREE.BufferGeometry(); const orbit = new THREE.Line(orbitGeo, new THREE.LineBasicMaterial({ color: 0x4a7fb0, transparent: true, opacity: 0.45 })); orbit.visible = false; scene.add(orbit);
  let orbitJd = -1;
  function rebuildOrbit(jd) {
    const pts = []; for (let k = -15; k <= 15; k += 0.5) { const m = moonEcl((jd + k - 2451545) / 36525); pts.push(conv(m.vec).multiplyScalar(0.001)); }
    setPts(orbit, pts); orbitJd = jd;
  }
  const scaleGroup = new THREE.Group(); scaleGroup.visible = false; scene.add(scaleGroup);
  const rulerGeo = new THREE.BufferGeometry(); const ruler = new THREE.Line(rulerGeo, new THREE.LineDashedMaterial({ color: 0xffd166, dashSize: 6.371, gapSize: 6.371, transparent: true, opacity: 0.85 })); scaleGroup.add(ruler);
  const ticks = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ map: ringTexture(), size: 11, sizeAttenuation: false, transparent: true, depthWrite: false, color: 0x4cc9f0, opacity: 0.8 })); scaleGroup.add(ticks);
  const pulse = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,255,255,1)', 'rgba(120,220,255,.5)'), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true })); pulse.scale.setScalar(22); pulse.visible = false; scaleGroup.add(pulse);

  // MC groups
  const mcGroup = new THREE.Group(); moon.add(mcGroup);
  const trailU = { uTime: { value: 0 } }; let mcLines = null, mcPoints = null, mcSegs = 0, mcN = 0;
  let mcStartL = null, mcEndL = null, mcStartLbl = null, mcEndLbl = null;
  function setMonteCarlo(res, basis) {
    mcGroup.clear(); mcLines = mcPoints = null; mcStartL = mcEndL = null; if (mcStartLbl) mcStartLbl.show = mcEndLbl.show = false; if (!res) return;
    const { trials } = res, SEG = 28, n = trials.length, pos = new Float32Array(n * SEG * 2 * 3), T = new Float32Array(n * SEG * 2), S = new Float32Array(n * SEG * 2), C = new Float32Array(n * SEG * 2 * 3);
    const U = bodyToLocal(basis.U), Nn = bodyToLocal(basis.N), E = bodyToLocal(basis.E);
    const dirAt = (s, az) => { const th = s / R_MOON; return U.clone().multiplyScalar(Math.cos(th)).addScaledVector(Nn, Math.sin(th) * Math.cos(az)).addScaledVector(E, Math.sin(th) * Math.sin(az)); };
    const pp = new Float32Array(n * 3), pc = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const tr = trials[i], L = dirAt(Math.hypot(tr.e, tr.n), Math.atan2(tr.e, tr.n)), Sx = dirAt(tr.range, tr.approachAz + Math.PI);
      const col = tr.ok ? [0.3, 1, 0.65] : tr.lit ? [1, 0.55, 0.25] : [1, 0.3, 0.45];
      let prev = null;
      for (let k = 0; k <= SEG; k++) {
        const t = k / SEG, w = ease(t), v = Sx.clone().lerp(L, w).normalize(), alt = 100 * Math.pow(1 - t, 2.4) / 1000;
        const p = v.multiplyScalar(RM * 1.0008 + alt);
        if (prev) { const o = (i * SEG + k - 1) * 2; pos.set([prev.x, prev.y, prev.z, p.x, p.y, p.z], o * 3); T[o] = (k - 1) / SEG; T[o + 1] = t; S[o] = S[o + 1] = (i * 0.61803) % 1; C.set([...col, ...col], o * 3); }
        prev = p;
      }
      const g = L.clone().multiplyScalar(RM * 1.0012 / L.length()); pp.set([g.x, g.y, g.z], i * 3); pc.set(col, i * 3);
    }
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); lg.setAttribute('aT', new THREE.BufferAttribute(T, 1)); lg.setAttribute('aSeed', new THREE.BufferAttribute(S, 1)); lg.setAttribute('aCol', new THREE.BufferAttribute(C, 3));
    mcLines = new THREE.LineSegments(lg, new THREE.ShaderMaterial({ uniforms: trailU, vertexShader: TRAIL_VS, fragmentShader: TRAIL_FS, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    mcLines.frustumCulled = false; mcSegs = SEG * 2; mcN = n; mcGroup.add(mcLines);
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(pp, 3)); pg.setAttribute('color', new THREE.BufferAttribute(pc, 3));
    mcPoints = new THREE.Points(pg, new THREE.PointsMaterial({ size: 3.2, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false })); mcPoints.frustumCulled = false; mcGroup.add(mcPoints);
    // clear START and END markers so the path direction reads at a glance
    const s0 = dirAt(330, Math.PI / 2 + Math.PI).multiplyScalar(RM * 1.0008 + 0.1), e0 = dirAt(0, 0).multiplyScalar(RM * 1.002);
    const mk = (col, size) => new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), color: col, depthWrite: false, depthTest: false, transparent: true, sizeAttenuation: false }));
    const a = mk(0x4cc9f0); a.position.copy(s0); a.scale.setScalar(0.035); mcGroup.add(a);
    const b = mk(0xffffff); b.position.copy(e0); b.scale.setScalar(0.05); mcGroup.add(b);
    mcStartL = s0; mcEndL = e0;
    if (!mcStartLbl) { mcStartLbl = addLabel('START', () => mcStartL && moon.localToWorld(mcStartL.clone()), 'mclbl'); mcEndLbl = addLabel('END', () => mcEndL && moon.localToWorld(mcEndL.clone()), 'mclbl'); }
    mcStartLbl.show = mcEndLbl.show = true;
    setMcReveal(0);
  }
  function setMcReveal(f) { if (!mcLines) return; const k = Math.floor(f * mcN); mcLines.geometry.setDrawRange(0, k * mcSegs * 2 / 2 * 1); mcLines.geometry.setDrawRange(0, k * 28 * 2); mcPoints.geometry.setDrawRange(0, k); }

  // ---- labels
  const labels = [];
  function addLabel(text, getPos, cls = '') {
    const el = document.createElement('div'); el.className = 'wlabel ' + cls; el.textContent = text; labelRoot.appendChild(el);
    const o = { el, getPos, show: true }; labels.push(o); return o;
  }
  const tmpV = new THREE.Vector3();
  const lpA = new THREE.Vector3(), lpB = new THREE.Vector3();
  function pairMid(a, b) { // centre of the part of segment a-b that is actually on screen, as NDC; null if off screen
    camera.updateMatrixWorld(); lpA.copy(a).applyMatrix4(camera.matrixWorldInverse); lpB.copy(b).applyMatrix4(camera.matrixWorldInverse);
    const nz = -camera.near * 2; let ta = 0, tb = 1;
    if (lpA.z > nz && lpB.z > nz) return null;
    if (lpA.z > nz) ta = (nz - lpA.z) / (lpB.z - lpA.z); else if (lpB.z > nz) tb = (nz - lpA.z) / (lpB.z - lpA.z);
    const P = (t) => lpA.clone().lerp(lpB, t).applyMatrix4(camera.projectionMatrix);
    let p0 = P(ta), p1 = P(tb), dx = p1.x - p0.x, dy = p1.y - p0.y, t0 = 0, t1 = 1; const M = 0.86;
    for (const [pp, qq] of [[-dx, p0.x + M], [dx, M - p0.x], [-dy, p0.y + M], [dy, M - p0.y]]) { if (pp === 0) { if (qq < 0) return null; } else { const r = qq / pp; if (pp < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; } } }
    const tm = (t0 + t1) / 2; return [p0.x + dx * tm, p0.y + dy * tm];
  }
  function updateLabels() {
    const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
    for (const l of labels) {
      if (l.pair) {
        const pr = l.show && visible ? l.pair() : null, m = pr && pairMid(pr[0], pr[1]);
        if (!m) { l.el.style.display = 'none'; continue; }
        l.el.style.display = 'block'; l.el.style.transform = `translate(${(m[0] * 0.5 + 0.5) * w}px,${(-m[1] * 0.5 + 0.5) * h}px)`; continue;
      }
      const p = l.getPos(); if (!p || !l.show || !visible) { l.el.style.display = 'none'; continue; }
      tmpV.copy(p).project(camera);
      if (tmpV.z > 1 || Math.abs(tmpV.x) > 1.05 || Math.abs(tmpV.y) > 1.05) { l.el.style.display = 'none'; continue; }
      l.el.style.display = 'block'; l.el.style.transform = `translate(${(tmpV.x * 0.5 + 0.5) * w}px,${(-tmpV.y * 0.5 + 0.5) * h}px)`;
    }
  }
  const poleLbl = addLabel('South pole terrain', () => moon.localToWorld(llToLocal(-90, 0)), 'terricon pole'); let poleHandler = null; poleLbl.el.addEventListener('click', (e) => { e.stopPropagation(); poleHandler && poleHandler(); }); poleLbl.el.addEventListener('pointerdown', (e) => e.stopPropagation());
  let terrHandler = null; const terrIcons = [], ptw = new THREE.Vector3(), ptn = new THREE.Vector3(), pcam = new THREE.Vector3();
  function setTerrainSites(list) {
    for (const t of terrIcons) { t.el.remove(); labels.splice(labels.indexOf(t), 1); } terrIcons.length = 0;
    for (const s of list) {
      const l = addLabel(s.name.replace(/ ·.*/, ''), () => moon.localToWorld(llToLocal(s.lat, s.lon)), 'terricon'); l.site = s; l.show = false;
      l.el.addEventListener('click', (e) => { e.stopPropagation(); terrHandler && terrHandler(s); }); l.el.addEventListener('pointerdown', (e) => e.stopPropagation()); terrIcons.push(l);
    }
  }
  const earthPos = new THREE.Vector3(), moonPos = new THREE.Vector3(), sunDir = new THREE.Vector3(1, 0, 0);
  addLabel('EARTH', () => earthPos.clone().add(new THREE.Vector3(0, RE * 1.25, 0)), 'big');
  addLabel('MOON', () => moonPos.clone().add(new THREE.Vector3(0, RM * 1.35, 0)), 'big');
  const rulerLabel = addLabel('384,400 km · 30 Earths fit in between', () => earthPos.clone().lerp(moonPos, 0.5).add(new THREE.Vector3(0, 28, 0)), 'ruler');
  const earthLbl = labels[0], moonLbl = labels[1];

  // ---- camera / controls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08; controls.zoomSpeed = 1.1; controls.rotateSpeed = 0.7; controls.enablePan = false;
  // Trackball-style rotation: OrbitControls locks up when the camera looks straight down a pole, which is exactly where the south-pole sites are.
  controls.enableRotate = false;
  { const el = renderer.domElement, ptrs = new Set(); let last = null; const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), ax = new THREE.Vector3(), ay = new THREE.Vector3();
    el.addEventListener('pointerdown', (e) => { ptrs.add(e.pointerId); last = ptrs.size === 1 && e.button === 0 ? { x: e.clientX, y: e.clientY } : null; });
    const end = (e) => { ptrs.delete(e.pointerId); last = null; };
    window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
    window.addEventListener('pointermove', (e) => {
      if (!last || ptrs.size !== 1 || anim || !controls.enabled || !visible) return;
      const dx = e.clientX - last.x, dy = e.clientY - last.y; last.x = e.clientX; last.y = e.clientY; if (!dx && !dy) return;
      ax.set(1, 0, 0).applyQuaternion(camera.quaternion); ay.set(0, 1, 0).applyQuaternion(camera.quaternion);
      qa.setFromAxisAngle(ay, -dx * 0.0055); qb.setFromAxisAngle(ax, -dy * 0.0055); qa.multiply(qb);
      const off = camera.position.clone().sub(controls.target).applyQuaternion(qa); camera.up.applyQuaternion(qa).normalize(); camera.position.copy(controls.target).add(off); camera.lookAt(controls.target);
    });
  }
  camera.position.set(0, 0, 40);
  let focus = 'moon', anim = null, visible = true, lastFocus = new THREE.Vector3(), mode = 'space';
  const midPos = new THREE.Vector3();
  let focusFn = null; const focusPos = (f) => (f === 'point' && focusFn ? focusFn() : f === 'earth' ? earthPos : f === 'mid' ? midPos.copy(earthPos).lerp(moonPos, 0.5) : moonPos);
  function limits() { controls.minDistance = focus === 'earth' ? RE * 1.08 : focus === 'mid' ? 20 : focus === 'point' ? 2 : RM * 1.07; controls.maxDistance = 9000; }
  function flyTo(opts) {
    const { to = focus, dist, dir, dirFn, local, dur = 3, onUpdate, done, cancel } = opts;
    if (anim && anim.cancel) anim.cancel();   // a flight that gets replaced must still release whoever is waiting on it
    const cur = camera.position.clone().sub(controls.target);
    let toDir = dir ? dir.clone().normalize() : cur.clone().normalize();
    anim = { t: 0, dur, dirFn, local, fromTarget: controls.target.clone(), fromDir: cur.clone().normalize(), fromLen: cur.length(), to, toDir, toLen: dist ?? cur.length(), onUpdate, done, cancel };
    controls.enabled = false;
  }
  // Fly to a lunar coordinate in the Moon's own (rotating) frame so the camera glides straight to it however fast time runs.
  function flyToSite(lat, lon, dist, dur) {
    const inv = new THREE.Matrix4().copy(moon.matrix).invert(), cur = camera.position.clone().sub(controls.target).normalize().transformDirection(inv);
    flyTo({ to: 'moon', dist, dur, local: { from: cur, to: llToLocal(lat, lon, 1).normalize() } });
  }
  function slerpDir(a, b, t) {
    const d = Math.max(-1, Math.min(1, a.dot(b))), th = Math.acos(d); if (th < 1e-4) return b.clone();
    if (Math.PI - th < 1e-3) { const ax = Math.abs(a.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0), p = a.clone().cross(ax).normalize(); return a.clone().applyAxisAngle(p, Math.PI * t); }
    const s1 = Math.sin((1 - t) * th) / Math.sin(th), s2 = Math.sin(t * th) / Math.sin(th); return a.clone().multiplyScalar(s1).addScaledVector(b, s2);
  }
  function stepAnim(dt) {
    if (!anim) return;
    anim.t += dt; const u = Math.min(1, anim.t / anim.dur), e = ease(u);
    const tgt = anim.fromTarget.clone().lerp(focusPos(anim.to), e);
    if (anim.dirFn) anim.toDir = anim.dirFn().normalize();
    const dir = anim.local ? slerpDir(anim.local.from, anim.local.to, e).transformDirection(moon.matrix) : slerpDir(anim.fromDir, anim.toDir, e), len = Math.exp(Math.log(anim.fromLen) * (1 - e) + Math.log(anim.toLen) * e);
    controls.target.copy(tgt); camera.position.copy(tgt).addScaledVector(dir, len);
    if (anim.onUpdate) anim.onUpdate(u, len);
    if (u >= 1) { focus = anim.to; limits(); controls.enabled = true; const d = anim.done; anim = null; if (d) d(); }
  }

  const moonQ = new THREE.Quaternion(), prevQ = new THREE.Quaternion(), tmpM = new THREE.Matrix4(); let havePrevQ = false;
  let tourT = -1;
  function update(dt, st, jd, t) {
    const s = st.sun.vec, sd = new THREE.Vector3(s[0], s[2], -s[1]).normalize(); sunDir.copy(sd);
    sunGroup.position.copy(sd).multiplyScalar(SUN_DIST); sunGroup.scale.setScalar(st.sunRad / (0.2666 * Math.PI / 180)); sunLight.position.copy(sd).multiplyScalar(100); sunMat.uniforms.uTime.value = t;
    earth.matrixAutoUpdate = false; earth.matrix.copy(basisMatrix(st.ef, new THREE.Vector3())); earth.matrixWorldNeedsUpdate = true; earthU.uSun.value.copy(sd); earthU.uTime.value = t;
    atmo.position.set(0, 0, 0);
    moonPos.copy(conv(st.moon.vec)).multiplyScalar(0.001); moon.matrix.copy(basisMatrix(st.mf, moonPos)); moon.matrixWorldNeedsUpdate = true;
    if (gheat.visible) { gheatU.uSun.value.set(st.sunBody[0], st.sunBody[2], -st.sunBody[1]); gheatU.uEarth.value.set(st.earthBody[0], st.earthBody[2], -st.earthBody[1]); }
    if (Math.abs(jd - orbitJd) > 0.5) rebuildOrbit(jd);
    glow1.visible = glow2.visible = !trajRoot.visible && !mis;
    if (trajRoot.visible) updateTraj(jd, st);
    if (mis) updateMission(st, t);
    if (distGroup.visible) updateDist();
    // keep the view locked on the followed body
    const fp = focusPos(focus);
    moonQ.setFromRotationMatrix(moon.matrix);
    if (!anim) {
      tmpV.copy(fp).sub(controls.target); controls.target.add(tmpV); camera.position.add(tmpV);
      if (focus === 'moon' && havePrevQ) { // ride along with the Moon's rotation so the chosen site stays under the camera
        const dq = moonQ.clone().multiply(prevQ.clone().invert()), off = camera.position.clone().sub(controls.target).applyQuaternion(dq); camera.position.copy(controls.target).add(off);
      }
    }
    prevQ.copy(moonQ); havePrevQ = true;
    stepAnim(dt); controls.update();
    // dynamic near/far
    const dE = camera.position.distanceTo(earthPos) - RE, dM = camera.position.distanceTo(moonPos) - RM;
    const dmin = Math.max(0.0006, Math.min(dE, dM)); camera.near = Math.min(5, dmin * 0.12); camera.far = 40000; camera.updateProjectionMatrix();
    // scale ruler
    if (scaleGroup.visible) {
      const a = earthPos.clone().addScaledVector(moonPos.clone().sub(earthPos).normalize(), RE), b = moonPos.clone().addScaledVector(earthPos.clone().sub(moonPos).normalize(), RM);
      setPts(ruler, [a, b]); ruler.computeLineDistances();
      const tp = [], dist = a.distanceTo(b), dirv = b.clone().sub(a).normalize(), cnt = Math.floor(dist / (RE * 2));
      for (let i = 0; i < cnt; i++) tp.push(a.clone().addScaledVector(dirv, RE * (1 + 2 * i)));
      if (tp.length !== ticks.userData.n) { ticks.userData.n = tp.length; ticks.geometry.dispose(); ticks.geometry = new THREE.BufferGeometry(); }
      setPts(ticks, tp);
      
    }
    trailU.uTime.value = t; selSprite.material.opacity = 0.65 + 0.35 * Math.sin(t * 4);
    const nearMoon = camera.position.distanceTo(moonPos) < 60; earthLbl.show = !nearMoon || scaleGroup.visible; moonLbl.show = camera.position.distanceTo(moonPos) > 8;
    rulerLabel.show = scaleGroup.visible; { const pw = moon.localToWorld(llToLocal(-90, 0)), nrm = pw.clone().sub(moonPos).normalize(); poleLbl.show = camera.position.distanceTo(moonPos) < 70 && nrm.dot(camera.position.clone().sub(pw)) > 0.15; } { const near = camera.position.distanceTo(moonPos) < 70; for (const t of terrIcons) { t.show = false; if (!near) continue; moon.localToWorld(ptw.copy(llToLocal(t.site.lat, t.site.lon))); ptn.copy(ptw).sub(moonPos).normalize(); pcam.copy(camera.position).sub(ptw); t.show = ptn.dot(pcam) > 0.15; } } pinGroup.visible = nearMoon; selSprite.visible = camera.position.distanceTo(moonPos) < 90;
    updateLabels();
  }

  // ---- picking
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pickMoon(cx, cy) {
    const r = renderer.domElement.getBoundingClientRect(); ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera);
    const hit = ray.ray.intersectSphere(new THREE.Sphere(moonPos, RM), new THREE.Vector3()); if (!hit) return null;
    const l = hit.clone().applyMatrix4(tmpM.copy(moon.matrix).invert()).normalize();
    return { lat: Math.asin(l.y) * 180 / Math.PI, lon: Math.atan2(-l.z, l.x) * 180 / Math.PI };
  }
  function pickPin(cx, cy, maxPx = 14) {
    const r = renderer.domElement.getBoundingClientRect(); let best = null, bd = maxPx;
    const camToMoon = camera.position.clone().sub(moonPos).normalize();
    for (const sp of pins) {
      const w = sp.getWorldPosition(new THREE.Vector3()); if (w.clone().sub(moonPos).normalize().dot(camToMoon) < 0.12) continue;
      const p = w.clone().project(camera), x = (p.x * 0.5 + 0.5) * r.width + r.left, y = (-p.y * 0.5 + 0.5) * r.height + r.top, d = Math.hypot(x - cx, y - cy);
      if (d < bd) { bd = d; best = sp.userData.site; }
    }
    return best;
  }

  // ---------------------------------------------------------------- Researcher: Earth -> Moon trajectories
  const trajRoot = new THREE.Group(); trajRoot.visible = false; scene.add(trajRoot); const trajFrame = new THREE.Group(); trajFrame.matrixAutoUpdate = false; trajRoot.add(trajFrame);
  const TX = new THREE.Vector3(), TY = new THREE.Vector3(), TZ = new THREE.Vector3(), upk = { v: 0 };
  const frameVec = (x, y) => new THREE.Vector3().copy(earthPos).addScaledVector(TX, x * upk.v).addScaledVector(TY, y * upk.v);
  const lineMat = (op) => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false });
  let past = null, tr = null, trReveal = 1, trLbl = null, trSite = null;
  function arc(P0, dS, n, out, o, rEnd = RM * 1.002) { // spiral from P0 down to the surface, going around the Moon along a great circle
    const v0 = P0.clone().sub(moonPos), r0 = v0.length(), d0 = v0.clone().divideScalar(r0), th = Math.acos(Math.max(-1, Math.min(1, d0.dot(dS))));
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1), s = th < 1e-4 ? 0 : Math.sin(th), a = th < 1e-4 ? 1 - t : Math.sin((1 - t) * th) / s, b = th < 1e-4 ? t : Math.sin(t * th) / s, r = rEnd + (r0 - rEnd) * Math.pow(1 - t, 2.2);
      const p = d0.clone().multiplyScalar(a).addScaledVector(dS, b).normalize().multiplyScalar(r).add(moonPos); out[(o + k) * 3] = p.x; out[(o + k) * 3 + 1] = p.y; out[(o + k) * 3 + 2] = p.z;
    }
  }
  function setPast(sites, nom) {
    if (past) { trajRoot.remove(past.group); past.group.traverse((o) => o.geometry && o.geometry.dispose()); past = null; }
    if (!sites) return;
    const pts = []; for (let i = 0; i < nom.path.length; i += 2) { const dx = nom.path[i] - (nom.path[i] * 0) , dy = nom.path[i + 1]; if (Math.hypot(nom.path[i] - 384400, dy) < 26000) break; pts.push([nom.path[i], dy]); }
    const group = new THREE.Group(), n = pts.length, T = 36, items = [];
    sites.forEach((site, si) => {
      const g = new THREE.BufferGeometry(), N = n + T, col = new Float32Array(N * 3), c = new THREE.Color(CATS[site.cat]?.color || '#fff');
      for (let k = 0; k < N; k++) { const f = k / N; col.set([c.r * (0.25 + 0.75 * f), c.g * (0.25 + 0.75 * f), c.b * (0.25 + 0.75 * f)], k * 3); }
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const line = new THREE.Line(g, lineMat(0.4)); line.frustumCulled = false; group.add(line);
      items.push({ site, line, bend: ((((si * 2654435761) >>> 0) % 1000) / 1000 - 0.5) * 2 * 9000 });
    });
    past = { group, pts, n, T, items }; trajRoot.add(group);
  }
  function updatePast() {
    if (!past || !trajRoot.visible) return;
    const { pts, n, T, items } = past;
    for (const it of items) {
      const a = it.line.geometry.getAttribute('position'), arr = a.array;
      for (let k = 0; k < n; k++) { const f = k / (n - 1), p = frameVec(pts[k][0], pts[k][1] + it.bend * f * f); arr[k * 3] = p.x; arr[k * 3 + 1] = p.y; arr[k * 3 + 2] = p.z; }
      const P0 = new THREE.Vector3(arr[(n - 1) * 3], arr[(n - 1) * 3 + 1], arr[(n - 1) * 3 + 2]);
      arc(P0, siteDirWorld(it.site.lat, it.site.lon), T, arr, n, surfR(it.site.lat, it.site.lon) + RM * 0.002); a.needsUpdate = true;
    }
  }
  function setTransfers(res, site) {
    if (tr) { trajRoot.remove(tr.group); trajFrame.remove(tr.lines); tr.lines.geometry.dispose(); tr.group.traverse((o) => o.geometry && o.geometry.dispose()); if (tr.dot) { moon.remove(tr.dot); tr.dot.material.dispose(); } tr = null; }
    if (!res) return;
    const group = new THREE.Group(), { path, starts, counts, N } = res;
    let segs = 0; for (let i = 0; i < N; i++) segs += counts[i] - 1;
    const pos = new Float32Array(segs * 6); let o = 0;
    for (let i = 0; i < N; i++) for (let k = 0; k < counts[i] - 1; k++) { const a = (starts[i] + k) * 3, b = a + 3; pos.set([path[a], path[a + 1], path[a + 2], path[b], path[b + 1], path[b + 2]], o * 6); o++; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x9fb0cc, transparent: true, opacity: 0.17, depthWrite: false })); lines.frustumCulled = false; trajFrame.add(lines);
    let bestLine = null, bestPts = null, dot = null;
    if (res.best) {
      const i = res.best.i, n = res.best.iPeri + 1; bestPts = new Float32Array(n * 3); for (let k = 0; k < n * 3; k++) bestPts[k] = path[starts[i] * 3 + k];
      const T = 40, bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array((n + T) * 3), 3));
      bestLine = new THREE.Line(bg, new THREE.LineBasicMaterial({ color: 0x4de88a, transparent: true, opacity: 1, depthTest: false })); bestLine.frustumCulled = false; bestLine.renderOrder = 5; group.add(bestLine);
      const bestDots = new THREE.Points(bg, new THREE.PointsMaterial({ color: 0x4de88a, size: 4, sizeAttenuation: false, depthTest: false, transparent: true })); bestDots.frustumCulled = false; bestDots.renderOrder = 6; group.add(bestDots);
      dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,255,255,1)', 'rgba(77,232,138,.9)'), blending: THREE.AdditiveBlending, depthTest: false, transparent: true, sizeAttenuation: false })); dot.scale.setScalar(0.05); dot.renderOrder = 9; dot.position.copy(llToLocal(site.lat, site.lon, RM + (surfR(site.lat, site.lon) - RM) + RM * 0.004)); dot.visible = false; moon.add(dot);
    }
    tr = { group, lines, bestLine, bestPts, dot, N: bestPts ? bestPts.length / 3 : 0, T: 40, site, res };
    trajRoot.add(group);
  }
  /** Final stage: drop the grey routes and leave only the chosen route ending on a green dot at the landing spot. */
  function finishTransfers() { if (!tr) return; tr.lines.visible = false; if (tr.dot) tr.dot.visible = true; }
  const frameVec3 = (x, y, z) => frameVec(x, y).addScaledVector(TZ, z * upk.v);

  // ---------------------------------------------------------------- real spacecraft paths (JPL Horizons), drawn in the Earth-Moon rotating frame
  const misFrame = new THREE.Group(); misFrame.matrixAutoUpdate = false; misFrame.visible = false; scene.add(misFrame);
  let mis = null; const misTmp = new THREE.Vector3();
  const misLbl = addLabel('', () => (mis ? misFrame.localToWorld(misTmp.copy(mis.cur)) : null), 'mission'); misLbl.show = false;
  function setMission(m) {
    if (mis) { misFrame.remove(mis.faint, mis.bright, mis.dot); mis.faint.geometry.dispose(); mis.bright.material.dispose(); mis.faint.material.dispose(); mis.dot.material.dispose(); mis = null; }
    misLbl.show = false; misFrame.visible = !!m; glow1.visible = glow2.visible = !m && !trajRoot.visible; if (!m) return;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(m.pts, 3));
    const faint = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28, depthWrite: false })), bright = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false }));
    faint.frustumCulled = bright.frustumCulled = false; bright.geometry.setDrawRange(0, 2);
    const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(), color: 0xffffff, depthTest: false, transparent: true, sizeAttenuation: false })); dot.scale.setScalar(0.03); dot.renderOrder = 22;
    misFrame.add(faint, bright, dot); mis = { ...m, faint, bright, dot, cur: new THREE.Vector3(m.pts[0], m.pts[1], m.pts[2]), t0: -1, lastText: '' }; misLbl.show = true;
  }
  function updateMission(st, now) {
    if (!mis) return;
    const dist = moonPos.clone().sub(earthPos).length(); TX.copy(moonPos).sub(earthPos).divideScalar(dist); upk.v = dist / 384400;
    const m0 = st.moon.vec, v = st.moonVel || [0, 0, 1]; TZ.copy(conv([m0[1] * v[2] - m0[2] * v[1], m0[2] * v[0] - m0[0] * v[2], m0[0] * v[1] - m0[1] * v[0]])).normalize(); TY.copy(TZ).cross(TX).normalize();
    misFrame.matrix.makeBasis(TX.clone().multiplyScalar(upk.v), TY.clone().multiplyScalar(upk.v), TZ.clone().multiplyScalar(upk.v)).setPosition(earthPos); misFrame.matrixWorldNeedsUpdate = true;
    // playback: the whole mission plays over about 16 s, rests briefly at the end, then repeats
    if (mis.t0 < 0) mis.t0 = now; const dur = 16, rest = 2, ph = ((now - mis.t0) % (dur + rest)), p = Math.min(1, ph / dur), T = mis.days * p;
    let lo = 0, hi = mis.n - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (mis.t[mid] <= T) lo = mid; else hi = mid; }
    const f = mis.t[hi] > mis.t[lo] ? (T - mis.t[lo]) / (mis.t[hi] - mis.t[lo]) : 0, P = mis.pts;
    mis.cur.set(P[lo * 3] * (1 - f) + P[hi * 3] * f, P[lo * 3 + 1] * (1 - f) + P[hi * 3 + 1] * f, P[lo * 3 + 2] * (1 - f) + P[hi * 3 + 2] * f);
    mis.dot.position.copy(mis.cur); mis.bright.geometry.setDrawRange(0, Math.max(2, lo + 1));
    const txt = `${mis.name} · day ${T.toFixed(1)}`; if (txt !== mis.lastText) { mis.lastText = txt; misLbl.el.textContent = txt; }
  }
  function updateTraj(jd, st) {
    const dvec = moonPos.clone().sub(earthPos), dist = dvec.length(); TX.copy(dvec).divideScalar(dist); upk.v = dist / 384400;
    const m0 = st.moon.vec, v = st.moonVel || (() => { const m1 = moonEcl(st.T + 0.05 / 36525).vec; return [m1[0] - m0[0], m1[1] - m0[1], m1[2] - m0[2]]; })(); // Horizons velocity when available
    TZ.copy(conv([m0[1] * v[2] - m0[2] * v[1], m0[2] * v[0] - m0[0] * v[2], m0[0] * v[1] - m0[1] * v[0]])).normalize(); TY.copy(TZ).cross(TX).normalize();
    trajFrame.matrix.makeBasis(TX.clone().multiplyScalar(upk.v), TY.clone().multiplyScalar(upk.v), TZ.clone().multiplyScalar(upk.v)).setPosition(earthPos); trajFrame.matrixWorldNeedsUpdate = true;
    if (tr && tr.bestLine) {
      const a = tr.bestLine.geometry.getAttribute('position'), arr = a.array, n = tr.N;
      for (let k = 0; k < n; k++) { const p = frameVec3(tr.bestPts[k * 3], tr.bestPts[k * 3 + 1], tr.bestPts[k * 3 + 2]); arr[k * 3] = p.x; arr[k * 3 + 1] = p.y; arr[k * 3 + 2] = p.z; }
      const P0 = new THREE.Vector3(arr[(n - 1) * 3], arr[(n - 1) * 3 + 1], arr[(n - 1) * 3 + 2]); arc(P0, siteDirWorld(tr.site.lat, tr.site.lon), tr.T, arr, n, surfR(tr.site.lat, tr.site.lon) + RM * 0.004); a.needsUpdate = true;
    }
  }
  function setTrajVisible(b) { trajRoot.visible = b; if (trLbl) trLbl.forEach((l) => (l.show = b && !!tr)); }

  // ---- distance lines between Earth, Moon and Sun (dashed red), with live labels
  const distGroup = new THREE.Group(); distGroup.visible = false; scene.add(distGroup);
  const distLines = [[8, 6], [90, 60], [90, 60]].map(([d, gp]) => { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]), new THREE.LineDashedMaterial({ color: 0xff4d4d, dashSize: d, gapSize: gp, transparent: true, opacity: 0.9 })); l.frustumCulled = false; distGroup.add(l); return l; });
  const distMid = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], distLbl = ['Earth to Moon', 'Earth to Sun', 'Moon to Sun'].map((t, i) => { const l = addLabel(t, () => null, 'distl'); l.pair = () => (distGroup.visible ? distEnds[i] : null); return l; });
  const distEnds = [[earthPos, moonPos], [earthPos, sunGroup.position], [moonPos, sunGroup.position]];
  function setDistances(on, texts) { distGroup.visible = on; distLbl.forEach((l, i) => { l.show = on; if (texts && l.el.textContent !== texts[i]) l.el.textContent = texts[i]; }); }
  function updateDist() {
    const sp = sunGroup.position, pairs = [[earthPos, moonPos], [earthPos, sp], [moonPos, sp]];
    pairs.forEach(([a, b], i) => { const ar = distLines[i].geometry.getAttribute('position'); ar.setXYZ(0, a.x, a.y, a.z); ar.setXYZ(1, b.x, b.y, b.z); ar.needsUpdate = true; distLines[i].computeLineDistances(); distMid[i].copy(a).lerp(b, 0.5); });
  }
  function setSelected(site) { selSprite.position.copy(llToLocal(site.lat, site.lon, RM * 1.006)); }
  function setPinned(list) {
    pinned.clear(); list.forEach((s, i) => { const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: pinTexture(['#ff9f1c', '#2ec4b6', '#e71d36', '#9b5de5'][i % 4]), depthTest: false, transparent: true, sizeAttenuation: false })); sp.scale.setScalar(0.034); sp.position.copy(llToLocal(s.lat, s.lon, RM * 1.006)); sp.renderOrder = 19; pinned.add(sp); });
  }
  const siteDirWorld = (lat, lon) => llToLocal(lat, lon, 1).transformDirection(moon.matrix);
  const poleDirWorld = () => new THREE.Vector3(0, -1, 0).transformDirection(moon.matrix);
  function setGlobalHeat(b) { gheat.visible = b; }
  function setHeatTexture(tex) { heatU.uMap.value = tex; }

  function resize(w, h) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  limits();
  return {
    siteElevationKm: (lat, lon) => hAt(lat, lon), flyToSite, setDistances, setGlobalHeat, setPast, setTransfers, finishTransfers, setTrajVisible, setMission,
    scene, camera, controls, update, resize, flyTo, setSites, setPoleHandler: (f) => (poleHandler = f), setTerrainHandler: (f) => (terrHandler = f), setTerrainSites, setSelected, setPinned, pickMoon, pickPin, siteDirWorld, poleDirWorld, setHeatTexture,
    angleToDir(dir) { return camera.position.clone().sub(controls.target).normalize().angleTo(dir); }, camDist() { return camera.position.distanceTo(controls.target); },
    heat, scaleGroup, setMonteCarlo, setMcReveal, get moonPos() { return moonPos; }, get earthPos() { return earthPos; }, get anim() { return anim; },
    setFocus(f) { focus = f; limits(); }, get focus() { return focus; }, setVisible(v) { visible = v; for (const l of labels) if (!v) l.el.style.display = 'none'; },
    tex: { dayT, nightT, specT, cloudT },
    camDistToMoonSurface: () => camera.position.distanceTo(moonPos) - RM, RE, RM,
  };
}
