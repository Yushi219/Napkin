// Parameter state + two Three.js views: the clay model (light, elegant) and
// the ink line-study (edges only, for the plan-mode split pane).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { sunAt, sunDirection, sunPath, seasonDate, getSite, setSite, daylightWindow } from './solar.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { polyArea } from './interpret.js';
import { buildParamTower, towerParamStats, disposeTowerGroup } from './tower.js';

export const state = {
  mode: 'massing',
  floors: 12,
  floorHeight: 3.6,
  baseWidth: 32,
  baseDepth: 26,
  segments: [],        // [{fromFloor, scale}] — stepped silhouette
  taper: 1,
  twist: 0,
  orientation: 0,
  footprint: null,     // [[x,z]…] metres, plan mode
  profile: null,       // [{t, w, cx}] — freeform lofted silhouette (curves, leans)
  profileSide: null,   // [{t, w, cx}] — depth profile from the side view
  masses: null,        // [{role,w,d,h,x,y,z,rotY,facade,cantilever}] — AI-read composition
  reading: null,       // the design intent, in the AI's words
  archetype: null,     // 'tower' switches to the fully parametric torso tower
  // --- torso-tower parameters (used when archetype === 'tower') ---
  segCount: 9,         // stacked modules with recessed joint floors between them
  spine: true,         // exposed helical truss following the twist
  finSpacing: 2.4,     // metres between facade fins
  cornerRadius: 5,
  podiumFloors: 0,
  podiumExpand: 0,
  liftGround: 0,
  balconyDepth: 0,
  crown: 'flat',
  setbacks: [],
  skyGardens: [],
  facade: 'glass',
  greenRoof: false,
  structure: 'concrete',
  type: 'office',
};

export function applyPatch(patch) {
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) state[k] = v;
  // A new set of volumes becomes the reference the scale slider works from,
  // so scaling stays lossless however far it is dragged either way.
  if (patch.masses !== undefined) captureMassBase();
  state.floors = Math.max(2, Math.min(70, Math.round(state.floors)));
  state.twist = Math.max(-90, Math.min(90, state.twist));
  state.taper = Math.max(0.4, Math.min(1.15, state.taper));
}

// ---- one scale for the whole composition ----
// Reading a drawing gives good proportions and shaky absolute size, so the
// size is worth a control of its own. Every dimension and position moves
// together against a stored baseline, which keeps repeated drags exact.
export function captureMassBase() {
  state.massBase = Array.isArray(state.masses) ? structuredClone(state.masses) : null;
  state.massScale = 1;
}
export function massScale() { return state.massScale || 1; }
export function scaleMasses(factor) {
  if (!Array.isArray(state.masses) || !Array.isArray(state.massBase)) return 1;
  const f = Math.max(0.2, Math.min(6, +factor || 1));
  const r2 = v => Math.round(v * 100) / 100;
  state.masses.forEach((m, i) => {
    const b = state.massBase[i];
    if (!b) return;
    for (const k of ['w', 'd', 'h', 'x', 'y', 'z']) m[k] = r2(b[k] * f);
  });
  state.massScale = f;
  return f;
}

// the tallest point of whatever is being designed, in metres
export function designedHeight() {
  if (Array.isArray(state.masses) && state.masses.length) {
    return Math.max(...state.masses.map(m => (+m.y || 0) + (+m.h || 0)));
  }
  return (state.floors || 12) * (state.floorHeight || 3.6);
}
function designedFootprint() {
  if (Array.isArray(state.masses) && state.masses.length) {
    const xs = state.masses.flatMap(m => [m.x - m.w / 2, m.x + m.w / 2]);
    const zs = state.masses.flatMap(m => [m.z - m.d / 2, m.z + m.d / 2]);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  }
  return Math.max(state.baseWidth || 32, state.baseDepth || 26);
}

export function snapshotState() { return structuredClone(state); }
export function restoreState(s) { Object.assign(state, structuredClone(s)); }

// ---------------- derived geometry helpers ----------------

function basePolygon() {
  if (state.footprint?.length >= 3) return state.footprint;
  const hw = state.baseWidth / 2, hd = state.baseDepth / 2;
  if (state.profile) {
    // freeform sections read organic — soften the plan into a capsule
    const r = Math.min(hw, hd) * 0.55;
    const pts = [];
    const corners = [[hw - r, -hd + r, -Math.PI / 2], [hw - r, hd - r, 0], [-hw + r, hd - r, Math.PI / 2], [-hw + r, -hd + r, Math.PI]];
    for (const [cx, cy, a0] of corners) {
      for (let k = 0; k <= 5; k++) {
        const a = a0 + (Math.PI / 2) * (k / 5);
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    }
    return pts;
  }
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
}

function segmentScale(f) {
  let s = 1;
  for (const seg of state.segments) if (f >= seg.fromFloor) s = seg.scale;
  return s;
}

function sampleProfile(p, t, scaleRef) {
  const x = t * (p.length - 1);
  const i = Math.min(p.length - 2, Math.floor(x));
  const k = x - i;
  return {
    w: p[i].w * (1 - k) + p[i + 1].w * k,
    cx: (p[i].cx * (1 - k) + p[i + 1].cx * k) * scaleRef,
  };
}
function profileAt(t) { return sampleProfile(state.profile, t, state.baseWidth); }
function sideAt(t) {
  if (!state.profileSide) return null;
  return sampleProfile(state.profileSide, t, state.baseDepth);
}

export function floorProfile(f) {
  const t = state.floors <= 1 ? 0 : f / (state.floors - 1);
  const rot = THREE.MathUtils.degToRad(state.twist * t + state.orientation);
  if (state.profile) {
    const { w, cx } = profileAt(t);
    return { scale: Math.max(0.12, w * (1 + (state.taper - 1) * t)), rot, cx };
  }
  const scale = segmentScale(f) * (1 + (state.taper - 1) * t);
  return { scale: Math.max(0.15, scale), rot, cx: 0 };
}

export function towerStats() {
  if (state.archetype === 'tower') {
    const st = towerParamStats(state);
    return {
      gfa: st.gfa, facade: st.facadeArea, height: st.height,
      area0: st.gfa / Math.max(state.floors, 1), minPlan: st.minPlan,
      bbW: state.baseWidth, bbD: state.baseDepth,
      plateDepth: Math.min(state.baseWidth, state.baseDepth) * state.taper,
    };
  }
  if (state.masses?.length) {
    let gfa = 0, facade = 0, height = 0, minPlanTall = 1e9, tallH = 0;
    let bbW = 0, bbD = 0, plateDepth = 0, plateArea = 0;
    for (const m of state.masses) {
      const occupied = m.kind !== 'member' && !['beam', 'column', 'post', 'frame', 'screen', 'railing', 'canopy', 'roof'].includes(m.role);
      const floors = m.storeys || Math.max(1, Math.round(m.h / state.floorHeight));
      if (occupied) {
        gfa += m.w * m.d * floors;
        facade += 2 * (m.w + m.d) * m.h;
      }
      height = Math.max(height, m.y + m.h);
      bbW = Math.max(bbW, Math.abs(m.x) + m.w / 2);
      bbD = Math.max(bbD, Math.abs(m.z) + m.d / 2);
      if (occupied && m.h > tallH) { tallH = m.h; minPlanTall = Math.min(m.w, m.d); }
      if (occupied && m.w * m.d > plateArea) { plateArea = m.w * m.d; plateDepth = Math.min(m.w, m.d); }
    }
    return { gfa, facade, height, area0: plateArea, minPlan: Number.isFinite(minPlanTall) ? minPlanTall : 1, bbW: bbW * 2, bbD: bbD * 2, plateDepth };
  }
  const height = state.floors * state.floorHeight;
  if (state.profile) {
    // lofted hull: per-floor width from front, depth from side (or aspect)
    const aspect = state.baseDepth / state.baseWidth;
    let gfa = 0, facade = 0, minW = 1e9, maxW = 0, maxD = 0;
    for (let f = 0; f < state.floors; f++) {
      const t = state.floors <= 1 ? 0 : f / (state.floors - 1);
      const w = profileAt(t).w * state.baseWidth;
      const dd = sideAt(t) ? sideAt(t).w * state.baseDepth : w * aspect;
      gfa += 0.88 * w * dd;                       // superellipse fill factor
      facade += Math.PI * (0.75 * (w + dd) - Math.sqrt(w * dd / 4)) * state.floorHeight * 0.5;
      minW = Math.min(minW, Math.min(w, dd));
      maxW = Math.max(maxW, w); maxD = Math.max(maxD, dd);
    }
    return { gfa, facade, height, area0: 0.88 * maxW * maxD, minPlan: Math.max(minW, 6), bbW: maxW, bbD: maxD, plateDepth: Math.min(maxW, maxD) };
  }
  const poly = basePolygon();
  const area0 = Math.abs(polyArea(poly));
  let per0 = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    per0 += Math.hypot(x2 - x1, y2 - y1);
  }
  let gfa = 0, facade = 0, minW = 1e9;
  let bbW = 0, bbD = 0;
  for (const [x, y] of poly) { bbW = Math.max(bbW, Math.abs(x) * 2); bbD = Math.max(bbD, Math.abs(y) * 2); }
  for (let f = 0; f < state.floors; f++) {
    const { scale } = floorProfile(f);
    gfa += area0 * scale * scale;
    facade += per0 * scale * state.floorHeight;
    minW = Math.min(minW, Math.min(bbW, bbD) * scale);
  }
  return { gfa, facade, height, area0, minPlan: minW, bbW, bbD, plateDepth: Math.min(bbW, bbD) };
}

// ---------------- three.js: clay view ----------------

let renderer, scene, camera, controls, towerGroup, sunLight;
let spin = false, sunAnim = false, sunPhase = 0.35;
let hemiLight, sunDisc, sunPathLine, contextGroup;
let sunDate = seasonDate('equinox');
let sunHour = 13;
let contextOn = true;
let pickCb = null;
let massGroups = [];
let selGroup = null;

// ---- study-model materials: white card vs basswood, like a real physical model
function woodTexture(scale = 1) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const c = cv.getContext('2d');
  c.fillStyle = '#d9b27a';
  c.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 340; i++) {
    const y = Math.random() * 512;
    const a = 0.03 + Math.random() * 0.10;
    c.strokeStyle = `rgba(${120 + Math.random() * 50 | 0},${80 + Math.random() * 40 | 0},${40 + Math.random() * 30 | 0},${a})`;
    c.lineWidth = 0.6 + Math.random() * 2.6;
    c.beginPath();
    for (let x = 0; x <= 512; x += 16) {
      const yy = y + Math.sin((x + y) * 0.012) * 5 + Math.sin(x * 0.05) * 1.6;
      x === 0 ? c.moveTo(x, yy) : c.lineTo(x, yy);
    }
    c.stroke();
  }
  for (let i = 0; i < 5; i++) {   // knots
    const kx = Math.random() * 512, ky = Math.random() * 512, r = 5 + Math.random() * 11;
    const g = c.createRadialGradient(kx, ky, 1, kx, ky, r);
    g.addColorStop(0, 'rgba(110,70,35,0.5)'); g.addColorStop(1, 'rgba(110,70,35,0)');
    c.fillStyle = g; c.beginPath(); c.arc(kx, ky, r, 0, 7); c.fill();
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(scale, scale);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let woodTex = null;
export const MODEL_MODES = ['sketch', 'white', 'wood'];
let modelMode = 'white';

const MAT = {
  clay: new THREE.MeshStandardMaterial({ color: 0xf7f3e9, roughness: 0.82, metalness: 0.02 }),
  band: new THREE.MeshStandardMaterial({ color: 0xcfc8b4, roughness: 0.9 }),
  roofGreen: new THREE.MeshStandardMaterial({ color: 0x8aa87b, roughness: 0.9 }),
  ground: new THREE.MeshStandardMaterial({ color: 0xefeadd, roughness: 1 }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0x8fa6ad, roughness: 0.15, metalness: 0.4, transparent: true, opacity: 0.88 }),
  fin: new THREE.MeshStandardMaterial({ color: 0xe6e0d1, roughness: 0.7 }),
};

const WHITE_SET = {
  clay: { color: 0xf7f3e9, roughness: 0.82 },
  band: { color: 0xcfc8b4, roughness: 0.9 },
  fin: { color: 0xe6e0d1, roughness: 0.7 },
  glass: { color: 0x8fa6ad, opacity: 0.88 },
};

// The species an architecture model shop actually stocks. Base colour, grain
// contrast and gloss differ per species; repeated clicks on Wood cycle them.
export const WOODS = [
  { id: 'basswood',  label: 'Basswood',       base: '#e7cfa2', grain: '#b98d54', gloss: 0.62, contrast: 0.5 },
  { id: 'balsa',     label: 'Balsa',          base: '#f2e3c3', grain: '#cbb083', gloss: 0.72, contrast: 0.3 },
  { id: 'oak',       label: 'White oak',      base: '#d9b98a', grain: '#8d6a3f', gloss: 0.55, contrast: 0.85 },
  { id: 'walnut',    label: 'Walnut',         base: '#8a6247', grain: '#4c3020', gloss: 0.5, contrast: 0.9 },
  { id: 'cherry',    label: 'Cherry',         base: '#b5714c', grain: '#7c4526', gloss: 0.48, contrast: 0.7 },
  { id: 'maple',     label: 'Maple',          base: '#ecd9b4', grain: '#c6a273', gloss: 0.58, contrast: 0.4 },
  { id: 'plywood',   label: 'Birch plywood',  base: '#ead9ad', grain: '#c8ab74', gloss: 0.6,  contrast: 0.55 },
  { id: 'cork',      label: 'Cork',           base: '#c9a678', grain: '#a37f52', gloss: 0.85, contrast: 0.35 },
];
let woodIndex = 0;
export function currentWood() { return WOODS[woodIndex % WOODS.length]; }
export function cycleWood() {
  woodIndex = (woodIndex + 1) % WOODS.length;
  woodCache = {};
  setModelMode('wood');
  rebuild();
  rebuildContext();
  return currentWood();
}

let woodCache = {};
function speciesTexture(scaleKey, scale) {
  const key = scaleKey + woodIndex;
  if (woodCache[key]) return woodCache[key];
  const W = currentWood();
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const c = cv.getContext('2d');
  c.fillStyle = W.base;
  c.fillRect(0, 0, 512, 512);
  const grain = new THREE.Color(W.grain);
  const n = Math.round(200 + W.contrast * 260);
  for (let i = 0; i < n; i++) {
    const y = Math.random() * 512;
    const a = (0.04 + Math.random() * 0.12) * W.contrast;
    c.strokeStyle = `rgba(${grain.r * 255 | 0},${grain.g * 255 | 0},${grain.b * 255 | 0},${a})`;
    c.lineWidth = 0.5 + Math.random() * (W.id === 'cork' ? 1.2 : 2.6);
    c.beginPath();
    for (let x = 0; x <= 512; x += 16) {
      const yy = W.id === 'cork'
        ? y + (Math.random() - 0.5) * 12
        : y + Math.sin((x + y) * 0.012) * 5 + Math.sin(x * 0.05) * 1.6;
      x === 0 ? c.moveTo(x, yy) : c.lineTo(x, yy);
    }
    c.stroke();
  }
  if (W.id !== 'cork' && W.id !== 'balsa') {
    for (let i = 0; i < 4 + W.contrast * 5; i++) {
      const kx = Math.random() * 512, ky = Math.random() * 512, r = 4 + Math.random() * 10;
      const g = c.createRadialGradient(kx, ky, 1, kx, ky, r);
      g.addColorStop(0, `rgba(60,38,20,${0.3 + W.contrast * 0.3})`);
      g.addColorStop(1, 'rgba(60,38,20,0)');
      c.fillStyle = g; c.beginPath(); c.arc(kx, ky, r, 0, 7); c.fill();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(scale, scale);
  t.colorSpace = THREE.SRGBColorSpace;
  woodCache[key] = t;
  return t;
}


// ================= Sketch world =================
// The third way of seeing the model: not a photograph and not a material
// study, but the drawing itself lifted into space — pencil edges, a haze of
// graphite dots where the surfaces are, a wobbly ground line. The kind of
// picture a designer shows when the idea matters more than the cladding.
let sketchGroup = null, sketchAtmos = null;

export function isSketchWorld() { return modelMode === 'sketch'; }

function disposeSketchWorld() {
  if (!sketchGroup) return;
  scene.remove(sketchGroup);
  sketchGroup.traverse(o => { o.geometry?.dispose(); if (o.material?.dispose) o.material.dispose(); });
  sketchGroup = null;
}

function syncSketchWorld() {
  if (!scene) return;
  const on = modelMode === 'sketch';
  if (towerGroup) towerGroup.visible = !on;
  if (contextGroup) contextGroup.visible = !on && contextOn;
  if (skyMesh) skyMesh.visible = !on;
  if (sunDisc) sunDisc.visible = !on && contextOn;
  if (sunPathLine) sunPathLine.visible = !on && contextOn;
  if (!on) {
    disposeSketchWorld();
    if (sketchAtmos) { scene.background = sketchAtmos.bg; scene.fog = sketchAtmos.fog; sketchAtmos = null; }
    return;
  }
  if (!sketchAtmos) sketchAtmos = { bg: scene.background, fog: scene.fog };
  scene.background = new THREE.Color(0xf7f3ea);
  scene.fog = null;
  buildSketchOverlay();
}

// deterministic wobble — a redraw must not shimmer
function swob(seed) {
  const x = Math.sin(seed * 91.7 + 40.9) * 23421.63;
  return (x - Math.floor(x)) - 0.5;
}

function buildSketchOverlay() {
  disposeSketchWorld();
  sketchGroup = new THREE.Group();

  const ink = new THREE.LineBasicMaterial({ color: 0x2e2f36, transparent: true, opacity: 0.9 });
  const inkGhost = new THREE.LineBasicMaterial({ color: 0x2e2f36, transparent: true, opacity: 0.2 });
  const ctxInk = new THREE.LineBasicMaterial({ color: 0x9a9183, transparent: true, opacity: 0.45 });

  const harvest = (root, mat, ghost, dotBudget, dotMat) => {
    if (!root) return;
    root.updateWorldMatrix(true, true);
    const meshes = [];
    root.traverse(o => { if (o.isMesh && o.geometry) meshes.push(o); });
    // spread the dot budget over the meshes by rough size
    let dotsLeft = dotBudget;
    for (const mesh of meshes) {
      const g = mesh.geometry;
      if (!g.boundingSphere) g.computeBoundingSphere();
      if (g.boundingSphere.radius > 500) continue;          // sky, the big ground plane
      const worlds = [];
      if (mesh.isInstancedMesh) {
        if (mesh.count > 140) continue;                      // a whole facade of slats — the edges would be soup
        const im = new THREE.Matrix4();
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, im);
          worlds.push(new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, im));
        }
      } else worlds.push(mesh.matrixWorld.clone());

      const eg = new THREE.EdgesGeometry(g, 26);
      for (const w of worlds) {
        const l = new THREE.LineSegments(eg, mat);
        l.applyMatrix4(w);
        sketchGroup.add(l);
        if (ghost) {
          // the pencil goes over a line twice, never exactly on top of itself
          const l2 = new THREE.LineSegments(eg, ghost);
          l2.applyMatrix4(w);
          l2.position.x += 0.09; l2.position.y += 0.12;
          sketchGroup.add(l2);
        }
      }
      if (dotMat && dotsLeft > 0 && !mesh.isInstancedMesh) {
        const n = Math.min(dotsLeft, Math.max(60, Math.round(g.boundingSphere.radius * 26)));
        const pts = stippleGeometry(g, mesh.matrixWorld, n);
        if (pts) { sketchGroup.add(new THREE.Points(pts, dotMat)); dotsLeft -= n; }
      }
    }
  };

  const buildingDots = new THREE.PointsMaterial({ color: 0x3a3b42, size: 0.55, transparent: true, opacity: 0.4, sizeAttenuation: true });
  const contextDots = new THREE.PointsMaterial({ color: 0x9a9183, size: 0.5, transparent: true, opacity: 0.22, sizeAttenuation: true });

  harvest(towerGroup, ink, inkGhost, 2600, buildingDots);
  if (contextOn) harvest(contextGroup, ctxInk, null, 1600, contextDots);

  // the ground: two overlapping freehand loops where the plot sits
  if (towerGroup) {
    const box = new THREE.Box3().setFromObject(towerGroup);
    const size = box.getSize(new THREE.Vector3());
    const r0 = Math.max(size.x, size.z) * 0.85 + 6;
    for (let pass = 0; pass < 2; pass++) {
      const pts = [];
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        const r = r0 * (1 + 0.035 * Math.sin(a * 3 + pass * 1.7) + swob(i + pass * 97) * 0.03);
        pts.push(new THREE.Vector3(Math.cos(a) * r, 0.25, Math.sin(a) * r));
      }
      const loop = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        pass ? inkGhost : new THREE.LineBasicMaterial({ color: 0x2e2f36, transparent: true, opacity: 0.5 }));
      sketchGroup.add(loop);
    }
  }
  scene.add(sketchGroup);
}

// Area-weighted points on the surface of a geometry — the graphite haze that
// stands in for shading. Deterministic, so the haze holds still between frames.
function stippleGeometry(geom, matrixWorld, count) {
  const pos = geom.attributes.position;
  if (!pos) return null;
  const idx = geom.index;
  const tris = idx ? idx.count / 3 : pos.count / 3;
  if (tris < 1) return null;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const read = (tri, corner, v) => {
    const i = idx ? idx.getX(tri * 3 + corner) : tri * 3 + corner;
    v.fromBufferAttribute(pos, i);
  };
  // cumulative areas
  const cum = new Float64Array(tris);
  let total = 0;
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    read(t, 0, A); read(t, 1, B); read(t, 2, C);
    ab.subVectors(B, A); ac.subVectors(C, A);
    total += ab.cross(ac).length() / 2;
    cum[t] = total;
  }
  if (!total) return null;
  const out = new Float32Array(count * 3);
  const P = new THREE.Vector3();
  for (let n = 0; n < count; n++) {
    const pick = (swob(n * 3.1) + 0.5) * total;
    let lo = 0, hi = tris - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; cum[mid] < pick ? lo = mid + 1 : hi = mid; }
    read(lo, 0, A); read(lo, 1, B); read(lo, 2, C);
    let u = swob(n * 7.3 + 11) + 0.5, v = swob(n * 13.7 + 5) + 0.5;
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    P.copy(A).addScaledVector(ab.subVectors(B, A), u).addScaledVector(ac.subVectors(C, A), v);
    P.applyMatrix4(matrixWorld);
    out[n * 3] = P.x; out[n * 3 + 1] = P.y; out[n * 3 + 2] = P.z;
  }
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.BufferAttribute(out, 3));
  return bg;
}

// In wood mode the WHOLE SCENE is the model shop: building, context blocks,
// ground, trees — everything cut from the same stock, like a real basswood site model.
export function isWoodWorld() { return modelMode === 'wood'; }
export function woodContextMaterial(kind) {
  const W = currentWood();
  if (kind === 'ground') return new THREE.MeshStandardMaterial({ map: speciesTexture('g', 8), roughness: W.gloss + 0.2 });
  if (kind === 'block') return new THREE.MeshStandardMaterial({ map: speciesTexture('b', 2), roughness: W.gloss });
  if (kind === 'leaf') return new THREE.MeshStandardMaterial({ map: speciesTexture('l', 1.2), color: 0xf0e2c4, roughness: W.gloss });
  if (kind === 'water') return new THREE.MeshStandardMaterial({ color: 0xcdd6d3, roughness: 0.12, metalness: 0.3 });
  return new THREE.MeshStandardMaterial({ map: speciesTexture('m', 3), roughness: W.gloss });
}

export function setModelMode(mode) {
  if (!MODEL_MODES.includes(mode)) return;
  modelMode = mode;
  if (mode === 'wood') {
    const W = currentWood();
    MAT.clay.map = speciesTexture('clay', 1);
    MAT.clay.color.setHex(0xffffff);
    MAT.clay.roughness = W.gloss;
    MAT.band.map = speciesTexture('band', 3);
    MAT.band.color.setHex(0xffffff);
    MAT.band.roughness = W.gloss + 0.08;
    MAT.fin.map = speciesTexture('fin', 1);
    MAT.fin.color.setHex(0xffffff);
    MAT.fin.roughness = W.gloss;
    MAT.glass.color.setHex(0x9fae9c);
    MAT.glass.opacity = 0.55;
  } else {
    MAT.clay.map = null; MAT.clay.color.setHex(WHITE_SET.clay.color); MAT.clay.roughness = WHITE_SET.clay.roughness;
    MAT.band.map = null; MAT.band.color.setHex(WHITE_SET.band.color); MAT.band.roughness = WHITE_SET.band.roughness;
    MAT.fin.map = null; MAT.fin.color.setHex(WHITE_SET.fin.color); MAT.fin.roughness = WHITE_SET.fin.roughness;
    MAT.glass.color.setHex(WHITE_SET.glass.color); MAT.glass.opacity = WHITE_SET.glass.opacity;
  }
  for (const m of [MAT.clay, MAT.band, MAT.fin, MAT.glass]) m.needsUpdate = true;
  if (scene && contextGroup) rebuildContext();
  syncSketchWorld();
}
export function getModelMode() { return modelMode; }

export function initModel(canvas, onPickMass) {
  pickCb = onPickMass || null;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.localClippingEnabled = true;   // the hand-gesture section cuts
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xfbfaf5);
  scene.fog = new THREE.Fog(0xfbfaf5, 260, 640);

  camera = new THREE.PerspectiveCamera(38, 1, 0.5, 1500);
  camera.position.set(95, 62, 110);

  controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 26, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  // No fixed ceiling on the tilt: an architect wants the worm's-eye view of a
  // tower against the sky. The only real limit is the ground, and that is
  // recomputed each frame from the actual target height and distance below.
  controls.maxPolarAngle = Math.PI * 0.995;
  controls.minPolarAngle = 0.02;
  controls.minDistance = 30;
  controls.maxDistance = 420;

  hemiLight = new THREE.HemisphereLight(0xfff8ec, 0xcfc9b8, 0.95);
  scene.add(hemiLight);
  sunLight = new THREE.DirectionalLight(0xfff2dd, 2.0);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  const S = 160;
  sunLight.shadow.camera.left = -S; sunLight.shadow.camera.right = S;
  sunLight.shadow.camera.top = S; sunLight.shadow.camera.bottom = -S;
  sunLight.shadow.camera.far = 700;
  sunLight.shadow.bias = -0.0004;
  positionSun();
  scene.add(sunLight, sunLight.target);

  buildSiteContext();
  buildSky();
  buildClouds();
  scene.fog = new THREE.Fog(0xe9eef0, 420, 1150);

  canvas.addEventListener('pointerdown', e => { canvas._d = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', e => {
    if (!canvas._d || Math.hypot(e.clientX - canvas._d[0], e.clientY - canvas._d[1]) > 5) return;
    pickMass(e, canvas);
  });

  const ro = new ResizeObserver(() => resize(canvas));
  ro.observe(canvas.parentElement);
  resize(canvas);
  renderer.setAnimationLoop(() => {
    if (spin) controls.autoRotate = true, controls.autoRotateSpeed = 0.55;
    else controls.autoRotate = false;
    if (sunAnim) { sunPhase += 0.0016; positionSun(); }
    stepParticles();
    driftClouds();
    clampTiltToGround();
    controls.update();
    renderer.render(scene, camera);
  });
}

function positionSun() {
  const { alt, az } = sunAt(sunDate, sunHour);
  const d = sunDirection(alt, az);
  const R = 320;
  sunLight.position.set(d.x * R, Math.max(d.y * R, 4), d.z * R);
  sunLight.target.position.set(0, 0, 0);
  const up = Math.max(Math.sin(alt), 0);
  const W = WEATHER[weatherKey];
  sunLight.intensity = (0.35 + up * 2.1) * W.sunMul;
  sunLight.color.setHSL(0.09, 0.5, 0.55 + up * 0.3);
  if (hemiLight) hemiLight.intensity = (0.45 + up * 0.55) * (0.7 + W.hazeMul * 0.35);
  updateSky(weatherKey === 'night' ? 0 : up, W);
  if (sunDisc) {
    sunDisc.visible = alt > -0.02;
    sunDisc.position.copy(sunLight.position);
  }
}
export function toggleSpin(on) { spin = on; }
export function toggleSun(on) { sunAnim = on; }

// Frame the camera the way the sketch was drawn: yaw around the building,
// pitch above the horizon. Called with Claude's reading of the sketch view.
// The render is made from one specific viewpoint; these let us pin it there so
// the overlay and the model line up pixel for pixel.
// How much of the building is actually inside the frame, and a camera that
// would hold all of it. A render can only be as good as its input image: if the
// tower is a sliver at the edge, the image model has nothing to work from.
export function buildingFraming() {
  if (!towerGroup || !camera) return { visible: 1 };
  const box = new THREE.Box3().setFromObject(towerGroup);
  if (box.isEmpty()) return { visible: 1 };
  const corners = [];
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z]) corners.push(new THREE.Vector3(x, y, z));
  let inside = 0;
  for (const c of corners) {
    const p = c.clone().project(camera);
    if (p.x >= -1 && p.x <= 1 && p.y >= -1 && p.y <= 1 && p.z < 1) inside++;
  }
  return { visible: inside / corners.length, box };
}

export function frameBuilding(margin = 1.5) {
  const { box } = buildingFraming();
  if (!box) return false;
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.5;
  const dist = (radius * margin) / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5));
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (!Number.isFinite(dir.x)) dir.set(0.6, 0.35, 0.72).normalize();
  camera.position.copy(centre.clone().add(dir.multiplyScalar(dist)));
  controls.target.copy(centre);
  controls.update();
  return true;
}

export function getCameraPose() {
  if (!camera || !controls) return null;
  return {
    pos: [camera.position.x, camera.position.y, camera.position.z],
    target: [controls.target.x, controls.target.y, controls.target.z],
    fov: camera.fov,
  };
}
export function restoreCameraPose(p) {
  if (!p || !camera || !controls) return;
  camera.position.set(p.pos[0], p.pos[1], p.pos[2]);
  controls.target.set(p.target[0], p.target[1], p.target[2]);
  if (p.fov) { camera.fov = p.fov; camera.updateProjectionMatrix(); }
  controls.update();
}

export function setCameraAngle(yawDeg, pitchDeg, fovDeg) {
  const st = towerStats();
  const r = Math.max(st.bbW, st.bbD, st.height) * 1.9 + 25;
  const yaw = THREE.MathUtils.degToRad(yawDeg ?? 30);
  const pitch = THREE.MathUtils.degToRad(Math.max(4, Math.min(70, pitchDeg ?? 18)));
  if (Number.isFinite(+fovDeg)) {
    camera.fov = Math.max(20, Math.min(65, +fovDeg));
    camera.updateProjectionMatrix();
  }
  camera.position.set(
    Math.sin(yaw) * Math.cos(pitch) * r,
    Math.sin(pitch) * r + st.height * 0.35,
    Math.cos(yaw) * Math.cos(pitch) * r,
  );
  controls.target.set(0, st.height * 0.38, 0);
  controls.update();
}

// ---- picking + selection outlines ----

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
function pickMass(e, canvas) {
  if (!pickCb || !state.masses?.length || !towerGroup) return;
  const r = canvas.getBoundingClientRect();
  _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  _ray.setFromCamera(_ndc, camera);
  const hits = _ray.intersectObjects(towerGroup.children, true);
  for (const h of hits) {
    let o = h.object;
    while (o && o.userData.massIndex === undefined) o = o.parent;
    if (o) { pickCb(o.userData.massIndex); return; }
  }
  pickCb(null); // clicked past the building — clear
}

// ---- site context: ground, streets, city fabric, trees, sun path ----

function seeded(i) { const x = Math.sin(i * 127.1) * 43758.5453; return x - Math.floor(x); }

// Landscape settings are program-specific: a laboratory campus and a museum
// forecourt are not the same ground. Each building type carries five settings
// that an architect would actually propose for it.
// Ten settings that are genuinely different places, not four sliders on the
// same square. Each one changes the terrain, the surrounding building stock,
// the road pattern, the planting and the amount of open ground — a tower in a
// downtown canyon and the same tower on a river meadow should not be
// recognisable as the same scene.
export const SETTINGS = [
  {
    id: 'downtown', label: 'Downtown core',
    note: 'Hemmed in by towers, narrow streets, almost no green',
    ground: 'paved', terrain: 'flat', plot: 42, roads: 'grid', roadW: 15,
    fabric: { style: 'tower', rings: 3, count: 13, near: 96, gap: 0.1, hMin: 18, hMax: 150, wMin: 20, wMax: 42, mix: 'skyline' },
    planting: { kind: 'street', density: 0.35 }, water: 'none', props: 'urban',
  },
  {
    id: 'startup', label: 'Innovation campus',
    note: 'Few sculptural neighbours, generous open ground between them',
    ground: 'lawn', terrain: 'gentle', plot: 74, roads: 'loop', roadW: 11,
    fabric: { style: 'pavilion', rings: 2, count: 5, near: 175, gap: 0.42, hMin: 9, hMax: 26, wMin: 26, wMax: 46 },
    planting: { kind: 'grove', density: 0.55 }, water: 'reflect', props: 'campus',
  },
  {
    id: 'residential', label: 'Residential quarter',
    note: 'Pitched-roof houses, back gardens, parked cars, quiet streets',
    ground: 'paved', terrain: 'flat', plot: 48, roads: 'grid', roadW: 10,
    fabric: { style: 'house', rings: 3, count: 16, near: 88, gap: 0.08, hMin: 7, hMax: 14, wMin: 12, wMax: 20 },
    planting: { kind: 'garden', density: 0.85 }, water: 'none', props: 'residential',
  },
  {
    id: 'citypark', label: 'City park',
    note: 'Standing inside the green, dense canopy, paths and a pond',
    ground: 'lawn', terrain: 'gentle', plot: 64, roads: 'path', roadW: 5,
    fabric: { style: 'block', rings: 2, count: 8, near: 235, gap: 0.3, hMin: 16, hMax: 42, wMin: 20, wMax: 34 },
    planting: { kind: 'forest', density: 1.0 }, water: 'pond', props: 'park',
  },
  {
    id: 'wild', label: 'Natural clearing',
    note: 'Rolling uneven ground, rocks, scrub and wild trees — no city',
    ground: 'meadow', terrain: 'rolling', plot: 0, roads: 'track', roadW: 4,
    fabric: { style: 'none', rings: 0, count: 0, near: 0, gap: 0, hMin: 0, hMax: 0, wMin: 0, wMax: 0 },
    planting: { kind: 'wild', density: 1.0 }, water: 'none', props: 'wild',
  },
  {
    id: 'river', label: 'River bank',
    note: 'A river cutting past the plot, embankment wall, willows',
    ground: 'lawn', terrain: 'gentle', plot: 52, roads: 'quay', roadW: 9,
    fabric: { style: 'block', rings: 2, count: 9, near: 150, gap: 0.22, hMin: 14, hMax: 46, wMin: 18, wMax: 32 },
    planting: { kind: 'riparian', density: 0.8 }, water: 'river', props: 'river',
  },
  {
    id: 'harbour', label: 'Harbour edge',
    note: 'Open water, quay cranes, sheds and hard standing',
    ground: 'gravel', terrain: 'flat', plot: 56, roads: 'quay', roadW: 13,
    fabric: { style: 'shed', rings: 2, count: 8, near: 140, gap: 0.25, hMin: 8, hMax: 22, wMin: 30, wMax: 52 },
    planting: { kind: 'sparse', density: 0.25 }, water: 'harbour', props: 'harbour',
  },
  {
    id: 'oldtown', label: 'Old town',
    note: 'Tight low blocks, lanes, a small square, tiled roofs',
    ground: 'paved', terrain: 'flat', plot: 34, roads: 'lanes', roadW: 7,
    fabric: { style: 'oldblock', rings: 3, count: 18, near: 74, gap: 0.05, hMin: 11, hMax: 24, wMin: 14, wMax: 26 },
    planting: { kind: 'street', density: 0.3 }, water: 'fountain', props: 'oldtown',
  },
  {
    id: 'hillside', label: 'Hillside terraces',
    note: 'Sloping ground, retaining walls, olive-grove planting',
    ground: 'gravel', terrain: 'slope', plot: 58, roads: 'switchback', roadW: 8,
    fabric: { style: 'terracehouse', rings: 2, count: 10, near: 120, gap: 0.18, hMin: 8, hMax: 20, wMin: 16, wMax: 28 },
    planting: { kind: 'orchard', density: 0.7 }, water: 'none', props: 'hillside',
  },
  {
    id: 'industrial', label: 'Industrial yard',
    note: 'Warehouses, containers, wide hard standing, chain-link edges',
    ground: 'gravel', terrain: 'flat', plot: 70, roads: 'grid', roadW: 17,
    fabric: { style: 'shed', rings: 2, count: 11, near: 128, gap: 0.16, hMin: 9, hMax: 20, wMin: 34, wMax: 60 },
    planting: { kind: 'sparse', density: 0.18 }, water: 'none', props: 'industrial',
  },
];

let siteIndex = 0;
let siteKind = 'office';
let ctxSeed = 7;

export function getLandscape() { return SETTINGS[siteIndex % SETTINGS.length]; }
export function landscapeChoices() { return SETTINGS; }
export function landscapeDetails(L) { return (L || getLandscape()).note; }

// Single click walks to the next setting; a double click comes home to the first.
export function cycleLandscape(dir = 1) {
  siteIndex = (siteIndex + dir + SETTINGS.length) % SETTINGS.length;
  ctxSeed = 100 + siteIndex * 37;      // stable per setting, so it never shimmers
  rebuildContext();
  return getLandscape();
}
export function resetLandscape() {
  siteIndex = 0;
  ctxSeed = 100;
  rebuildContext();
  return getLandscape();
}
export function setLandscape(id) {
  const i = SETTINGS.findIndex(x => x.id === id);
  if (i >= 0) { siteIndex = i; ctxSeed = 100 + i * 37; rebuildContext(); }
  return getLandscape();
}
export function shuffleSite() { return cycleLandscape(1); }
export function setSiteKind(kind) { siteKind = kind; return getLandscape(); }

function rnd(i) { const x = Math.sin((i + ctxSeed) * 127.1) * 43758.5453; return x - Math.floor(x); }

// Ground height for the rolling / sloping settings — the plot itself is levelled
// so the building always meets flat ground, and the terrain rises beyond it.
function terrainHeight(x, z, L) {
  if (L.terrain === 'flat') return 0;
  const d = Math.hypot(x, z);
  const flat = Math.max(0, Math.min(1, (d - 58) / 52));      // 0 on the plot, 1 outside
  let h = 0;
  if (L.terrain === 'rolling') {
    h = Math.sin(x * 0.012 + 1.3) * 7 + Math.cos(z * 0.009) * 6.5 + Math.sin((x + z) * 0.02) * 2.6;
  } else if (L.terrain === 'gentle') {
    h = Math.sin(x * 0.008) * 3 + Math.cos(z * 0.007 + 0.6) * 2.6;
  } else if (L.terrain === 'slope') {
    h = z * 0.13 + Math.sin(x * 0.015) * 2.4;
  }
  return h * flat;
}

function rebuildContext() {
  if (contextGroup) {
    scene.remove(contextGroup);
    contextGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }
  buildSiteContext();
  contextGroup.visible = contextOn;
  syncSketchWorld();
}

const GROUND_COL = { paved: 0xdcd6c4, lawn: 0x8fa878, meadow: 0xa8ac7a, gravel: 0xcfc7b4 };
const BASE_COL = { paved: 0xe9e4d6, lawn: 0xdfe4d2, meadow: 0xe1e3d0, gravel: 0xe4e0d4 };

function fabricFor(L) {
  const F = L.fabric;
  const want = Math.max(9, designedHeight() * 1.7);
  const k = Math.min(1, want / F.hMax);
  if (k > 0.92) return F;                       // already the right register
  const grow = 0.45 + k * 0.55;                 // blocks shrink less than they shorten
  return { ...F,
    hMin: Math.max(3, F.hMin * k),
    hMax: Math.max(6, F.hMax * k),
    near: Math.max(24, F.near * grow),
    wMin: Math.max(5, F.wMin * grow),
    wMax: Math.max(9, F.wMax * grow),
  };
}

// ---- the real site: measured footprints and measured ground ----
let realSite = null;    // { label, radius, buildings: [{poly,h,name}], terrain }
export function setRealSiteData(data) {
  realSite = data;
  if (scene && contextGroup) rebuildContext();
}
export function clearRealSiteData() {
  realSite = null;
  if (scene && contextGroup) rebuildContext();
}
export function hasRealSite() { return !!realSite; }

function realTerrainAt(x, z) {
  const g = realSite?.terrain;
  if (!g) return 0;
  const { n, radius, heights } = g;
  const u = Math.max(0, Math.min(n - 1.001, ((x + radius) / (2 * radius)) * (n - 1)));
  const v = Math.max(0, Math.min(n - 1.001, ((z + radius) / (2 * radius)) * (n - 1)));
  const i = Math.floor(u), j = Math.floor(v);
  const fu = u - i, fv = v - j;
  const h00 = heights[j * n + i] ?? 0, h10 = heights[j * n + i + 1] ?? h00;
  const h01 = heights[(j + 1) * n + i] ?? h00, h11 = heights[(j + 1) * n + i + 1] ?? h10;
  // the parcel itself stays level so the building sits honestly
  const flat = Math.max(0, 1 - Math.hypot(x, z) / 46);
  return ((h00 * (1 - fu) + h10 * fu) * (1 - fv) + (h01 * (1 - fu) + h11 * fu) * fv) * (1 - flat);
}

function buildRealContext(mat, PAL, wood) {
  const R = Math.max(realSite.radius * 1.6, 260);
  groundMatRef = wood ? woodContextMaterial('ground')
    : new THREE.MeshStandardMaterial({ color: PAL.base, roughness: 1 });
  const groundGeo = new THREE.PlaneGeometry(R * 2, R * 2, 72, 72);
  if (realSite.terrain) {
    const pos = groundGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, realTerrainAt(pos.getX(i), -pos.getY(i)));
    groundGeo.computeVertexNormals();
  }
  const ground = new THREE.Mesh(groundGeo, groundMatRef);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  contextGroup.add(ground);

  const inParcel = pt => realSite.parcelLocal ? _pip(pt, realSite.parcelLocal) : Math.hypot(pt[0], pt[1]) < 34;

  // ---- the parcel: the drawn polygon, cleared and levelled for the design ----
  if (realSite.parcelLocal) {
    try {
      const sh = new THREE.Shape();
      realSite.parcelLocal.forEach(([x, z], i) => i ? sh.lineTo(x, -z) : sh.moveTo(x, -z));
      sh.closePath();
      const plate = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: 0.9, bevelEnabled: false }), mat(PAL.plot, 0.97));
      plate.rotation.x = -Math.PI / 2;
      plate.position.y = 0.05;
      plate.receiveShadow = true;
      contextGroup.add(plate);
    } catch { /* degenerate parcel */ }
  } else {
    const plot = new THREE.Mesh(new THREE.CylinderGeometry(30, 31.5, 1.1, 40), mat(PAL.plot, 0.97));
    plot.position.y = 0.2;
    plot.receiveShadow = true;
    contextGroup.add(plot);
  }

  // ---- green: parks, lawns, woods as soft plates ----
  const greenMat = wood ? woodContextMaterial('leaf') : new THREE.MeshStandardMaterial({ color: 0xb2c096, roughness: 1 });
  for (const g of realSite.green || []) {
    try {
      const sh = new THREE.Shape();
      g.poly.forEach(([x, z], i) => i ? sh.lineTo(x, -z) : sh.moveTo(x, -z));
      sh.closePath();
      const m = new THREE.Mesh(new THREE.ShapeGeometry(sh), greenMat);
      m.rotation.x = -Math.PI / 2;
      const cgx = g.poly.reduce((a, q) => a + q[0], 0) / g.poly.length;
      const cgz = g.poly.reduce((a, q) => a + q[1], 0) / g.poly.length;
      const gy = realTerrainAt(cgx, cgz);
      const gAbs0 = Number.isFinite(realSite.terrain?.centreAbs) ? realSite.terrain.centreAbs : null;
      if (gAbs0 !== null && gy + gAbs0 < 0.7) continue;   // that "lawn" is under water
      m.position.y = gy + 0.12;
      m.receiveShadow = true;
      contextGroup.add(m);
    } catch { /* skip */ }
  }

  // ---- water: bodies as plates, rivers as ribbons ----
  const waterMat = wood ? woodContextMaterial('block') : new THREE.MeshStandardMaterial({ color: 0x9db8c6, roughness: 0.35, metalness: 0.1 });

  // The sea. A harbour is not a polygon in OSM — it is coastline, and the
  // water is everything at sea level. The terrain grid keeps its absolute
  // datum, so when the scene touches sea level (or the data shows coastline),
  // one large water plane at absolute zero does what the map cannot: land
  // stays above it, the harbour reads as water everywhere the ground dips.
  const abs0 = Number.isFinite(realSite.terrain?.centreAbs) ? realSite.terrain.centreAbs : null;
  const coastal = (realSite.coast?.length || 0) > 0
    || (abs0 !== null && Math.min(...(realSite.terrain?.heights || [99])) + abs0 < 1.2);
  if (coastal && abs0 !== null) {
    const seaY = 0.22 - abs0;                    // absolute ~0.2 m, in scene terms
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(R * 2.4, R * 2.4), waterMat);
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = seaY;
    contextGroup.add(sea);
    // piers stand just proud of the water
    const pierMatTop = wood ? woodContextMaterial('block') : new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.95 });
    for (const pr of realSite.piers || []) {
      try {
        const sh = new THREE.Shape();
        pr.poly.forEach(([x, z], i) => i ? sh.lineTo(x, -z) : sh.moveTo(x, -z));
        sh.closePath();
        const deck = new THREE.Mesh(new THREE.ExtrudeGeometry(sh, { depth: 1.1, bevelEnabled: false }), pierMatTop);
        deck.rotation.x = -Math.PI / 2;
        deck.position.y = seaY + 0.15;
        deck.castShadow = deck.receiveShadow = true;
        contextGroup.add(deck);
      } catch { /* skip */ }
    }
  }
  for (const w of realSite.water || []) {
    try {
      if (w.line) {
        addRibbon(w.pts, w.w, waterMat, () => 0.06, false);
      } else {
        const sh = new THREE.Shape();
        w.poly.forEach(([x, z], i) => i ? sh.lineTo(x, -z) : sh.moveTo(x, -z));
        sh.closePath();
        const m = new THREE.Mesh(new THREE.ShapeGeometry(sh), waterMat);
        m.rotation.x = -Math.PI / 2;
        m.position.y = 0.08;
        contextGroup.add(m);
      }
    } catch { /* skip */ }
  }

  // ---- roads: real polylines at their real widths; bridges rise and carry piers ----
  const roadMat = wood ? woodContextMaterial('ground') : new THREE.MeshStandardMaterial({ color: 0xbcb6a8, roughness: 0.98 });
  const bridgeMat = wood ? woodContextMaterial('block') : new THREE.MeshStandardMaterial({ color: 0xb6b0a2, roughness: 0.9 });
  const pierMat = wood ? woodContextMaterial('block') : new THREE.MeshStandardMaterial({ color: 0x9a9488, roughness: 0.95 });
  for (const rd of realSite.roads || []) {
    if (rd.bridge) {
      addRibbon(rd.pts, rd.w, bridgeMat, () => 3.4, true, pierMat);
    } else {
      addRibbon(rd.pts, rd.w, roadMat, (x, z) => realTerrainAt(x, z) + 0.1, false);
    }
  }

  function addRibbon(pts, width, material, liftAt, isBridge, piers) {
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, z1] = pts[i], [x2, z2] = pts[i + 1];
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (len < 0.5) continue;
      // each segment overshoots by its width so bends close instead of gapping
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(len + width * 0.9, isBridge ? 0.6 : 0.18, width), material);
      const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2;
      mesh.position.set(mx, liftAt(mx, mz) + (isBridge ? 0 : 0), mz);
      mesh.rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      mesh.receiveShadow = true;
      if (isBridge) mesh.castShadow = true;
      contextGroup.add(mesh);
      if (isBridge && piers && len > 10) {
        for (const t of [0.3, 0.7]) {
          const px = x1 + (x2 - x1) * t, pz = z1 + (z2 - z1) * t;
          const pier = new THREE.Mesh(new THREE.BoxGeometry(1.2, 3.4, 1.2), piers);
          pier.position.set(px, 1.7, pz);
          pier.castShadow = true;
          contextGroup.add(pier);
        }
      }
    }
  }

  // ---- the neighbours: measured footprints, minus everything in the parcel ----
  const stock = wood ? null : [
    new THREE.MeshStandardMaterial({ color: 0xe3ded3, roughness: 0.92 }),
    new THREE.MeshStandardMaterial({ color: 0xd6d0c3, roughness: 0.92 }),
    new THREE.MeshStandardMaterial({ color: 0xc9c3b6, roughness: 0.92 }),
  ];
  let bi = 0;
  for (const b of realSite.buildings || []) {
    const cx = b.poly.reduce((a, q) => a + q[0], 0) / b.poly.length;
    const cz = b.poly.reduce((a, q) => a + q[1], 0) / b.poly.length;
    if (inParcel([cx, cz])) continue;              // the ground being designed
    try {
      const sh = new THREE.Shape();
      b.poly.forEach(([x, z], i) => i ? sh.lineTo(x, -z) : sh.moveTo(x, -z));
      sh.closePath();
      const geo = new THREE.ExtrudeGeometry(sh, { depth: b.h, bevelEnabled: false });
      const mesh = new THREE.Mesh(geo, wood ? woodContextMaterial('block') : stock[bi++ % 3]);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = realTerrainAt(cx, cz);
      mesh.castShadow = mesh.receiveShadow = true;
      contextGroup.add(mesh);
    } catch { /* degenerate footprint */ }
  }
}

// local point-in-polygon (mirrors site.js — kept private to avoid a cycle)
function _pip([px, pz], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function buildSiteContext() {
  const L = getLandscape();
  const wood = isWoodWorld();
  const W0 = WEATHER[weatherKey];
  contextGroup = new THREE.Group();

  const PAL = {
    paved:  { base: 0xe4dfd2, plot: 0xd6cfbc },
    lawn:   { base: 0xcfd8bc, plot: 0x93ab77 },
    meadow: { base: 0xcdd0a8, plot: 0xafb47e },
    gravel: { base: 0xdcd6c8, plot: 0xc7bfae },
  }[L.ground] || { base: 0xe4dfd2, plot: 0xd6cfbc };

  const mat = (colour, rough = 0.95, metal = 0) => wood
    ? woodContextMaterial('block')
    : new THREE.MeshStandardMaterial({ color: colour, roughness: rough, metalness: metal });

  // A pinned real site replaces the invented fabric entirely: measured
  // footprints, measured ground, nothing imagined.
  if (realSite) {
    buildRealContext(mat, PAL, wood);
    scene.add(contextGroup);
    if (!sunDisc) { /* the disc block below still runs on the invented path */ }
    buildRealTail();
    return;
  }

  // ---------- terrain ----------
  groundMatRef = wood ? woodContextMaterial('ground')
    : new THREE.MeshStandardMaterial({ color: PAL.base, roughness: 1 });
  if (!wood) {
    groundMatRef.roughness = 1 - W0.wet * 0.78;
    groundMatRef.metalness = W0.wet * 0.35;
  }
  const SEG = L.terrain === 'flat' ? 1 : 96;
  const groundGeo = new THREE.PlaneGeometry(1240, 1240, SEG, SEG);
  if (L.terrain !== 'flat') {
    const pos = groundGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setZ(i, terrainHeight(pos.getX(i), -pos.getY(i), L));
    }
    groundGeo.computeVertexNormals();
  }
  const ground = new THREE.Mesh(groundGeo, groundMatRef);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  contextGroup.add(ground);

  // the plot: always level so the building sits properly, and never so wide
  // that a small building looks marooned on it
  const plotR = Math.max(12, Math.min(L.plot, designedFootprint() * 1.9));
  if (L.plot > 0) {
    const plot = new THREE.Mesh(
      new THREE.CylinderGeometry(plotR, plotR + 1.5, 1.1, 40),
      mat(PAL.plot, 0.97));
    plot.position.y = 0.2;
    plot.receiveShadow = true;
    contextGroup.add(plot);
  }

  // ---------- roads / paths ----------
  const roadMat = mat(L.roads === 'path' || L.roads === 'track' ? 0xcfc6b0 : 0xb9b6ab, 1);
  const strip = (w, d, x, z, rot = 0) => {
    const r = new THREE.Mesh(new THREE.BoxGeometry(w, 0.24, d), roadMat);
    r.position.set(x, terrainHeight(x, z, L) + 0.14, z);
    r.rotation.y = rot;
    r.receiveShadow = true;
    contextGroup.add(r);
  };
  const RW = L.roadW;
  if (L.roads === 'grid') {
    // a city grid is never perfectly square: blocks differ, one street runs askew
    strip(1100, RW, 0, L.plot + 22);
    strip(1100, RW * 0.8, 0, -(L.plot + 30 + rnd(1) * 16));
    strip(RW, 1100, L.plot + 26 + rnd(2) * 14, 0);
    strip(RW * 0.75, 1100, -(L.plot + 24), 0);
    strip(900, RW * 0.7, 40, -(L.plot + 120), 0.22);       // the diagonal avenue
    strip(RW * 0.6, 700, -(L.plot + 150), 60, 0.12);
  } else if (L.roads === 'loop') {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(L.plot + 26, RW / 2, 6, 60), roadMat);
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.16; ring.scale.z = 0.35;
    ring.receiveShadow = true; contextGroup.add(ring);
    strip(RW, 420, 0, -(L.plot + 200));
  } else if (L.roads === 'lanes') {
    strip(900, RW, 0, L.plot + 16, 0.06);
    strip(RW, 900, -(L.plot + 18), 0, 0.05);
    strip(700, RW * 0.7, 40, -(L.plot + 30), -0.3);
  } else if (L.roads === 'quay') {
    strip(1100, RW, 0, -(L.plot + 20));
  } else if (L.roads === 'switchback') {
    for (let i = 0; i < 3; i++) strip(760, RW, 0, -70 - i * 78, (i % 2 ? 1 : -1) * 0.1);
  } else if (L.roads === 'path') {
    for (let k = 0; k < 3; k++) {
      const pts = [];
      for (let i = 0; i <= 26; i++) {
        const t = i / 26, ang = k * 2.1 + t * 2.4;
        const rr = L.plot + 8 + t * 150;
        const x = Math.cos(ang) * rr, z = Math.sin(ang) * rr;
        pts.push(new THREE.Vector3(x, terrainHeight(x, z, L) + 0.5, z));
      }
      const path = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 2.4, 4, false), roadMat);
      path.scale.y = 0.08; path.receiveShadow = true;
      contextGroup.add(path);
    }
  } else if (L.roads === 'track') {
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24, x = -260 + t * 520, z = 90 + Math.sin(t * 4) * 40;
      pts.push(new THREE.Vector3(x, terrainHeight(x, z, L) + 0.5, z));
    }
    const track = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 44, 3, 4, false), roadMat);
    track.scale.y = 0.06;
    contextGroup.add(track);
  }

  // ---------- water ----------
  const waterMat = wood ? woodContextMaterial('water')
    : new THREE.MeshStandardMaterial({ color: 0x8fa9b5, roughness: 0.12, metalness: 0.55 });
  if (L.water === 'river') {
    const pts = [];
    for (let i = 0; i <= 30; i++) {
      const t = i / 30;
      pts.push(new THREE.Vector3(-380 + t * 760, 0, 120 + Math.sin(t * 3.1) * 54));
    }
    const river = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 26, 5, false), waterMat);
    river.scale.y = 0.02; river.position.y = 0.4;
    contextGroup.add(river);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(700, 3, 5), mat(0xcdc6b4, 0.95));
    wall.position.set(0, 1.4, 88); wall.castShadow = true;
    contextGroup.add(wall);
  } else if (L.water === 'harbour') {
    const basin = new THREE.Mesh(new THREE.CircleGeometry(300, 60), waterMat);
    basin.rotation.x = -Math.PI / 2;
    basin.position.set(-40, 0.35, 250);
    contextGroup.add(basin);
    const quay = new THREE.Mesh(new THREE.BoxGeometry(560, 2.4, 22), mat(0xcfc8b6, 0.96));
    quay.position.set(0, 1.2, 92); quay.receiveShadow = true;
    contextGroup.add(quay);
  } else if (L.water === 'pond') {
    const pond = new THREE.Mesh(new THREE.CircleGeometry(34, 40), waterMat);
    pond.rotation.x = -Math.PI / 2;
    pond.position.set(78, terrainHeight(78, 72, L) + 0.5, 72);
    contextGroup.add(pond);
  } else if (L.water === 'reflect') {
    const pool = new THREE.Mesh(new THREE.BoxGeometry(64, 0.5, 18), waterMat);
    pool.position.set(0, 0.6, 62);
    contextGroup.add(pool);
  } else if (L.water === 'fountain') {
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 1, 26), waterMat);
    basin.position.set(0, 0.7, 54);
    contextGroup.add(basin);
  }

  // ---------- surrounding building stock ----------
  // Neighbours belong in the same league as the thing being designed: a seven
  // metre house dropped in a downtown core reads as a toy on a plaza. The
  // fabric keeps its character and changes register.
  const F = fabricFor(L);
  const stockMats = wood ? null : [
    new THREE.MeshStandardMaterial({ color: 0xe3ded3, roughness: 0.92 }),
    new THREE.MeshStandardMaterial({ color: 0xd6d0c3, roughness: 0.92 }),
    new THREE.MeshStandardMaterial({ color: 0xc9c3b6, roughness: 0.92 }),
    new THREE.MeshStandardMaterial({ color: 0xd8c9b2, roughness: 0.9 }),
  ];
  const oldMats = wood ? null : [
    new THREE.MeshStandardMaterial({ color: 0xe0cfae, roughness: 0.95 }),
    new THREE.MeshStandardMaterial({ color: 0xd3bb9a, roughness: 0.95 }),
    new THREE.MeshStandardMaterial({ color: 0xc7ab8b, roughness: 0.95 }),
  ];
  const roofMat = mat(0xa8654a, 0.9);
  const shedMat = mat(0xb8bcbb, 0.7, 0.25);
  const glassMat = wood ? woodContextMaterial('block')
    : new THREE.MeshStandardMaterial({ color: 0x9fb3ba, roughness: 0.25, metalness: 0.45 });

  let n = 0;
  for (let ring = 1; ring <= F.rings; ring++) {
    const count = Math.round(F.count * (ring === 1 ? 0.8 : 1));
    for (let i = 0; i < count; i++) {
      n += 5;
      if (rnd(n) < F.gap) continue;
      const a = (i / count) * Math.PI * 2 + ring * 0.5 + rnd(n + 1) * 0.35;
      const rad = F.near + (ring - 1) * (F.near * 0.72) + rnd(n) * F.near * 0.35;
      const x = Math.cos(a) * rad, z = Math.sin(a) * rad;
      const gy = terrainHeight(x, z, L);
      const w = F.wMin + rnd(n + 1) * (F.wMax - F.wMin);
      const d = F.wMin * 0.8 + rnd(n + 2) * (F.wMax - F.wMin) * 0.9;
      // A skyline is mostly mid-rise with a few peaks — a flat power curve
      // would wall the site in. Nearer rings also stay lower so the building
      // being designed is never completely hidden.
      const peak = rnd(n + 8);
      const shape = F.mix === 'skyline'
        ? (peak > 0.86 ? 0.75 + rnd(n + 9) * 0.25         // the occasional tower
          : peak > 0.6 ? 0.32 + rnd(n + 9) * 0.3          // mid-rise
          : 0.06 + rnd(n + 9) * 0.24)                     // low blocks
        : Math.pow(rnd(n + 3), 1.5);
      const ringDamp = ring === 1 ? 0.55 : ring === 2 ? 0.85 : 1;
      const h = F.hMin + shape * (F.hMax - F.hMin) * ringDamp;
      const rot = rnd(n + 4) * 0.5 - 0.25;

      if (F.style === 'house') {
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), stockMats ? stockMats[n % 4] : mat(0xdedad0));
        body.position.set(x, gy + h / 2, z); body.rotation.y = rot;
        body.castShadow = body.receiveShadow = true; contextGroup.add(body);
        const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.78, h * 0.55, 4), roofMat);
        roof.position.set(x, gy + h + h * 0.26, z);
        roof.rotation.y = rot + Math.PI / 4; roof.castShadow = true;
        contextGroup.add(roof);
      } else if (F.style === 'oldblock') {
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), oldMats ? oldMats[n % 3] : mat(0xd8c4a4));
        body.position.set(x, gy + h / 2, z); body.rotation.y = rot;
        body.castShadow = body.receiveShadow = true; contextGroup.add(body);
        const roof = new THREE.Mesh(new THREE.BoxGeometry(w * 1.04, 1.2, d * 1.04), roofMat);
        roof.position.set(x, gy + h + 0.6, z); roof.rotation.y = rot;
        contextGroup.add(roof);
      } else if (F.style === 'shed') {
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), shedMat);
        body.position.set(x, gy + h / 2, z); body.rotation.y = rot;
        body.castShadow = body.receiveShadow = true; contextGroup.add(body);
        if (rnd(n + 7) > 0.6) {
          for (let c = 0; c < 3; c++) {
            const box = new THREE.Mesh(new THREE.BoxGeometry(9, 2.6, 2.6),
              mat([0xb3543f, 0x3f6b8a, 0x6c7a4a][c % 3], 0.85));
            box.position.set(x + (rnd(n + c) - 0.5) * w, gy + 1.3 + c * 2.7, z + d * 0.7);
            box.castShadow = true; contextGroup.add(box);
          }
        }
      } else if (F.style === 'pavilion') {
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), rnd(n + 9) > 0.45 ? glassMat : (stockMats ? stockMats[n % 4] : mat(0xdedad0)));
        body.position.set(x, gy + h / 2, z); body.rotation.y = rot;
        body.castShadow = body.receiveShadow = true; contextGroup.add(body);
        const cap = new THREE.Mesh(new THREE.BoxGeometry(w * 1.16, 0.8, d * 1.16), mat(0xece7dc, 0.85));
        cap.position.set(x, gy + h + 0.4, z); cap.rotation.y = rot;
        cap.castShadow = true; contextGroup.add(cap);
      } else if (F.style === 'terracehouse') {
        const step = Math.round(2 + rnd(n + 3) * 3);
        for (let t = 0; t < step; t++) {
          const bw = w * (1 - t * 0.12);
          const body = new THREE.Mesh(new THREE.BoxGeometry(bw, h / step, d * (1 - t * 0.1)),
            stockMats ? stockMats[(n + t) % 4] : mat(0xdedad0));
          body.position.set(x + t * 2.2, gy + (h / step) * (t + 0.5), z - t * 2.2);
          body.rotation.y = rot; body.castShadow = body.receiveShadow = true;
          contextGroup.add(body);
        }
      } else if (F.style === 'tower') {
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), stockMats ? stockMats[n % 4] : mat(0xdedad0));
        body.position.set(x, gy + h / 2, z); body.rotation.y = rot;
        body.castShadow = body.receiveShadow = true; contextGroup.add(body);
        if (rnd(n + 6) > 0.55) {
          const cap = new THREE.Mesh(new THREE.BoxGeometry(w * 0.6, h * 0.22, d * 0.6), stockMats ? stockMats[(n + 2) % 4] : mat(0xdedad0));
          cap.position.set(x, gy + h + h * 0.11, z); cap.rotation.y = rot;
          cap.castShadow = true; contextGroup.add(cap);
        }
      } else if (F.style === 'block') {
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), stockMats ? stockMats[n % 4] : mat(0xdedad0));
        body.position.set(x, gy + h / 2, z); body.rotation.y = rot;
        body.castShadow = body.receiveShadow = true; contextGroup.add(body);
      }
    }
  }

  // ---------- planting ----------
  const leafMats = wood ? [woodContextMaterial('tree')] : [
    new THREE.MeshStandardMaterial({ color: 0x6f8f5c, roughness: 0.92 }),
    new THREE.MeshStandardMaterial({ color: 0x83a06b, roughness: 0.92 }),
    new THREE.MeshStandardMaterial({ color: 0x5d7d50, roughness: 0.92 }),
    new THREE.MeshStandardMaterial({ color: 0x94a86f, roughness: 0.92 }),
  ];
  const trunkMat = wood ? woodContextMaterial('tree') : new THREE.MeshStandardMaterial({ color: 0x7d6549, roughness: 0.95 });

  const tree = (x, z, sc, shape) => {
    if (Math.hypot(x, z) < L.plot + 4) return;
    const gy = terrainHeight(x, z, L);
    const lm = leafMats[Math.abs(Math.round(x + z)) % leafMats.length];
    let leaf, trunkH = 3.6 * sc;
    if (shape === 'conifer') {
      leaf = new THREE.Mesh(new THREE.ConeGeometry(2.6 * sc, 9 * sc, 8), lm);
      leaf.position.set(x, gy + 5.6 * sc, z);
    } else if (shape === 'column') {
      leaf = new THREE.Mesh(new THREE.CylinderGeometry(1.5 * sc, 1.9 * sc, 8 * sc, 8), lm);
      leaf.position.set(x, gy + 6.4 * sc, z);
    } else if (shape === 'willow') {
      leaf = new THREE.Mesh(new THREE.SphereGeometry(3.4 * sc, 8, 6), lm);
      leaf.position.set(x, gy + 5.4 * sc, z);
      leaf.scale.set(1.2, 0.8, 1.2);
    } else {
      leaf = new THREE.Mesh(new THREE.SphereGeometry(3 * sc, 8, 6), lm);
      leaf.position.set(x, gy + 5.4 * sc, z);
      leaf.scale.y = 1.1;
    }
    leaf.castShadow = true;
    contextGroup.add(leaf);
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.24 * sc, 0.34 * sc, trunkH, 6), trunkMat);
    tr.position.set(x, gy + trunkH / 2, z);
    contextGroup.add(tr);
  };

  const P = L.planting;
  const many = Math.round(P.density * 46);
  if (P.kind === 'street') {
    for (let i = 0; i < many; i++) {
      const along = -150 + (i / Math.max(many - 1, 1)) * 300;
      tree(along, L.plot + 20, 0.85, 'column');
      if (i % 2 === 0) tree(L.plot + 24, along, 0.85, 'column');
    }
  } else if (P.kind === 'grove') {
    for (let i = 0; i < many; i++) {
      const a = rnd(i * 3) * Math.PI * 2, r = L.plot + 18 + rnd(i * 3 + 1) * 120;
      tree(Math.cos(a) * r, Math.sin(a) * r, 0.8 + rnd(i) * 0.6);
    }
  } else if (P.kind === 'forest') {
    for (let i = 0; i < many * 2.4; i++) {
      const a = rnd(i * 3) * Math.PI * 2, r = L.plot + 10 + rnd(i * 3 + 1) * 210;
      tree(Math.cos(a) * r, Math.sin(a) * r, 0.7 + rnd(i) * 0.9, rnd(i * 5) > 0.7 ? 'conifer' : 'round');
    }
  } else if (P.kind === 'wild') {
    for (let i = 0; i < many * 2; i++) {
      const a = rnd(i * 3) * Math.PI * 2, r = 40 + rnd(i * 3 + 1) * 300;
      tree(Math.cos(a) * r, Math.sin(a) * r, 0.6 + rnd(i) * 1.1, rnd(i * 7) > 0.55 ? 'conifer' : 'round');
    }
    for (let i = 0; i < 60; i++) {          // rocks and scrub
      const a = rnd(500 + i) * Math.PI * 2, r = 40 + rnd(600 + i) * 280;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.8 + rnd(700 + i) * 2.4, 0),
        mat(0xb9b2a4, 0.98));
      rock.position.set(x, terrainHeight(x, z, L) + 0.6, z);
      rock.rotation.set(rnd(i), rnd(i + 1), rnd(i + 2));
      rock.castShadow = true;
      contextGroup.add(rock);
    }
  } else if (P.kind === 'riparian') {
    for (let i = 0; i < many; i++) {
      const x = -300 + rnd(i) * 600;
      tree(x, 96 + rnd(i + 2) * 22, 0.9 + rnd(i) * 0.5, 'willow');
    }
    for (let i = 0; i < many * 0.5; i++) {
      const a = rnd(i * 3) * Math.PI * 2, r = L.plot + 16 + rnd(i * 3 + 1) * 80;
      tree(Math.cos(a) * r, Math.sin(a) * r, 0.8);
    }
  } else if (P.kind === 'garden') {
    for (let i = 0; i < many; i++) {
      const a = rnd(i * 3) * Math.PI * 2, r = L.plot + 14 + rnd(i * 3 + 1) * 130;
      tree(Math.cos(a) * r, Math.sin(a) * r, 0.55 + rnd(i) * 0.5);
    }
  } else if (P.kind === 'orchard') {
    for (let r = 0; r < 5; r++) for (let c = 0; c < 7; c++) {
      const x = -70 + c * 22, z = L.plot + 26 + r * 20;
      tree(x, z, 0.75, 'round');
    }
  } else {
    for (let i = 0; i < Math.max(4, many); i++) {
      const a = rnd(i) * Math.PI * 2, r = L.plot + 22 + rnd(i + 3) * 90;
      tree(Math.cos(a) * r, Math.sin(a) * r, 0.75);
    }
  }

  scene.add(contextGroup);

  buildRealTail();
}

function buildRealTail() {
  if (!sunDisc) {
    sunDisc = new THREE.Mesh(new THREE.SphereGeometry(6, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffe9a8 }));
    scene.add(sunDisc);
    sunPathLine = new THREE.Line(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xd9b45f, transparent: true, opacity: 0.55 }));
    scene.add(sunPathLine);
    updateSunPath();
    // The disc is born at the origin — the middle of the model — and only
    // positionSun() moves it into the sky. That call ran before this disc
    // existed, so without this line it sat glowing inside the building until
    // the first drag of the sun slider.
    positionSun();
  }
}

function updateSunPath() {
  if (!sunPathLine) return;
  const R = 320;
  const pts = sunPath(sunDate).map(p => {
    const d = sunDirection(p.alt, p.az);
    return new THREE.Vector3(d.x * R, Math.max(d.y * R, 1), d.z * R);
  });
  sunPathLine.geometry.dispose();
  sunPathLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  sunPathLine.visible = pts.length > 1;
}

export function setSunTime({ date, hour, site }) {
  if (site) { setSite(site); updateSunPath(); }
  if (date) { sunDate = date; updateSunPath(); }
  if (hour !== undefined) sunHour = hour;
  positionSun();
}
export function getSunTime() { return { date: sunDate, hour: sunHour, site: getSite(), window: daylightWindow(sunDate) }; }
export function toggleContext(on) { contextOn = on; if (contextGroup) contextGroup.visible = on; if (sunPathLine) sunPathLine.visible = on; if (sunDisc) sunDisc.visible = on; syncSketchWorld(); }



// ---- weather -------------------------------------------------------------
// One shared set of conditions for every building: sky tint, sun strength,
// fog depth, ground sheen, and live particles for rain and snow. It is the
// difference between a study model and a simulator.
export const WEATHER = {
  clear:    { label: 'Clear day',        note: 'Blue sky with a few fair-weather clouds', sunMul: 1.00, hazeMul: 0.92, fogNear: 620, fogFar: 1400, tint: null,      wet: 0,    particles: null, cloud: 0.20, cloudType: 'cumulus', hour: null, sky: 'day' },
  scattered:{ label: 'Scattered clouds', note: 'Sun and shadow move across the site',      sunMul: 0.82, hazeMul: 1.05, fogNear: 560, fogFar: 1280, tint: '#dce9f0', wet: 0,    particles: null, cloud: 0.52, cloudType: 'cumulus', hour: null, sky: 'day' },
  cirrus:   { label: 'Dramatic cloud',   note: 'High-contrast cloud structure and crisp light',sunMul: 0.88,hazeMul: 1.00, fogNear: 600, fogFar: 1380, tint: '#e7edf2', wet: 0,    particles: null, cloud: 0.40, cloudType: 'layered', hour: null, sky: 'day' },
  overcast: { label: 'Overcast',         note: 'Soft shadowless light under a cloud deck', sunMul: 0.34, hazeMul: 1.30, fogNear: 480, fogFar: 1120, tint: '#cbd2d7', wet: 0.05, particles: null, cloud: 0.94, cloudType: 'overcast',hour: null, sky: 'day' },
  shower:   { label: 'Passing shower',   note: 'Visible rain, wet ground, brighter horizon',sunMul: 0.40, hazeMul: 1.38, fogNear: 420, fogFar: 980,  tint: '#9fadb8', wet: 0.88, particles: 'rain', cloud: 0.82, cloudType: 'shower',  hour: null, sky: 'day' },
  snow:     { label: 'Snowfall',         note: 'Cold diffuse sky and drifting snow',       sunMul: 0.46, hazeMul: 1.42, fogNear: 430, fogFar: 960,  tint: '#dce5ec', wet: 0.18, particles: 'snow', cloud: 0.90, cloudType: 'snow',    hour: null, sky: 'day' },
  golden:   { label: 'Golden hour',      note: 'Low warm sun with textured evening cloud', sunMul: 0.82, hazeMul: 1.18, fogNear: 520, fogFar: 1200, tint: '#efaa75', wet: 0,    particles: null, cloud: 0.40, cloudType: 'cumulus', hour: 'sunset', sky: 'golden' },
  night:    { label: 'Moonlit night',    note: 'Deep blue sky, stars and faint high cloud',sunMul: 0.035,hazeMul: 0.78, fogNear: 500, fogFar: 1150, tint: '#172943', wet: 0.12, particles: null, cloud: 0.22, cloudType: 'cirrus',  hour: 'night', sky: 'night' },
  fog:      { label: 'Morning fog',      note: 'Everything beyond the site dissolves',     sunMul: 0.30, hazeMul: 1.9,  fogNear: 55,  fogFar: 330,  tint: '#d3d7d4', wet: 0.42, particles: null, cloud: 0.85, cloudType: 'overcast',hour: 'dawn',  sky: 'day' },
  storm:    { label: 'Storm front',      note: 'Bruised sky, hard rain, wet reflective ground', sunMul: 0.20, hazeMul: 1.6, fogNear: 260, fogFar: 720, tint: '#6f7a88', wet: 0.95, particles: 'rain', cloud: 1.0, cloudType: 'shower', hour: null, sky: 'day' },
};
export const WEATHER_ORDER = ['clear','scattered','cirrus','overcast','shower','storm','snow','fog','golden','night'];

let weatherKey = 'scattered';
let particles = null, particleKind = null;

export function getWeather() { return Object.assign({ key: weatherKey }, WEATHER[weatherKey]); }
export function resetWeather() { return setWeather(WEATHER_ORDER[0]); }
export function cycleWeather(dir = 1) {
  const i = WEATHER_ORDER.indexOf(weatherKey);
  return setWeather(WEATHER_ORDER[(i + dir + WEATHER_ORDER.length) % WEATHER_ORDER.length]);
}

export function setWeather(key) {
  if (!WEATHER[key]) return getWeather();
  weatherKey = key;
  const w = WEATHER[key];
  // dawn / sunset / night are times of day, not just palettes — move the sun
  if (w.hour) {
    const win = daylightWindow(sunDate) || { rise: 6, set: 18 };
    sunHour = w.hour === 'dawn' ? Math.min(win.rise + 0.6, 23)
      : w.hour === 'sunset' ? Math.max(win.set - 0.5, 0)
      : (win.set + 3) % 24;
    updateSunPath();
  }
  if (scene && scene.fog) { scene.fog.near = w.fogNear; scene.fog.far = w.fogFar; }
  if (groundMatRef) {
    groundMatRef.roughness = 1 - w.wet * 0.78;
    groundMatRef.metalness = w.wet * 0.35;
    groundMatRef.needsUpdate = true;
  }
  buildParticles(w.particles);
  updateClouds(w.cloud);
  positionSun();          // re-derives light, sky and haze for the new condition
  return getWeather();
}

let groundMatRef = null;

function buildParticles(kind) {
  if (particles) { scene.remove(particles); particles.geometry.dispose(); particles.material.dispose(); particles = null; }
  particleKind = kind;
  if (!kind) return;
  const N = kind === 'rain' ? 3000 : kind === 'drizzle' ? 1800 : 1500;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 420;
    pos[i * 3 + 1] = Math.random() * 260;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 420;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const m = new THREE.PointsMaterial({
    color: kind === 'snow' ? 0xffffff : 0xbcc6d0,
    size: kind === 'snow' ? 1.5 : kind === 'drizzle' ? 0.35 : 0.6,
    transparent: true,
    opacity: kind === 'snow' ? 0.85 : kind === 'drizzle' ? 0.35 : 0.6,
    depthWrite: false,
    fog: true,
  });
  particles = new THREE.Points(g, m);
  particles.frustumCulled = false;
  scene.add(particles);
}

function stepParticles() {
  if (!particles) return;
  const a = particles.geometry.getAttribute('position');
  const fall = particleKind === 'rain' ? 4.2 : particleKind === 'drizzle' ? 2.2 : 0.55;
  const drift = particleKind === 'snow' ? 0.32 : 0.5;
  for (let i = 0; i < a.count; i++) {
    let y = a.getY(i) - fall;
    let x = a.getX(i) + drift;
    if (particleKind === 'snow') x += Math.sin((y + i) * 0.05) * 0.25;
    if (y < 0) { y = 250 + Math.random() * 20; }
    if (x > 210) x = -210;
    a.setX(i, x);
    a.setY(i, y);
  }
  a.needsUpdate = true;
}


// ---- photographic 360° sky ----------------------------------------------
// Each condition uses a real CC0 equirectangular panorama. The model still
// drives sun angle, light intensity, haze, wetness and precipitation; the
// visible clouds themselves are photographed rather than synthesized.
let skyMesh, skyMat;
const skyLoader = new THREE.TextureLoader();
const skyCache = new Map();
const skyLoading = new Set();
let requestedSky = '';
const SKY_URLS = Object.fromEntries(WEATHER_ORDER.map(k => [k, `assets/skies/${k}.jpg?v=16`]));

function loadSkyPanorama(key) {
  if (!skyMat || !SKY_URLS[key]) return;
  requestedSky = key;
  if (skyCache.has(key)) {
    skyMat.map = skyCache.get(key);
    skyMat.needsUpdate = true;
    return;
  }
  if (skyLoading.has(key)) return;
  skyLoading.add(key);
  skyLoader.load(SKY_URLS[key], tex => {
    skyLoading.delete(key);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() || 1);
    tex.offset.x = 0.08;
    skyCache.set(key, tex);
    if (requestedSky === key && skyMat) {
      skyMat.map = tex;
      skyMat.needsUpdate = true;
    }
  }, undefined, err => { skyLoading.delete(key); console.warn(`Sky panorama failed to load: ${key}`, err); });
}

function buildClouds() {
  // Kept as an init hook; the cloud field now lives in the 360° panorama.
  loadSkyPanorama(weatherKey);
}

function updateClouds() { loadSkyPanorama(weatherKey); }
function driftClouds() { /* photographic sky stays spatially stable */ }

function buildSky() {
  skyMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false, fog: false, color: 0xffffff });
  skyMesh = new THREE.Mesh(new THREE.SphereGeometry(900, 64, 32), skyMat);
  skyMesh.renderOrder = -1;
  scene.add(skyMesh);
  loadSkyPanorama(weatherKey);
  updateSky(0.6);
}

function mix(a, b, t) {
  const ca = new THREE.Color(a), cb = new THREE.Color(b);
  return '#' + ca.lerp(cb, Math.max(0, Math.min(1, t))).getHexString();
}

function updateSky(sunUp, W) {
  if (!skyMat) return;
  W = W || WEATHER[weatherKey];
  // sunUp: 0 at the horizon, 1 overhead
  const day = Math.max(0, Math.min(1, sunUp));
  const dusk = Math.max(0, 1 - day * 2.4);            // strong near sunrise/sunset
  const top = mix(mix('#1d3557', '#2f6ea8', day * 1.6), '#5d9bd4', day);
  const horizon = mix(mix('#f0a97a', '#dbe9f2', day * 1.3), '#eaf2f6', day * 0.7);
  const ground = mix('#c9b9a0', '#e6e2d6', day);
  let topC = top, horC = horizon;
  if (W.tint) {
    topC = mix(top, W.tint, 0.62);
    horC = mix(horizon, W.tint, 0.5);
  }
  loadSkyPanorama(weatherKey);
  if (scene.fog) {
    scene.fog.color.set(mix(horC, '#e9eef0', 0.3));
    scene.fog.near = W.fogNear; scene.fog.far = W.fogFar;
  }
  // haze in the distance ties the city to the sky
  scene.background = null;
  const wash = new THREE.Color(mix(horC, topC, 0.25));
  if (hemiLight) hemiLight.color.copy(wash);
  const dim = 0.35 + dusk * 0.25;
  if (skyMesh) skyMesh.material.color.setScalar(W.sky === 'night' ? 0.72 : 1 - dim * 0.08);
}


// ---- gesture camera control ----------------------------------------------
export function orbitCamera(dxNorm, dyNorm) {
  const off = camera.position.clone().sub(controls.target);
  const sph = new THREE.Spherical().setFromVector3(off);
  sph.theta -= dxNorm * 2.4;
  sph.phi = Math.max(0.08, Math.min(Math.PI * 0.94, sph.phi - dyNorm * 1.8));
  off.setFromSpherical(sph);
  camera.position.copy(controls.target).add(off);
  camera.lookAt(controls.target);
}
export function zoomCamera(factor) {
  const off = camera.position.clone().sub(controls.target);
  const len = Math.max(8, Math.min(900, off.length() * factor));
  off.setLength(len);
  camera.position.copy(controls.target).add(off);
}

// ---- drag a volume in the ground plane (used by hand control) ----
let dragState = null;
const _plane = new THREE.Plane();
const _hit = new THREE.Vector3();

// ================= Hand-model verbs =================
// The gestures speak to the model through these three: an exploded axon, a
// live section cut, and face-level push-pull on the quad cage.

// ---- audit shells ----
// The audit view's paint: a translucent shell in the finding's colour around
// every volume with a problem, floating just proud of the faces so the model
// stays readable underneath. Rebuilt whenever the audit reruns.
let auditGroup = null;
export function showAuditShells(worstByElement, colors) {
  clearAuditShells();
  if (!state.masses?.length) return;
  auditGroup = new THREE.Group();
  state.masses.forEach((m, i) => {
    const sev = worstByElement[m.id];
    if (!sev) return;
    const mat = new THREE.MeshBasicMaterial({
      color: colors[sev], transparent: true, opacity: sev === 'blocker' ? 0.4 : 0.3,
      depthWrite: false,
    });
    const shell = new THREE.Mesh(new THREE.BoxGeometry(m.w + 0.35, m.h + 0.35, m.d + 0.35), mat);
    shell.position.set(m.x, m.y + m.h / 2, m.z);
    shell.rotation.y = THREE.MathUtils.degToRad(m.rotY || 0);
    auditGroup.add(shell);
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(shell.geometry),
      new THREE.LineBasicMaterial({ color: colors[sev], transparent: true, opacity: 0.9 }));
    edge.position.copy(shell.position);
    edge.rotation.copy(shell.rotation);
    auditGroup.add(edge);
  });
  scene.add(auditGroup);
}
export function clearAuditShells() {
  if (!auditGroup) return;
  scene.remove(auditGroup);
  auditGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); });
  auditGroup = null;
}

// ---- exploded axonometric ----
// Two palms spreading apart lift the composition into its layers, the way an
// exploded axon diagram reads. The offsets are a view transform on the groups;
// state.masses never changes, so closing the palms restores exactly.
let explodeT = 0;
export function setExplode(t) {
  explodeT = Math.max(0, Math.min(1, +t || 0));
  applyExplode();
}
export function getExplode() { return explodeT; }
function applyExplode() {
  if (!state.masses?.length || !massGroups.length) return;
  const order = state.masses.map((m, i) => ({ i, y: m.y }))
    .sort((a, b) => a.y - b.y || a.i - b.i);
  const gap = Math.max(2.5, state.masses.reduce((a, m) => a + m.h, 0) / state.masses.length * 0.9);
  order.forEach((o, rank) => {
    const g = massGroups[o.i], m = state.masses[o.i];
    if (g) g.position.y = m.y + m.h / 2 + rank * gap * explodeT;
  });
}

// ---- section cuts ----
// A chopping palm slides a vertical cut through the building; a palm turned
// to the sky raises and lowers a horizontal one. Only the building's own
// materials clip — the city and the ground stay whole.
let sectionOn = false;
const _secPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
function sectionMats() { return [MAT.clay, MAT.band, MAT.fin, MAT.glass]; }
export function setSection(axis, t01) {
  if (!towerGroup) return;
  const box = new THREE.Box3().setFromObject(towerGroup);
  if (box.isEmpty()) return;
  const t = Math.max(0, Math.min(1, +t01 || 0));
  if (axis === 'y') {
    // hand high = ceiling high (whole building), hand low = cut down to the base
    const cutY = box.max.y + 0.5 - t * (box.max.y - box.min.y + 1);
    _secPlane.normal.set(0, -1, 0);
    _secPlane.constant = cutY;
  } else {
    const cutX = box.min.x - 0.5 + t * (box.max.x - box.min.x + 1);
    _secPlane.normal.set(-1, 0, 0);
    _secPlane.constant = cutX;
  }
  if (!sectionOn) {
    sectionOn = true;
    for (const m of sectionMats()) { m.clippingPlanes = [_secPlane]; m.needsUpdate = true; }
  }
}
export function clearSection() {
  if (!sectionOn) return;
  sectionOn = false;
  for (const m of sectionMats()) { m.clippingPlanes = null; m.needsUpdate = true; }
}

// ---- face aim + push-pull ----
// Point (thumb and index open) and the face under the cursor lights up;
// pinch grabs it; moving the hand pushes or pulls that face of the cage —
// the volume resizes the way clay would; opening the fingers lets go.
let faceHi = null, faceHover = null, faceDrag = null;
const _axisVec = new THREE.Vector3();

function pickFaceAt(nx, ny) {
  if (!state.masses?.length || !towerGroup) return null;
  _ndc.set(nx * 2 - 1, -(ny * 2 - 1));
  _ray.setFromCamera(_ndc, camera);
  const hits = _ray.intersectObjects(towerGroup.children, true);
  for (const h of hits) {
    if (!h.face) continue;
    let o = h.object;
    while (o && o.userData.massIndex === undefined) o = o.parent;
    if (!o) continue;
    const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
    const ax = Math.abs(n.x) >= Math.abs(n.y) && Math.abs(n.x) >= Math.abs(n.z) ? 'x'
      : Math.abs(n.y) >= Math.abs(n.z) ? 'y' : 'z';
    const sign = (ax === 'x' ? n.x : ax === 'y' ? n.y : n.z) >= 0 ? 1 : -1;
    return { i: o.userData.massIndex, axis: ax, sign, point: h.point.clone() };
  }
  return null;
}

function faceHiMesh() {
  if (faceHi) return faceHi;
  faceHi = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0xbd5f3d, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
  faceHi.visible = false;
  scene.add(faceHi);
  return faceHi;
}

function placeFaceHi(m, axis, sign) {
  const hi = faceHiMesh();
  const cy = m.y + m.h / 2;
  hi.rotation.set(0, 0, 0);
  if (axis === 'x') {
    hi.scale.set(m.d, m.h, 1);
    hi.rotation.y = sign > 0 ? Math.PI / 2 : -Math.PI / 2;
    hi.position.set(m.x + sign * (m.w / 2 + 0.07), cy, m.z);
  } else if (axis === 'z') {
    hi.scale.set(m.w, m.h, 1);
    hi.rotation.y = sign > 0 ? 0 : Math.PI;
    hi.position.set(m.x, cy, m.z + sign * (m.d / 2 + 0.07));
  } else {
    hi.scale.set(m.w, m.d, 1);
    hi.rotation.x = sign > 0 ? -Math.PI / 2 : Math.PI / 2;
    hi.position.set(m.x, m.y + (sign > 0 ? m.h + 0.07 : -0.07), m.z);
  }
  hi.visible = true;
}

export function hoverFace(nx, ny) {
  const hit = pickFaceAt(nx, ny);
  if (!hit) { clearFaceHover(); return false; }
  faceHover = hit;
  placeFaceHi(state.masses[hit.i], hit.axis, hit.sign);
  return true;
}
export function clearFaceHover() {
  faceHover = null;
  if (faceHi) faceHi.visible = false;
}

export function beginFaceDrag(nx, ny) {
  const hit = faceHover || pickFaceAt(nx, ny);
  if (!hit) return false;
  const m = state.masses[hit.i];
  _axisVec.set(hit.axis === 'x' ? 1 : 0, hit.axis === 'y' ? 1 : 0, hit.axis === 'z' ? 1 : 0);
  // the drag reads along the face's axis, measured on the view plane through the grab point
  _ndc.set(nx * 2 - 1, -(ny * 2 - 1));
  _ray.setFromCamera(_ndc, camera);
  const camDir = camera.getWorldDirection(new THREE.Vector3());
  _plane.setFromNormalAndCoplanarPoint(camDir, hit.point);
  if (!_ray.ray.intersectPlane(_plane, _hit)) return false;
  faceDrag = { ...hit, start: _hit.clone(), m0: { w: m.w, d: m.d, h: m.h, x: m.x, y: m.y, z: m.z } };
  controls.enabled = false;
  placeFaceHi(m, hit.axis, hit.sign);
  return true;
}

export function moveFaceDrag(nx, ny) {
  if (!faceDrag) return;
  _ndc.set(nx * 2 - 1, -(ny * 2 - 1));
  _ray.setFromCamera(_ndc, camera);
  if (!_ray.ray.intersectPlane(_plane, _hit)) return;
  const d = _hit.clone().sub(faceDrag.start).dot(_axisVec);
  const m = state.masses[faceDrag.i], m0 = faceDrag.m0;
  const r2 = v => Math.round(v * 100) / 100;
  if (faceDrag.axis === 'x') {
    m.w = r2(Math.max(0.1, m0.w + d * faceDrag.sign));
    m.x = r2(m0.x + d / 2);
  } else if (faceDrag.axis === 'z') {
    m.d = r2(Math.max(0.1, m0.d + d * faceDrag.sign));
    m.z = r2(m0.z + d / 2);
  } else if (faceDrag.sign > 0) {
    m.h = r2(Math.max(0.1, m0.h + d));
  } else {
    const top = m0.y + m0.h;
    m.y = r2(Math.max(0, Math.min(top - 0.1, m0.y + d)));
    m.h = r2(top - m.y);
  }
  // cheap live feedback: scale the group; the true rebuild lands on release
  const g = massGroups[faceDrag.i];
  if (g) {
    g.scale.set(m.w / m0.w, m.h / m0.h, m.d / m0.d);
    g.position.set(m.x, m.y + m.h / 2, m.z);
  }
  placeFaceHi(m, faceDrag.axis, faceDrag.sign);
}

export function endFaceDrag() {
  if (!faceDrag) return null;
  const i = faceDrag.i;
  faceDrag = null;
  controls.enabled = true;
  clearFaceHover();
  rebuild();
  return i;
}

export function pickAt(nx, ny) {
  if (!state.masses?.length || !towerGroup) return null;
  _ndc.set(nx * 2 - 1, -(ny * 2 - 1));
  _ray.setFromCamera(_ndc, camera);
  const hits = _ray.intersectObjects(towerGroup.children, true);
  for (const h of hits) {
    let o = h.object;
    while (o && o.userData.massIndex === undefined) o = o.parent;
    if (o) return o.userData.massIndex;
  }
  return null;
}

export function beginDrag(nx, ny) {
  const i = pickAt(nx, ny);
  if (i === null) return null;
  const ms = state.masses[i];
  _ndc.set(nx * 2 - 1, -(ny * 2 - 1));
  _ray.setFromCamera(_ndc, camera);
  _plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, ms.y + ms.h / 2, 0));
  if (!_ray.ray.intersectPlane(_plane, _hit)) return null;
  dragState = { i, grabX: _hit.x, grabZ: _hit.z, startX: ms.x, startZ: ms.z };
  controls.enabled = false;
  return i;
}

export function moveDrag(nx, ny) {
  if (!dragState) return;
  const ms = state.masses[dragState.i];
  _ndc.set(nx * 2 - 1, -(ny * 2 - 1));
  _ray.setFromCamera(_ndc, camera);
  if (!_ray.ray.intersectPlane(_plane, _hit)) return;
  ms.x = Math.max(-80, Math.min(80, dragState.startX + (_hit.x - dragState.grabX)));
  ms.z = Math.max(-80, Math.min(80, dragState.startZ + (_hit.z - dragState.grabZ)));
  const g = massGroups[dragState.i];
  if (g) g.position.set(ms.x, ms.y + ms.h / 2, ms.z);
  setSelection([dragState.i]);
}

export function endDrag() {
  const i = dragState?.i ?? null;
  dragState = null;
  controls.enabled = true;
  return i;
}

export function setSelection(indices) {
  if (selGroup) { scene.remove(selGroup); selGroup.traverse(o => o.geometry?.dispose()); selGroup = null; }
  if (!indices?.length || !state.masses) return;
  selGroup = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0xbd5f3d, linewidth: 2 });
  for (const i of indices) {
    const ms = state.masses[i];
    if (!ms) continue;
    const g = new THREE.BoxGeometry(ms.w + 0.6, ms.h + 0.6, ms.d + 0.6);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), mat);
    e.position.set(ms.x, ms.y + ms.h / 2, ms.z);
    e.rotation.y = THREE.MathUtils.degToRad(ms.rotY || 0);
    selGroup.add(e);
    g.dispose();
  }
  scene.add(selGroup);
}

// The furthest you may tilt is wherever the camera would meet the ground:
//   camera.y = target.y + distance * cos(phi)  >=  EYE_MIN
// Solving for phi gives an exact ceiling, so the view stops smoothly at street
// level instead of being cut off high above it.
const EYE_MIN = 1.6;
function clampTiltToGround() {
  if (!controls || !camera) return;
  const dist = camera.position.distanceTo(controls.target);
  if (dist < 0.01) return;
  const cosLimit = (EYE_MIN - controls.target.y) / dist;
  const phiMax = Math.acos(Math.max(-1, Math.min(1, cosLimit)));
  controls.maxPolarAngle = Math.min(Math.PI * 0.995, phiMax);
}

function resize(canvas) {
  // size to the CANVAS, not its parent: an aspect-ratio frame letterboxes the
  // canvas inside a full-bleed viewport, and the renderer must follow the frame
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w < 4 || h < 4) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function shapeFrom(poly) {
  const sh = new THREE.Shape();
  poly.forEach(([x, y], i) => i ? sh.lineTo(x, y) : sh.moveTo(x, y));
  sh.closePath();
  return sh;
}

function extrudeFloor(poly, scale, h) {
  const sh = shapeFrom(poly.map(([x, y]) => [x * scale, y * scale]));
  const g = new THREE.ExtrudeGeometry(sh, { depth: h, bevelEnabled: false, curveSegments: 4 });
  g.rotateX(Math.PI / 2);
  g.translate(0, h, 0);
  return g;
}

// ---- smooth lofted skin for freeform hulls ----

function sectionRing(t, P) {
  // superellipse section (organic), or the drawn plan footprint scaled per slice
  const aspect = state.baseDepth / state.baseWidth;
  const fp = profileAt(t);
  const sd = sideAt(t);
  const wHalf = Math.max(2, fp.w * state.baseWidth / 2);
  const dHalf = Math.max(2, (sd ? sd.w * state.baseDepth : fp.w * state.baseWidth * aspect) / 2);
  const cx = fp.cx, cz = sd ? sd.cx : 0;
  const rot = THREE.MathUtils.degToRad(state.twist * t + state.orientation);
  const pts = [];
  if (state.footprint?.length >= 3) {
    // normalize footprint to unit box, rescale anisotropically per slice
    let mx = 0, mz = 0;
    for (const [x, z] of state.footprint) { mx = Math.max(mx, Math.abs(x)); mz = Math.max(mz, Math.abs(z)); }
    const src = state.footprint;
    for (let i = 0; i < P; i++) {
      const j = (i / P) * src.length;
      const a = Math.floor(j) % src.length, b = (a + 1) % src.length, k = j - Math.floor(j);
      const x = (src[a][0] * (1 - k) + src[b][0] * k) / mx * wHalf;
      const z = (src[a][1] * (1 - k) + src[b][1] * k) / mz * dHalf;
      pts.push([x, z]);
    }
  } else {
    const n = 2.5; // superellipse exponent — soft rectangle
    for (let i = 0; i < P; i++) {
      const a = (i / P) * Math.PI * 2;
      const c = Math.cos(a), s = Math.sin(a);
      const x = Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * wHalf;
      const z = Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * dHalf;
      pts.push([x, z]);
    }
  }
  const cr = Math.cos(rot), sr = Math.sin(rot);
  return pts.map(([x, z]) => [x * cr - z * sr + cx, x * sr + z * cr + cz]);
}

function buildLoft() {
  const RJ = 54, P = 48;
  const H = state.floors * state.floorHeight;
  const pos = [];
  const idx = [];
  for (let j = 0; j <= RJ; j++) {
    const ring = sectionRing(j / RJ, P);
    for (const [x, z] of ring) pos.push(x, (j / RJ) * H, z);
  }
  for (let j = 0; j < RJ; j++) {
    for (let i = 0; i < P; i++) {
      const a = j * P + i, b = j * P + (i + 1) % P, c = (j + 1) * P + i, d = (j + 1) * P + (i + 1) % P;
      idx.push(a, c, b, b, c, d);
    }
  }
  // caps
  const baseC = pos.length / 3; pos.push(0, 0, 0);
  const topRing = sectionRing(1, P);
  let tx = 0, tz = 0;
  for (const [x, z] of topRing) { tx += x; tz += z; }
  const topC = pos.length / 3; pos.push(tx / P, H, tz / P);
  for (let i = 0; i < P; i++) {
    idx.push(baseC, (i + 1) % P, i);
    idx.push(topC, RJ * P + i, RJ * P + (i + 1) % P);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const skin = new THREE.Mesh(g, MAT.clay);
  skin.castShadow = skin.receiveShadow = true;
  towerGroup.add(skin);
  if (state.greenRoof || state.type === 'museum') { /* roof reads in the skin */ }
  // faint floor lines etched as rings every few floors — keeps "building", not "blob"
  const every = Math.max(1, Math.round(state.floors / 14));
  const lineMat = new THREE.LineBasicMaterial({ color: 0xcfc8b4, transparent: true, opacity: 0.5 });
  for (let f = every; f < state.floors; f += every) {
    const t = f / (state.floors - 1);
    const ring = sectionRing(Math.min(t, 1), P);
    const lp = [];
    for (const [x, z] of ring) lp.push(new THREE.Vector3(x * 1.002, f * state.floorHeight, z * 1.002));
    lp.push(lp[0].clone());
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(lp), lineMat);
    towerGroup.add(line);
  }
}

// ---- AI-read composition: a scene of massing volumes ----

// Level of detail — the single biggest lever on whether a box reads as a
// BUILDING. 'massing' = study blocks; 'floors' = spandrel + glazing band +
// slab lip per storey; 'detail' = adds mullions/fins and a ground-floor lobby.
export const DETAILS = ['massing', 'floors', 'detail'];
let detailLevel = 'floors';
export function setDetail(d) { if (DETAILS.includes(d)) detailLevel = d; }
export function getDetail() { return detailLevel; }

function buildMasses() {
  massGroups = [];
  const fh = state.floorHeight;
  const finBatch = [];

  state.masses.forEach((ms, mi) => {
    const grp = new THREE.Group();
    grp.userData.massIndex = mi;
    const isGlass = ms.facade === 'glass';
    const bodyMat = isGlass ? MAT.glass : MAT.clay;
    const floors = ms.storeys || Math.max(1, Math.round(ms.h / fh));
    const articulate = ms.kind !== 'member' && detailLevel !== 'massing' && ms.h >= fh * 1.4;

    if (!articulate) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(ms.w, ms.h, ms.d), bodyMat);
      box.castShadow = box.receiveShadow = true;
      grp.add(box);
    } else {
      // stack real storeys: spandrel band, glazing band, slab lip
      const realFh = ms.h / floors;
      const panelH = realFh * 0.26, glassH = realFh * 0.56, slabH = realFh - panelH - glassH;
      const spandrelG = new THREE.BoxGeometry(ms.w, panelH, ms.d);
      const glassG = new THREE.BoxGeometry(ms.w - 0.22, glassH, ms.d - 0.22);
      const slabG = new THREE.BoxGeometry(ms.w + 0.34, slabH, ms.d + 0.34);
      const spandrelI = new THREE.InstancedMesh(spandrelG, isGlass ? MAT.band : MAT.clay, floors);
      const glassI = new THREE.InstancedMesh(glassG, MAT.glass, floors);
      const slabI = new THREE.InstancedMesh(slabG, MAT.band, floors);
      const M = new THREE.Matrix4();
      for (let f = 0; f < floors; f++) {
        const y0 = -ms.h / 2 + f * realFh;
        M.setPosition(0, y0 + panelH / 2, 0); spandrelI.setMatrixAt(f, M);
        M.setPosition(0, y0 + panelH + glassH / 2, 0); glassI.setMatrixAt(f, M);
        M.setPosition(0, y0 + panelH + glassH + slabH / 2, 0); slabI.setMatrixAt(f, M);
      }
      for (const i of [spandrelI, glassI, slabI]) { i.castShadow = i.receiveShadow = true; grp.add(i); }

      // ground floor reads as a recessed lobby, like a real building
      if (detailLevel === 'detail' && ms.y < 0.5 && floors > 2) {
        const lobby = new THREE.Mesh(new THREE.BoxGeometry(ms.w - 1.4, realFh * 0.86, ms.d - 1.4), MAT.glass);
        lobby.position.y = -ms.h / 2 + realFh * 0.43;
        lobby.castShadow = lobby.receiveShadow = true;
        grp.add(lobby);
      }
    }

    // facade fins / slats — batched per mass, one draw call
    const wantFins = ms.facade === 'slats-v' || ms.facade === 'slats-h'
      || (detailLevel === 'detail' && isGlass);
    if (wantFins) {
      const horizontal = ms.facade === 'slats-h';
      const rot = THREE.MathUtils.degToRad(ms.rotY || 0);
      const spacing = detailLevel === 'detail' ? 1.15 : 1.7;
      if (horizontal) {
        const n = Math.max(2, Math.min(90, Math.floor(ms.h / Math.max(spacing, 0.9))));
        for (let i = 0; i < n; i++) {
          const y = ms.y + (i + 0.5) * (ms.h / n);
          for (const s of [1, -1]) finBatch.push({ w: ms.w * 0.99, h: 0.16, d: 0.34, x: ms.x, y, z: ms.z, off: s * (ms.d / 2 + 0.15), rot, axis: 'z' });
        }
      } else {
        const n = Math.max(3, Math.min(90, Math.floor(ms.w / Math.max(spacing, 0.8))));
        for (let i = 0; i < n; i++) {
          const ox = -ms.w / 2 + (i + 0.5) * (ms.w / n);
          for (const s of [1, -1]) finBatch.push({ w: 0.16, h: ms.h * 0.99, d: 0.34, x: ms.x, y: ms.y + ms.h / 2, z: ms.z, ox, off: s * (ms.d / 2 + 0.15), rot, axis: 'z' });
        }
      }
    }

    grp.position.set(ms.x, ms.y + ms.h / 2, ms.z);
    grp.rotation.y = THREE.MathUtils.degToRad(ms.rotY || 0);
    massGroups.push(grp);
    towerGroup.add(grp);
  });

  if (finBatch.length) {
    const g = new THREE.BoxGeometry(1, 1, 1);
    const inst = new THREE.InstancedMesh(g, MAT.fin, finBatch.length);
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), sc = new THREE.Vector3();
    finBatch.forEach((f, i) => {
      const lx = (f.ox || 0), lz = f.off;
      const wx = f.x + lx * Math.cos(f.rot) - lz * Math.sin(f.rot);
      const wz = f.z + lx * Math.sin(f.rot) + lz * Math.cos(f.rot);
      e.set(0, f.rot, 0); q.setFromEuler(e);
      v.set(wx, f.y, wz); sc.set(f.w, f.h, f.d);
      M.compose(v, q, sc);
      inst.setMatrixAt(i, M);
    });
    inst.castShadow = true;
    towerGroup.add(inst);
  }
}

function rebuildWireMasses() {
  if (!wScene) return;
  if (wGroup) { wScene.remove(wGroup); wGroup.traverse(o => o.geometry?.dispose()); }
  wGroup = new THREE.Group();
  if (!state.masses?.length) {
    // parametric archetypes have no mass list — outline the tower envelope
    if (state.archetype === 'tower') {
      const st = towerStats();
      const g = new THREE.BoxGeometry(st.bbW, st.height, st.bbD);
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), inkLine);
      e.position.y = st.height / 2;
      wGroup.add(e);
      g.dispose();
    }
    wScene.add(wGroup);
    return;
  }
  for (const ms of state.masses) {
    const g = new THREE.BoxGeometry(ms.w, ms.h, ms.d);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(g), inkLine);
    e.position.set(ms.x, ms.y + ms.h / 2, ms.z);
    e.rotation.y = THREE.MathUtils.degToRad(ms.rotY || 0);
    wGroup.add(e);
    g.dispose();
  }
  wScene.add(wGroup);
}

export function rebuild() {
  rebuildSolid();
  syncSketchWorld();
}

function rebuildSolid() {
  clearImported();   // parametric edits always return you to the editable twin
  if (towerGroup) {
    scene.remove(towerGroup);
    towerGroup.traverse(o => o.geometry?.dispose());
  }
  towerGroup = new THREE.Group();
  const poly = basePolygon();
  const fh = state.floorHeight;

  if (state.archetype === 'tower') {
    const g = buildParamTower(state, { mode: 'solid', detail: detailLevel === 'massing' ? 'low' : 'high' });
    towerGroup.add(g);
    scene.add(towerGroup);
    const st = towerStats();
    controls.target.lerp(new THREE.Vector3(0, st.height * 0.42, 0), 1);
    rebuildWireMasses();
    return;
  }

  if (state.masses?.length) {
    buildMasses();
    scene.add(towerGroup);
    applyExplode();
    const st = towerStats();
    controls.target.lerp(new THREE.Vector3(0, st.height * 0.38, 0), 1);
    rebuildWireMasses();
    return;
  }

  if (state.profile) {
    buildLoft();
    scene.add(towerGroup);
    const h = state.floors * fh;
    controls.target.lerp(new THREE.Vector3(0, h * 0.42, 0), 1);
    rebuildWireLoft();
    return;
  }

  for (let f = 0; f < state.floors; f++) {
    const { scale, rot, cx } = floorProfile(f);
    const bodyH = fh * (state.profile ? 0.92 : 0.84);
    const body = new THREE.Mesh(extrudeFloor(poly, scale, bodyH), MAT.clay);
    body.position.set(cx, f * fh, 0);
    body.rotation.y = rot;
    body.castShadow = body.receiveShadow = true;
    towerGroup.add(body);
    const band = new THREE.Mesh(extrudeFloor(poly, scale * 1.012, fh - bodyH), MAT.band);
    band.position.set(cx, f * fh + bodyH, 0);
    band.rotation.y = rot;
    band.castShadow = true;
    towerGroup.add(band);
  }
  if (state.greenRoof) {
    const { scale, rot, cx } = floorProfile(state.floors - 1);
    const roof = new THREE.Mesh(extrudeFloor(poly, scale * 0.94, 0.5), MAT.roofGreen);
    roof.position.set(cx, state.floors * fh, 0);
    roof.rotation.y = rot;
    towerGroup.add(roof);
  }
  scene.add(towerGroup);

  const h = state.floors * fh;
  controls.target.lerp(new THREE.Vector3(0, h * 0.42, 0), 1);
  rebuildWire(poly);
}

// The render's input image. Never trust the on-screen canvas size: a narrow
// pane or a hidden tab would hand the image model a thumbnail it cannot read
// the massing from. Render offscreen at a fixed, generous resolution instead.
export function modelSnapshot(longEdge = 1280, { isolate = false } = {}) {
  if (!renderer || !camera) return null;
  const el = renderer.domElement;
  const w0 = el.width, h0 = el.height;
  // a hidden or oddly shaped pane must not produce a sliver of an image
  let aspect = (el.clientWidth || 0) / (el.clientHeight || 1);
  if (!Number.isFinite(aspect) || aspect < 0.45 || aspect > 3) aspect = 4 / 3;
  const w = Math.round(aspect >= 1 ? longEdge : longEdge * aspect);
  const h = Math.round(aspect >= 1 ? longEdge / aspect : longEdge);
  const dpr0 = renderer.getPixelRatio();
  const hidden = isolate ? [contextGroup, sunDisc, sunPathLine, particles, skyMesh, sketchGroup].filter(Boolean) : [];
  const visibility = hidden.map(o => o.visible);
  const bg0 = scene.background, fog0 = scene.fog;
  let analysisGround = null;
  try {
    if (isolate) {
      hidden.forEach(o => { o.visible = false; });
      scene.background = new THREE.Color(0xf7f5ef);
      scene.fog = null;
      const span = Math.max(24, designedFootprint() * 3.2);
      analysisGround = new THREE.Mesh(
        new THREE.PlaneGeometry(span, span),
        new THREE.MeshStandardMaterial({ color: 0xe6e1d5, roughness: 1, metalness: 0 }),
      );
      analysisGround.rotation.x = -Math.PI / 2;
      analysisGround.position.y = -0.025;
      analysisGround.receiveShadow = true;
      scene.add(analysisGround);
    }
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    return el.toDataURL('image/png');
  } finally {
    if (analysisGround) {
      scene.remove(analysisGround);
      analysisGround.geometry.dispose(); analysisGround.material.dispose();
    }
    hidden.forEach((o, i) => { o.visible = visibility[i]; });
    scene.background = bg0; scene.fog = fog0;
    renderer.setPixelRatio(dpr0);
    renderer.setSize(w0 / dpr0, h0 / dpr0, false);
    camera.aspect = (el.clientWidth || 4) / (el.clientHeight || 3);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  }
}

// ---------------- reverse: imported 3D mesh ----------------

let importedGroup = null;
export function hasImported() { return !!importedGroup; }

export function clearImported() {
  if (!importedGroup) return;
  scene.remove(importedGroup);
  importedGroup.traverse(o => o.geometry?.dispose());
  importedGroup = null;
  if (towerGroup) towerGroup.visible = true;
}

export async function importMesh(file) {
  const name = file.name.toLowerCase();
  let root;
  if (name.endsWith('.obj')) {
    root = new OBJLoader().parse(await file.text());
  } else {
    const buf = await file.arrayBuffer();
    root = await new Promise((res, rej) =>
      new GLTFLoader().parse(buf, '', g => res(g.scene), rej));
  }
  // normalize: clay material, feet on the ground, sane height
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  let scale = 1;
  if (size.y < 8 || size.y > 500) scale = 80 / Math.max(size.y, 0.001);
  root.traverse(o => {
    if (o.isMesh) { o.material = MAT.clay; o.castShadow = o.receiveShadow = true; }
  });
  const wrap = new THREE.Group();
  wrap.add(root);
  root.position.set(-centre.x, -box.min.y, -centre.z);
  wrap.scale.setScalar(scale);
  clearImported();
  importedGroup = wrap;
  if (towerGroup) towerGroup.visible = false;
  scene.add(wrap);
  const h = size.y * scale;
  controls.target.set(0, h * 0.42, 0);
  return { height: h, width: size.x * scale, depth: size.z * scale };
}

// ---------------- Rhino handoff: write a real .3dm in the browser ----------------

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function eachWorldMesh(cb) {
  const group = importedGroup || towerGroup;
  if (!group) return 0;
  group.updateMatrixWorld(true);
  let n = 0;
  group.traverse(o => {
    if (!o.isMesh) return;
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
    cb(g.attributes.position, o.matrixWorld, n++);
    if (g !== o.geometry) g.dispose();
  });
  return n;
}

function exportOBJ(paramsJson) {
  let out = '# NAPKIN building export\n# params: ' + paramsJson.replace(/\n/g, ' ') + '\n';
  let offset = 1;
  const v = new THREE.Vector3();
  eachWorldMesh((pos, mw, idx) => {
    out += `o part_${idx}\n`;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mw);
      out += `v ${v.x.toFixed(4)} ${v.y.toFixed(4)} ${v.z.toFixed(4)}\n`;
    }
    for (let i = 0; i < pos.count; i += 3) out += `f ${offset + i} ${offset + i + 1} ${offset + i + 2}\n`;
    offset += pos.count;
  });
  download(new Blob([out], { type: 'text/plain' }), 'napkin-building.obj');
  return 'obj';
}

let rhinoRT = null;
export async function rhinoBytes(paramsJson, brief) {
  if (!rhinoRT) {
    const mod = await import('./vendor/rhino3dm.module.min.js');
    rhinoRT = await mod.default({ locateFile: f => new URL('./vendor/' + f, import.meta.url).href });
  }
  const rhino = rhinoRT;
  const doc = new rhino.File3dm();
  try { doc.settings().modelUnitSystem = rhino.UnitSystem.Meters; } catch { }
  try {
    const layer = new rhino.Layer();
    layer.name = 'NAPKIN building';
    layer.color = { r: 189, g: 95, b: 61, a: 255 };
    doc.layers().add(layer);
  } catch { }

  // Real solids, not a triangle soup. Each volume becomes a capped extrusion
  // of its rectangular footprint — a NURBS solid Rhino can fillet, boolean,
  // offset and edit, and Grasshopper can drive. Three is Y-up, Rhino is Z-up:
  // (x, y, z) -> (x, -z, y).
  let solids = 0;
  if (state.masses?.length) {
    for (const m of state.masses) {
      try {
        const hw = m.w / 2, hd = m.d / 2;
        const a = THREE.MathUtils.degToRad(m.rotY || 0);
        const ca = Math.cos(a), sa = Math.sin(a);
        const corner = (px, pz) => {
          const x = m.x + px * ca + pz * sa;
          const z = m.z - px * sa + pz * ca;
          return [x, -z];                       // Rhino XY
        };
        const ring = [corner(-hw, -hd), corner(hw, -hd), corner(hw, hd), corner(-hw, hd)];
        const pl = new rhino.Polyline();
        for (const [x, y] of ring) pl.add(x, y, m.y);
        pl.add(ring[0][0], ring[0][1], m.y);    // close it
        const ex = rhino.Extrusion.create(pl.toNurbsCurve(), Math.max(0.01, m.h), true);
        if (!ex) continue;
        let geo = ex;
        try { const b = ex.toBrep(true); if (b) geo = b; } catch { /* extrusion is a solid too */ }
        const attrs = new rhino.ObjectAttributes();
        attrs.layerIndex = 0;
        attrs.name = m.id || `volume ${solids + 1}`;
        // provenance rides on the object, so a designer in Rhino can see where
        // each solid came from and what it was called upstream
        try {
          attrs.setUserString('napkin.role', String(m.role || ''));
          attrs.setUserString('napkin.kind', String(m.kind || 'volume'));
          attrs.setUserString('napkin.on', String(m.on || 'ground'));
          attrs.setUserString('napkin.size', `${m.w} x ${m.d} x ${m.h} m`);
          attrs.setUserString('napkin.at', `${m.x}, ${m.y}, ${m.z}`);
        } catch { }
        doc.objects().add(geo, attrs);
        solids++;
      } catch (e) { console.warn('solid failed for', m.id, e); }
    }
  }

  // Nothing parametric to extrude (the tower archetype, an imported mesh):
  // fall back to meshes so the export is never empty.
  if (!solids) {
    const v = new THREE.Vector3();
    let parts = 0;
    eachWorldMesh((pos, mw) => {
      const mesh = new rhino.Mesh();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mw);
        mesh.vertices().add(v.x, -v.z, v.y);
      }
      for (let i = 0; i < pos.count; i += 3) mesh.faces().addTriFace(i, i + 1, i + 2);
      const attrs = new rhino.ObjectAttributes();
      attrs.layerIndex = 0;
      attrs.name = `napkin part ${parts++}`;
      doc.objects().add(mesh, attrs);
    });
  }

  try {
    doc.strings().set('napkin.params', paramsJson);
    doc.strings().set('napkin.brief', brief || '');
    doc.strings().set('napkin.note', solids
      ? `${solids} NURBS solids, one per volume. Parameters in napkin.params; napkin-grasshopper.py rebuilds them parametrically in a GhPython component.`
      : 'Meshes (this model has no parametric volumes). Parameters in napkin.params.');
  } catch { }
  return doc.toByteArray();
}

// ---------------- Grasshopper ----------------
// The definition, as a GhPython component's script. Paste it into a GhPython
// component (or run it in Rhino's Python editor) and the whole composition
// rebuilds as NURBS solids from the parameter block at the top — every number
// a slider can drive.
export function exportGrasshopper() {
  if (!state.masses?.length) return false;
  const rows = state.masses.map(m => '    ' + JSON.stringify({
    id: m.id, role: m.role || 'volume', kind: m.kind || 'volume',
    w: m.w, d: m.d, h: m.h, x: m.x, y: m.y, z: m.z, rotY: m.rotY || 0,
    on: m.on || 'ground', facade: m.facade || 'solid',
  })).join(',\n');
  const py = `# NAPKIN -> Grasshopper
# Paste into a GhPython component, or run in Rhino's Python editor.
#
# GhPython wiring (optional, for sliders):
#   input  SCALE   number slider 0.3 .. 3.0   default 1.0
#   input  HEIGHT  number slider 0.5 .. 2.0   default 1.0   (vertical only)
#   output a       the NURBS solids
#
# Every solid is a capped extrusion of its footprint: a real Brep, so Rhino
# and Grasshopper can fillet, boolean, offset and drive it.

import math
import Rhino.Geometry as rg

# ---- the composition, straight from the model ----------------------------
# metres; y is up here (as drawn), converted to Rhino Z below
VOLUMES = [
${rows},
]

try:
    S = float(SCALE)
except Exception:
    S = 1.0
try:
    HS = float(HEIGHT)
except Exception:
    HS = 1.0


def solid(v, s=1.0, hs=1.0):
    """One volume -> one capped NURBS extrusion."""
    w, d, h = v["w"] * s, v["d"] * s, v["h"] * s * hs
    cx, cy, cz = v["x"] * s, v["y"] * s * hs, v["z"] * s
    a = math.radians(v.get("rotY", 0.0))
    ca, sa = math.cos(a), math.sin(a)
    pts = []
    for px, pz in ((-w / 2, -d / 2), (w / 2, -d / 2), (w / 2, d / 2), (-w / 2, d / 2)):
        X = cx + px * ca + pz * sa
        Z = cz - px * sa + pz * ca
        pts.append(rg.Point3d(X, -Z, cy))          # three Y-up -> Rhino Z-up
    pts.append(pts[0])
    crv = rg.PolylineCurve(pts)
    ext = rg.Extrusion.Create(crv, h, True)
    if ext is None:
        return None
    brep = ext.ToBrep()
    if brep:
        brep.SetUserString("napkin.id", str(v["id"]))
        brep.SetUserString("napkin.role", str(v.get("role", "")))
    return brep


a = [b for b in (solid(v, S, HS) for v in VOLUMES) if b]

# Running inside Rhino rather than Grasshopper? Bake them.
if __name__ == "__main__" and "ghenv" not in dir():
    try:
        import scriptcontext as sc
        for b in a:
            sc.doc.Objects.AddBrep(b)
        sc.doc.Views.Redraw()
    except Exception:
        pass
`;
  download(new Blob([py], { type: 'text/x-python' }), 'napkin-grasshopper.py');
  return true;
}

// The control cage: every volume as a low-poly QUAD box, welded verts, one
// object per element. In Rhino: import, select, ToSubD — and the massing can
// be pushed around like clay while staying true to the audited composition.
export function exportCageObj() {
  if (!state.masses?.length) return false;
  const L = ['# NAPKIN quad control cage — ToSubD in Rhino to sculpt', '# y-up metres'];
  let base = 1;
  for (const m of state.masses) {
    const hw = m.w / 2, hd = m.d / 2;
    const a = THREE.MathUtils.degToRad(m.rotY || 0);
    const ca = Math.cos(a), sa = Math.sin(a);
    L.push('o ' + m.id);
    for (const [px, py, pz] of [
      [-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd], [-hw, 0, hd],
      [-hw, m.h, -hd], [hw, m.h, -hd], [hw, m.h, hd], [-hw, m.h, hd],
    ]) {
      const x = m.x + px * ca + pz * sa;
      const z = m.z - px * sa + pz * ca;
      L.push(`v ${x.toFixed(3)} ${(m.y + py).toFixed(3)} ${z.toFixed(3)}`);
    }
    for (const q of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) {
      L.push('f ' + q.map(i => base + i).join(' '));
    }
    base += 8;
  }
  download(new Blob([L.join('\n')], { type: 'text/plain' }), 'napkin-cage.obj');
  return true;
}

export async function exportRhino(paramsJson, brief) {
  try {
    const bytes = await rhinoBytes(paramsJson, brief);
    download(new Blob([bytes], { type: 'application/octet-stream' }), 'napkin-building.3dm');
    return '3dm';
  } catch (e) {
    console.warn('rhino3dm export failed, falling back to OBJ', e);
    return exportOBJ(paramsJson);
  }
}

// Orthographic front-view silhouette of the imported mesh — feeds the SAME
// interpretation pipeline the napkin uses. Reverse and forward share one brain.
export function meshSilhouette(size = 220) {
  if (!importedGroup) return null;
  const off = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  off.setSize(size, size);
  const s2 = new THREE.Scene();
  s2.background = new THREE.Color(0xffffff);
  const clone = importedGroup.clone(true);
  const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
  clone.traverse(o => { if (o.isMesh) o.material = black; });
  s2.add(clone);
  const box = new THREE.Box3().setFromObject(clone);
  const sz = box.getSize(new THREE.Vector3());
  const c = box.getCenter(new THREE.Vector3());
  const pad = 1.12;
  const half = Math.max(sz.x, sz.y) * pad / 2;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, sz.z * 4 + 100);
  cam.position.set(c.x, c.y, c.z + sz.z * 2 + 10);
  cam.lookAt(c.x, c.y, c.z);
  off.render(s2, cam);
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  cv.getContext('2d').drawImage(off.domElement, 0, 0);
  off.dispose();
  return cv;
}

// ---------------- line-study pane ----------------

let wRenderer, wScene, wCamera, wGroup;
const inkLine = new THREE.LineBasicMaterial({ color: 0x2d3e57 });

export function initWire(canvas) {
  wRenderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  wRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  wScene = new THREE.Scene();
  wScene.background = new THREE.Color(0xffffff);
  wCamera = new THREE.PerspectiveCamera(34, 1.6, 0.5, 1200);
  const ro = new ResizeObserver(() => {
    const el = canvas.parentElement;
    if (el.clientWidth < 4 || el.clientHeight < 4) return;
    wRenderer.setSize(el.clientWidth, el.clientHeight, false);
    wCamera.aspect = el.clientWidth / el.clientHeight;
    wCamera.updateProjectionMatrix();
  });
  ro.observe(canvas.parentElement);
  let t = 0;
  wRenderer.setAnimationLoop(() => {
    if (!wGroup) return;
    t += 0.003;
    const h = state.floors * state.floorHeight;
    const r = Math.max(state.baseWidth, state.baseDepth) * 2.1 + h * 0.55;
    wCamera.position.set(Math.cos(t) * r, h * 0.72, Math.sin(t) * r);
    wCamera.lookAt(0, h * 0.4, 0);
    wRenderer.render(wScene, wCamera);
  });
}

function rebuildWireLoft() {
  if (!wScene) return;
  if (wGroup) { wScene.remove(wGroup); wGroup.traverse(o => o.geometry?.dispose()); }
  wGroup = new THREE.Group();
  const P = 48, RJ = 30;
  const H = state.floors * state.floorHeight;
  // contour rings
  for (let j = 0; j <= RJ; j += 2) {
    const ring = sectionRing(j / RJ, P);
    const lp = ring.map(([x, z]) => new THREE.Vector3(x, (j / RJ) * H, z));
    lp.push(lp[0].clone());
    wGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(lp), inkLine));
  }
  // vertical profile curves at the four cardinal points
  for (const i of [0, Math.floor(P / 4), Math.floor(P / 2), Math.floor(3 * P / 4)]) {
    const lp = [];
    for (let j = 0; j <= RJ; j++) {
      const ring = sectionRing(j / RJ, P);
      lp.push(new THREE.Vector3(ring[i][0], (j / RJ) * H, ring[i][1]));
    }
    wGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(lp), inkLine));
  }
  wScene.add(wGroup);
}

function rebuildWire(poly) {
  if (!wScene) return;
  if (wGroup) { wScene.remove(wGroup); wGroup.traverse(o => o.geometry?.dispose()); }
  wGroup = new THREE.Group();
  const fh = state.floorHeight;
  const step = Math.max(1, Math.round(state.floors / 26));
  for (let f = 0; f < state.floors; f += step) {
    const { scale, rot, cx } = floorProfile(f);
    const g = extrudeFloor(poly, scale, fh * step * 0.98);
    const edges = new THREE.EdgesGeometry(g, 22);
    const line = new THREE.LineSegments(edges, inkLine);
    line.position.set(cx, f * fh, 0);
    line.rotation.y = rot;
    wGroup.add(line);
    g.dispose();
  }
  wScene.add(wGroup);
}
