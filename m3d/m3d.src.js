import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const BASE = new URL('./models/', import.meta.url).href;
let renderer, scene, camera, controls, key, rim, hemi, holder, cur = null, wire = false, onChange = null;
const cache = {};
const clay = () => new THREE.MeshStandardMaterial({ color: 0xd9d3c7, roughness: 0.92, metalness: 0 });
const FINGERS = ['index', 'middle', 'ring', 'pinky'];
export const POSES = { open: '편 손', relax: '편히 쉰 손', fist: '주먹', point: '가리키기', grip: '쥐기', pinch: '집기' };

function render() { if (renderer) renderer.render(scene, camera); }
function fit(obj) {
  obj.updateMatrixWorld(true); const box = new THREE.Box3().setFromObject(obj, true), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  const s = 1 / Math.max(size.x, size.y, size.z); obj.scale.multiplyScalar(s); obj.position.sub(c.multiplyScalar(s));
}
function wrapFit(o) { const g = new THREE.Group(); g.add(o); fit(o); return g; }

async function loadPart(part) {
  if (cache[part]) return cache[part];
  let g;
  if (part === 'foot') {
    const d = await (await fetch(BASE + 'foot.json')).json();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(d.p, 3)); geo.setIndex(d.i); geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, clay()); m.material.side = THREE.DoubleSide; m.castShadow = m.receiveShadow = true; g = wrapFit(m);
  } else {
    const gl = await new GLTFLoader().loadAsync(BASE + (part === 'hand' ? 'hand.glb' : 'head.glb'));
    gl.scene.traverse(o => { if (o.isMesh) { o.material = clay(); o.frustumCulled = false; o.castShadow = o.receiveShadow = true; } });
    if (part === 'head') gl.scene.rotation.y = 0;
    g = wrapFit(gl.scene);
    if (part === 'hand') { const bones = {}; gl.scene.traverse(o => { if (o.isBone) { bones[o.name] = o; o.userData.rp = o.position.clone(); o.userData.rq = o.quaternion.clone(); } });
      // flat hierarchy (all joints under Armature) → FK by hand in armature space
      const P = n => bones[n].userData.rp;
      const lat = P('pinky-finger-phalanx-proximal').clone().sub(P('index-finger-phalanx-proximal')).normalize();
      const along = P('middle-finger-phalanx-proximal').clone().sub(P('wrist')).normalize();
      const palm = new THREE.Vector3().crossVectors(lat, along).normalize();
      const tdir = P('thumb-tip').clone().sub(P('thumb-phalanx-proximal')).normalize();
      g.userData.bones = bones; g.userData.ax = { f: lat, t: new THREE.Vector3().crossVectors(palm, tdir).normalize() };
    }
  }
  cache[part] = g; return g;
}

const CH = f => f === 'thumb' ? ['thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'] : ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'].map(x => `${f}-finger-${x}`);
let SIGN = -1, TSIGN = -1; export function _sign(s, t) { SIGN = s; TSIGN = t; }
function chain(b, axis, names, angs, sg) {
  const R = new THREE.Quaternion(), qa = new THREE.Quaternion(); let prev = null, prevNew = null;
  names.forEach((n, i) => {
    const bone = b[n]; if (!bone) return; const rp = bone.userData.rp;
    const np = prev ? prevNew.clone().add(rp.clone().sub(prev).applyQuaternion(R)) : rp.clone();
    if (i < angs.length) { qa.setFromAxisAngle(axis, angs[i] * sg); R.premultiply(qa); }
    bone.position.copy(np); bone.quaternion.copy(bone.userData.rq).premultiply(R);
    prev = rp; prevNew = np;
  });
}
export function setPose(p) {
  const g = cache.hand; if (!g) return; const b = g.userData.bones, A = g.userData.ax, R = Math.PI / 180;
  const set = (f, a1, a2, a3) => chain(b, A.f, CH(f), [a1 * R, a2 * R, a3 * R], SIGN);
  const thumb = (a1, a2) => chain(b, A.t, CH('thumb'), [a1 * R, a2 * R], TSIGN);
  const all = (a1, a2, a3) => FINGERS.forEach(f => set(f, a1, a2, a3));
  const P = {
    open: () => { all(0, 0, 0); thumb(0, 0); },
    relax: () => { FINGERS.forEach((f, i) => set(f, 12 + i * 8, 22 + i * 8, 12 + i * 4)); thumb(10, 12); },
    fist: () => { all(85, 100, 65); thumb(35, 50); },
    point: () => { set('index', 0, 0, 0); ['middle', 'ring', 'pinky'].forEach(f => set(f, 85, 100, 65)); thumb(35, 45); },
    grip: () => { all(40, 55, 35); thumb(20, 25); },
    pinch: () => { set('index', 35, 50, 35); ['middle', 'ring', 'pinky'].forEach((f, i) => set(f, 15 + i * 12, 25 + i * 12, 15)); thumb(25, 30); },
  };
  (P[p] || P.open)(); render();
}
let wireMode = 'off', lightMode = 'rand', lastState = null, fill;
const wireMat = new THREE.MeshBasicMaterial({ color: 0x3d3b37, wireframe: true, transparent: true, opacity: .35 });
export function setWire(on) { wireMode = on === true ? 'only' : on === false ? 'off' : on; applyWire(); render(); }
function applyWire() { Object.values(cache).forEach(g => g.traverse(o => { if (!o.isMesh || o.userData.isWire) return;
  o.material.wireframe = wireMode === 'only'; o.material.flatShading = wireMode === 'flat' || wireMode === 'over'; o.material.needsUpdate = true;
  if (!o.userData.wire) { const w = o.isSkinnedMesh ? new THREE.SkinnedMesh(o.geometry, wireMat) : new THREE.Mesh(o.geometry, wireMat); if (o.isSkinnedMesh) w.bind(o.skeleton, o.bindMatrix); w.userData.isWire = true; w.frustumCulled = false; w.renderOrder = 1; o.add(w); o.userData.wire = w; }
  o.userData.wire.visible = wireMode === 'over'; })); }

export async function show(state) {
  const g = await loadPart(state.part);
  if (cur !== g) { if (cur) holder.remove(cur); holder.add(g); cur = g; applyWire(); }
  if (state.part === 'hand') setPose(state.pose || 'open');
  const d = 2.15, az = state.az * Math.PI / 180, el = state.el * Math.PI / 180;
  camera.position.set(d * Math.cos(el) * Math.sin(az), d * Math.sin(el), d * Math.cos(el) * Math.cos(az));
  controls.target.set(0, 0, 0); camera.lookAt(0, 0, 0); controls.update();
  lastState = state; placeLight(); render();
}
// camera-relative rigs: [az (+ = right of view), el, intensity, color]
export const RIGS = {
  rembr: { key: [45, 40, 2.6], fill: [-60, 10, .3], hemi: .4 },
  split: { key: [90, 5, 2.6], fill: [-90, 0, .12], hemi: .3 },
  rim:   { key: [150, 25, 3.2], rim: [-150, 25, 2.6], fill: [0, 5, .5], hemi: .4 },
  under: { key: [10, -55, 2.6], hemi: .3 },
  top:   { key: [0, 85, 2.8], hemi: .35 },
  warmcool: { key: [50, 30, 2.4, 0xffd2a0], fill: [-70, 10, 1.0, 0x9fc2ff], hemi: .2 },
};
function placeLight() {
  const state = lastState; if (!state) return;
  const mode = lightMode === 'rand' ? (state.rig || 'free') : lightMode;
  key.color.set(0xffffff); fill.color.set(0xffffff); key.castShadow = mode !== 'off';
  if (mode === 'off') { key.position.copy(camera.position).normalize().multiplyScalar(5).add(new THREE.Vector3(0, 1.2, 0)); key.intensity = 1.1; hemi.intensity = 1.5; rim.visible = fill.visible = false; return }
  const r = RIGS[mode];
  if (r) {
    const f = camera.position.clone().normalize(), rt = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), f).normalize(), u = new THREE.Vector3().crossVectors(f, rt);
    const put = (L, v) => { if (!v) { L.visible = false; return } L.visible = true; const a = v[0] * Math.PI / 180, e = v[1] * Math.PI / 180;
      L.position.copy(f).multiplyScalar(Math.cos(e) * Math.cos(a)).addScaledVector(rt, Math.cos(e) * Math.sin(a)).addScaledVector(u, Math.sin(e)).multiplyScalar(5);
      L.intensity = v[2]; L.color.set(v[3] || 0xffffff) };
    key.visible = true; put(key, r.key); put(fill, r.fill); put(rim, r.rim); hemi.intensity = r.hemi; return;
  }
  fill.visible = false; key.intensity = 2.4; hemi.intensity = .75;
  const la = state.lAz * Math.PI / 180, le = state.lEl * Math.PI / 180;
  key.position.set(Math.cos(le) * Math.sin(la), Math.sin(le), Math.cos(le) * Math.cos(la)).multiplyScalar(5);
  rim.visible = !!state.rim; rim.position.copy(key.position).multiplyScalar(-1).setY(Math.abs(key.position.y) * .4 + 1);
}
export function setLight(m) { lightMode = m === true ? 'rand' : m === false ? 'off' : m; placeLight(); render(); }
export function randomState(o) {
  const range = { near: [50, 20], wide: [120, 45], all: [180, 80] }[o.range || 'wide'];
  const rnd = (a, b) => a + Math.random() * (b - a);
  return { part: o.part, pose: o.pose, az: rnd(-range[0], range[0]), el: rnd(-range[1], range[1]), lAz: rnd(-160, 160), lEl: rnd(15, 70), rim: !!o.rim };
}
export function snapshot(w = 200) {
  render(); const c = renderer.domElement, h = Math.round(w * c.height / c.width);
  const t = document.createElement('canvas'); t.width = w; t.height = h; t.getContext('2d').drawImage(c, 0, 0, w, h); return t.toDataURL('image/jpeg', .72);
}
export function resize() {
  if (!renderer) return; const el = renderer.domElement.parentElement, w = el.clientWidth, h = el.clientHeight;
  renderer.setSize(w, h, false); renderer.domElement.style.width = w + 'px'; renderer.domElement.style.height = h + 'px';
  camera.aspect = w / h; camera.updateProjectionMatrix(); render();
}
export function init(canvas, bg, cb) {
  onChange = cb;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene = new THREE.Scene(); scene.background = new THREE.Color(bg);
  camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  hemi = new THREE.HemisphereLight(0xffffff, 0x8a8478, 0.75); scene.add(hemi);
  key = new THREE.DirectionalLight(0xffffff, 2.4); scene.add(key);
  rim = new THREE.DirectionalLight(0xffffff, 1.4); scene.add(rim);
  fill = new THREE.DirectionalLight(0xffffff, .3); fill.visible = false; scene.add(fill);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  key.castShadow = true; key.shadow.mapSize.set(2048, 2048); key.shadow.bias = -0.0005; key.shadow.normalBias = 0.02;
  { const c = key.shadow.camera; c.left = c.bottom = -1; c.right = c.top = 1; c.near = .5; c.far = 12; }
  holder = new THREE.Group(); scene.add(holder);
  controls = new OrbitControls(camera, canvas); controls.enableDamping = false; controls.enablePan = false; controls.minDistance = 1.2; controls.maxDistance = 6;
  controls.addEventListener('change', () => { placeLight(); render(); onChange && onChange(); });
  new ResizeObserver(resize).observe(canvas.parentElement); resize();
}
