// Parametric torso tower, ported from CONCORD: pure profile math (shared with metrics) + Three.js build.
// The form language is a stacked-segment twisting tower — a rounded plan with a
// pointed prow, white panel + glass envelope, vertical fins, recessed joint
// floors between segments, and an exposed spine truss following the twist.
import * as THREE from 'three';

// ---- Pure math -------------------------------------------------------------

export function prowFor(w, d) { return Math.min(w, d) * 0.32; }

export function floorSpec(state, i) {
  const n = Math.max(state.floors, 2);
  const t = i / (n - 1);
  const s = 1 + (state.taper - 1) * t;
  let w = state.baseWidth * s;
  let d = state.baseDepth * s;
  if (i < state.podiumFloors) { w = state.baseWidth + state.podiumExpand * 2; d = state.baseDepth + state.podiumExpand * 2; }
  for (const sb of state.setbacks) if (i >= sb.floor) { w -= sb.inset * 2; d -= sb.inset * 2; }
  w = Math.max(10, w); d = Math.max(10, d);
  const r = Math.min(state.cornerRadius, Math.min(w, d) / 2 - 1, 8);
  const rotDeg = (i >= state.podiumFloors ? state.twist * t : 0) + state.orientation;

  // segment bookkeeping: shaft floors group into `segments` modules with a
  // recessed joint floor at each boundary (never the first or last floor)
  const shaftFloors = n - state.podiumFloors;
  const segs = Math.max(1, Math.min(state.segCount || 1, Math.floor(shaftFloors / 2)));
  const perSeg = shaftFloors / segs;
  const si = i - state.podiumFloors;
  let isJoint = false, seg = 0;
  if (si >= 0) {
    seg = Math.min(segs - 1, Math.floor(si / perSeg));
    for (let k = 1; k < segs; k++) {
      if (si === Math.round(k * perSeg) && i < n - 1) { isJoint = true; break; }
    }
  }

  const isGarden = state.skyGardens.includes(i);
  const isOpen = i < state.liftGround;
  return {
    w, d, r: Math.max(0, r), prow: prowFor(w, d),
    rot: rotDeg * Math.PI / 180, z: i * state.floorHeight,
    isGarden, isOpen, isJoint, seg,
  };
}

export function profileArea(w, d, r, prow = 0) {
  return w * d - (4 - Math.PI) * r * r + 0.55 * prow * d;
}
export function profilePerimeter(w, d, r, prow = 0) {
  const base = 2 * (w + d) - 8 * r + 2 * Math.PI * r;
  return prow > 0 ? base - d + 2 * Math.hypot(prow, d / 2) * 1.04 : base;
}

export function towerParamStats(state) {
  let gfa = 0, facadeArea = 0, maxHalfDiag = 0, minPlan = Infinity;
  const floors = [];
  for (let i = 0; i < state.floors; i++) {
    const f = floorSpec(state, i);
    floors.push(f);
    if (!f.isOpen) gfa += profileArea(f.w, f.d, f.r, f.prow);
    facadeArea += profilePerimeter(f.w, f.d, f.r, f.prow) * state.floorHeight;
    maxHalfDiag = Math.max(maxHalfDiag, Math.hypot(f.w / 2 + f.prow, f.d / 2));
    if (i >= state.podiumFloors) minPlan = Math.min(minPlan, Math.min(f.w, f.d));
  }
  const height = state.floors * state.floorHeight + (state.crown === 'crown' ? 7 : 0);
  return { gfa, facadeArea, height, maxHalfDiag, minPlan, floors };
}

// ---- Materials -------------------------------------------------------------

const MATS = {
  glass: new THREE.MeshPhysicalMaterial({ color: 0x63c1cc, roughness: 0.16, metalness: 0.35, envMapIntensity: 0.9 }),
  terracotta: new THREE.MeshStandardMaterial({ color: 0xb96a45, roughness: 0.75, metalness: 0.04 }),
  timber: new THREE.MeshStandardMaterial({ color: 0xb08a55, roughness: 0.68, metalness: 0.02 }),
  panel: new THREE.MeshStandardMaterial({ color: 0xf2f3ef, roughness: 0.5, metalness: 0.06 }),
  slab: new THREE.MeshStandardMaterial({ color: 0xe4e6e2, roughness: 0.62, metalness: 0.05 }),
  joint: new THREE.MeshStandardMaterial({ color: 0x78808a, roughness: 0.6, metalness: 0.3 }),
  fin: new THREE.MeshStandardMaterial({ color: 0xeceee9, roughness: 0.45, metalness: 0.15 }),
  finWarm: new THREE.MeshStandardMaterial({ color: 0xc98a5e, roughness: 0.6, metalness: 0.05 }),
  spine: new THREE.MeshStandardMaterial({ color: 0x23272d, roughness: 0.42, metalness: 0.68 }),
  garden: new THREE.MeshStandardMaterial({ color: 0x4d8f56, roughness: 0.85 }),
  gardenGlass: new THREE.MeshPhysicalMaterial({ color: 0x8fc9a0, roughness: 0.2, metalness: 0.25, transparent: true, opacity: 0.82 }),
  column: new THREE.MeshStandardMaterial({ color: 0xb9bcc2, roughness: 0.55 }),
  crown: new THREE.MeshStandardMaterial({ color: 0xf5f4ee, roughness: 0.42 }),
  ghost: new THREE.MeshBasicMaterial({ color: 0x6a7590, wireframe: true, transparent: true, opacity: 0.3 }),
  preview: new THREE.MeshStandardMaterial({ color: 0x1fae8e, roughness: 0.4, transparent: true, opacity: 0.42, emissive: 0x1fae8e, emissiveIntensity: 0.12 }),
};

// Rounded plan with a pointed prow on +X — the torso plate.
function torsoShape(w, d, r, prow = 0) {
  const shape = new THREE.Shape();
  const hw = w / 2, hd = d / 2, rr = Math.max(0.05, Math.min(r, Math.min(hw, hd) - 0.5));
  if (prow <= 0.05) {
    shape.moveTo(-hw + rr, -hd);
    shape.lineTo(hw - rr, -hd); shape.quadraticCurveTo(hw, -hd, hw, -hd + rr);
    shape.lineTo(hw, hd - rr); shape.quadraticCurveTo(hw, hd, hw - rr, hd);
  } else {
    shape.moveTo(-hw + rr, -hd);
    shape.lineTo(hw - rr * 1.4, -hd);
    // sweep out to the prow apex and back — a soft ship's-bow point
    shape.quadraticCurveTo(hw + prow * 0.28, -hd * 0.6, hw + prow, 0);
    shape.quadraticCurveTo(hw + prow * 0.28, hd * 0.6, hw - rr * 1.4, hd);
  }
  shape.lineTo(-hw + rr, hd); shape.quadraticCurveTo(-hw, hd, -hw, hd - rr);
  shape.lineTo(-hw, -hd + rr); shape.quadraticCurveTo(-hw, -hd, -hw + rr, -hd);
  shape.closePath();
  return shape;
}

function floorSolid(shape, h) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 10 });
  g.rotateX(Math.PI / 2);
  g.translate(0, h, 0);
  return g;
}

const rotXZ = (x, z, rot) => [x * Math.cos(rot) + z * Math.sin(rot), -x * Math.sin(rot) + z * Math.cos(rot)];

// Map a state feature key -> which floors it owns (for click provenance).
function featureForFloor(state, i, f) {
  if (state.skyGardens.includes(i)) return `garden@${state.skyGardens.find(g => g === i)}`;
  if (i < state.liftGround) return 'ground';
  if (i < state.podiumFloors) return 'podium';
  if (f?.isJoint) return 'segments';
  const sb = [...state.setbacks].reverse().find(x => i >= x.floor);
  if (sb) return `setback@${sb.floor}`;
  if (state.twist > 1) return 'twist';
  if (state.taper < 0.99) return 'taper';
  return 'facade';
}

// Oriented strut between two points.
function tube(p1, p2, r, mat, feature) {
  const dir = new THREE.Vector3().subVectors(p2, p1);
  const len = dir.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), mat);
  m.position.copy(p1).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  m.castShadow = true;
  m.userData.feature = feature;
  return m;
}

// ---- Build -----------------------------------------------------------------

export function buildParamTower(state, { mode = 'solid', detail = 'high' } = {}) {
  const group = new THREE.Group();
  const fh = state.floorHeight;
  const bodyMat = mode === 'ghost' ? MATS.ghost : mode === 'preview' ? MATS.preview
    : state.facade === 'glass' ? MATS.glass : MATS[state.facade];
  const finMat = state.facade === 'glass' ? MATS.fin : state.facade === 'terracotta' ? MATS.finWarm : MATS.fin;
  const rich = mode === 'solid' && detail === 'high';

  const finInstances = []; // {x, z, y, rotY, h}

  for (let i = 0; i < state.floors; i++) {
    const f = floorSpec(state, i);
    const feature = featureForFloor(state, i, f);

    if (mode !== 'solid') {
      // ghost / preview: one cheap extrude per floor
      const g = new THREE.Mesh(floorSolid(torsoShape(f.w, f.d, f.r, f.prow), fh * 0.92), bodyMat);
      g.position.y = f.z; g.rotation.y = f.rot;
      g.userData.feature = feature;
      group.add(g);
      continue;
    }

    if (f.isOpen) {
      // open plaza level: columns + thin slab above
      const slab = new THREE.Mesh(floorSolid(torsoShape(f.w + 0.4, f.d + 0.4, f.r, f.prow), 0.35), MATS.slab);
      slab.position.y = f.z + fh - 0.35;
      slab.rotation.y = f.rot;
      slab.castShadow = slab.receiveShadow = true;
      slab.userData.feature = 'ground';
      group.add(slab);
      const colG = new THREE.CylinderGeometry(0.45, 0.45, fh - 0.35, 10);
      [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1]].forEach(([sx, sz]) => {
        const c = new THREE.Mesh(colG, MATS.column);
        const [px, pz] = rotXZ(sx * (f.w / 2 - 2.2), sz * (f.d / 2 - 2.2), f.rot);
        c.position.set(px, f.z + (fh - 0.35) / 2, pz);
        c.castShadow = true;
        c.userData.feature = 'ground';
        group.add(c);
      });
      continue;
    }

    if (f.isJoint) {
      // recessed joint floor — the shadow gap between segments
      const j = new THREE.Mesh(floorSolid(torsoShape(f.w - 1.3, f.d - 1.3, f.r, f.prow * 0.85), fh * 0.9), MATS.joint);
      j.position.y = f.z; j.rotation.y = f.rot;
      j.castShadow = j.receiveShadow = true;
      j.userData.feature = 'segments';
      group.add(j);
      const lip = new THREE.Mesh(floorSolid(torsoShape(f.w + 0.42, f.d + 0.42, f.r, f.prow), fh * 0.1), MATS.slab);
      lip.position.y = f.z + fh * 0.9; lip.rotation.y = f.rot;
      lip.castShadow = lip.receiveShadow = true;
      lip.userData.feature = 'segments';
      group.add(lip);
      continue;
    }

    // ---- regular floor: spandrel panel + glass band + slab lip ----
    const panelH = f.isGarden ? fh * 0.1 : fh * 0.26;
    const glassH = f.isGarden ? fh * 0.75 : fh * 0.58;
    const slabH = fh - panelH - glassH;
    const shape = torsoShape(f.w, f.d, f.r, f.prow);

    const spandrel = new THREE.Mesh(floorSolid(shape, panelH), f.isGarden ? MATS.garden : MATS.panel);
    spandrel.position.y = f.z;
    spandrel.rotation.y = f.rot;
    spandrel.castShadow = spandrel.receiveShadow = true;
    spandrel.userData.feature = feature;
    group.add(spandrel);

    const glass = new THREE.Mesh(
      floorSolid(torsoShape(f.w - 0.24, f.d - 0.24, f.r, f.prow * 0.97), glassH),
      f.isGarden ? MATS.gardenGlass : bodyMat);
    glass.position.y = f.z + panelH;
    glass.rotation.y = f.rot;
    glass.castShadow = glass.receiveShadow = true;
    glass.userData.feature = feature;
    group.add(glass);

    const slab = new THREE.Mesh(floorSolid(torsoShape(f.w + 0.42, f.d + 0.42, f.r, f.prow), slabH), MATS.slab);
    slab.position.y = f.z + panelH + glassH;
    slab.rotation.y = f.rot;
    slab.castShadow = slab.receiveShadow = true;
    slab.userData.feature = feature;
    group.add(slab);

    if (f.isGarden) {
      const planter = new THREE.Mesh(floorSolid(torsoShape(f.w - 1.5, f.d - 1.5, f.r, f.prow * 0.8), 0.5), MATS.garden);
      planter.position.y = f.z + panelH;
      planter.rotation.y = f.rot;
      planter.userData.feature = `garden@${i}`;
      group.add(planter);
    }

    // fins along the glass band
    if (rich && !f.isGarden) {
      const outline = torsoShape(f.w - 0.05, f.d - 0.05, f.r, f.prow);
      const per = profilePerimeter(f.w, f.d, f.r, f.prow);
      const count = Math.max(8, Math.round(per / Math.max(1.2, state.finSpacing)));
      const pts = outline.getSpacedPoints(count);
      for (let k = 0; k < pts.length - 1; k++) {
        const p = pts[k], q = pts[(k + 1) % pts.length];
        const tx = q.x - p.x, tz = q.y - p.y;
        const nl = Math.hypot(tx, tz) || 1;
        const nx = tz / nl, nz = -tx / nl; // outward normal (CCW path)
        const [wx, wz] = rotXZ(p.x + nx * 0.08, p.y + nz * 0.08, f.rot);
        const [nwx, nwz] = rotXZ(nx, nz, f.rot);
        finInstances.push({ x: wx, z: wz, y: f.z + panelH + glassH / 2, rotY: Math.atan2(nwx, nwz), h: glassH });
      }
    }

    if (state.balconyDepth > 0.05 && i >= Math.max(state.podiumFloors, state.liftGround)) {
      const bal = new THREE.Mesh(new THREE.BoxGeometry(f.w * 0.55, 0.14, state.balconyDepth), MATS.slab);
      const off = f.d / 2 + state.balconyDepth / 2;
      const [bx, bz] = rotXZ(0, off, f.rot);
      bal.position.set(bx, f.z + panelH + 0.15, bz);
      bal.rotation.y = f.rot;
      bal.castShadow = true;
      bal.userData.feature = 'balconies';
      group.add(bal);
    }
  }

  // ---- fins as one instanced draw call ----
  if (finInstances.length) {
    const finG = new THREE.BoxGeometry(0.1, 1, 0.32);
    const inst = new THREE.InstancedMesh(finG, finMat, finInstances.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), e = new THREE.Euler();
    finInstances.forEach((fi, idx) => {
      e.set(0, fi.rotY, 0);
      q.setFromEuler(e);
      sc.set(1, fi.h, 1);
      m4.compose(new THREE.Vector3(fi.x, fi.y, fi.z), q, sc);
      inst.setMatrixAt(idx, m4);
    });
    inst.castShadow = true;
    inst.userData.feature = 'fins';
    group.add(inst);
  }

  // ---- exoskeleton spine truss following the twist ----
  if (mode === 'solid' && state.spine && detail === 'high') {
    const spinePts = [];
    for (let i = Math.max(state.podiumFloors, state.liftGround); i <= state.floors; i++) {
      const f = floorSpec(state, Math.min(i, state.floors - 1));
      const y = i * fh;
      const apexR = f.w / 2 + f.prow + 2.3;
      const [ax, az] = rotXZ(apexR, 0, f.rot);
      spinePts.push({ v: new THREE.Vector3(ax, y, az), f });
    }
    // main helical chord
    for (let i = 0; i < spinePts.length - 1; i++) {
      group.add(tube(spinePts[i].v, spinePts[i + 1].v, 0.5, MATS.spine, 'spine'));
    }
    // ties + diagonals at segment rhythm
    const shaft = state.floors - state.podiumFloors;
    const segs = Math.max(1, Math.min(state.segments || 1, Math.floor(shaft / 2)));
    const perSeg = shaft / segs;
    for (let k = 0; k <= segs; k++) {
      const fl = Math.min(state.floors - 1, state.podiumFloors + Math.round(k * perSeg));
      const idx = Math.min(spinePts.length - 1, fl - Math.max(state.podiumFloors, state.liftGround));
      if (idx < 0) continue;
      const sp = spinePts[idx];
      const f = sp.f;
      const [fx, fz] = rotXZ(f.w / 2 + f.prow * 0.9, 0, f.rot);
      group.add(tube(sp.v, new THREE.Vector3(fx, sp.v.y, fz), 0.26, MATS.spine, 'spine'));
      // diagonals down to the previous tie point on the facade
      if (k > 0) {
        const prevFl = Math.min(state.floors - 1, state.podiumFloors + Math.round((k - 1) * perSeg));
        const pf = floorSpec(state, prevFl);
        const [px, pz] = rotXZ(pf.w / 2 + pf.prow * 0.9, 0, pf.rot);
        group.add(tube(sp.v, new THREE.Vector3(px, prevFl * fh, pz), 0.22, MATS.spine, 'spine'));
        const [sx, sz] = rotXZ(pf.w / 2 + pf.prow + 2.3, 0, pf.rot);
        group.add(tube(new THREE.Vector3(fx, sp.v.y, fz), new THREE.Vector3(sx, prevFl * fh, sz), 0.22, MATS.spine, 'spine'));
      }
    }
  }

  // ---- crown ----
  const top = floorSpec(state, state.floors - 1);
  const topY = state.floors * fh;

  if (mode === 'solid') {
    if (state.crown === 'crown') {
      const c1 = new THREE.Mesh(floorSolid(torsoShape(top.w * 0.86, top.d * 0.86, top.r, top.prow * 0.7), 4), MATS.crown);
      c1.position.y = topY; c1.rotation.y = top.rot; c1.castShadow = true; c1.userData.feature = 'crown';
      const c2 = new THREE.Mesh(floorSolid(torsoShape(top.w * 0.6, top.d * 0.6, top.r, top.prow * 0.4), 3), MATS.crown);
      c2.position.y = topY + 4; c2.rotation.y = top.rot; c2.castShadow = true; c2.userData.feature = 'crown';
      group.add(c1, c2);
    } else if (state.crown === 'garden' || state.greenRoof) {
      const g = new THREE.Mesh(floorSolid(torsoShape(top.w - 1, top.d - 1, top.r, top.prow * 0.8), 0.6), MATS.garden);
      g.position.y = topY; g.rotation.y = top.rot; g.userData.feature = state.crown === 'garden' ? 'crown' : 'greenroof';
      group.add(g);
      if (state.crown === 'garden') {
        const treeG = new THREE.ConeGeometry(1.1, 3, 7);
        for (let k = 0; k < 6; k++) {
          const tr = new THREE.Mesh(treeG, MATS.garden);
          const a = (k / 6) * Math.PI * 2;
          const [tx, tz] = rotXZ(Math.cos(a) * top.w * 0.28, Math.sin(a) * top.d * 0.28, top.rot);
          tr.position.set(tx, topY + 2, tz);
          tr.castShadow = true; tr.userData.feature = 'crown';
          group.add(tr);
        }
      }
    } else {
      // flat: white mechanical drum, like the torso's quiet top
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(top.w, top.d) * 0.16, Math.min(top.w, top.d) * 0.18, 5, 20), MATS.crown);
      drum.position.y = topY + 2.5;
      const [dx, dz] = rotXZ(-top.w * 0.1, 0, top.rot);
      drum.position.x = dx; drum.position.z = dz;
      drum.castShadow = true; drum.userData.feature = 'crown';
      group.add(drum);
    }
  }

  return group;
}

export function disposeTowerGroup(group) {
  group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
}
