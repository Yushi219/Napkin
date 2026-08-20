// Sketch -> parameters. Deterministic geometry extraction, no ML required:
//   massing  : row-scan the ink silhouette -> width profile -> floors + stepped segments
//   plan     : Moore-neighbor contour trace -> simplified footprint polygon
// Both operate on the binary ink bitmap, so hand-drawn strokes and thresholded
// photos go through the exact same pipeline. Claude vision (optional, key needed)
// is only an adviser for uploaded photos — never a dependency.

const GRID = 220;

function inkMask(inkCv) {
  const c = inkCv.getContext('2d', { willReadFrequently: true });
  const img = c.getImageData(0, 0, GRID, GRID).data;
  const mask = new Uint8Array(GRID * GRID);
  for (let i = 0; i < GRID * GRID; i++) mask[i] = img[i * 4] < 128 ? 1 : 0;
  return mask;
}

// ---------------- massing: silhouette -> floors + segments ----------------

export function interpretMassing(inkCv, state, opts = {}) {
  const mask = inkMask(inkCv);
  const rows = [], mins = [], maxs = [];
  for (let y = 0; y < GRID; y++) {
    let min = -1, max = -1;
    for (let x = 0; x < GRID; x++) {
      if (mask[y * GRID + x]) { if (min < 0) min = x; max = x; }
    }
    rows.push(min < 0 ? 0 : max - min + 1);
    mins.push(min); maxs.push(max);
  }
  // smooth
  const w = rows.map((v, i) => {
    let s = 0, n = 0;
    for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < GRID) { s += rows[j]; n++; } }
    return s / n;
  });
  const maxW = Math.max(...w);
  if (maxW < GRID * 0.06) return null; // nothing meaningful drawn

  const solid = w.map(v => v > maxW * 0.12);
  // take the TALLEST connected solid run — detached ground/motion lines below
  // or above the building must not stretch its extent
  let top = -1, bottom = -1, runStart = -1;
  for (let y = 0; y <= GRID; y++) {
    const on = y < GRID && solid[y];
    if (on && runStart < 0) runStart = y;
    if (!on && runStart >= 0) {
      if (top < 0 || (y - 1 - runStart) > (bottom - top)) { top = runStart; bottom = y - 1; }
      runStart = -1;
    }
  }
  if (top < 0 || bottom - top < GRID * 0.08) return null;

  const hPx = bottom - top;
  // base width = median of the lowest 15% of the building
  const baseRows = [];
  for (let y = bottom; y > bottom - Math.max(4, hPx * 0.15); y--) baseRows.push(w[y]);
  baseRows.sort((a, b) => a - b);
  const basePx = baseRows[Math.floor(baseRows.length / 2)] || maxW;

  const baseWidth = state.baseWidth;                    // metres stay user-controlled
  const mPerPx = baseWidth / basePx;
  const heightM = hPx * mPerPx;
  const floors = Math.max(3, Math.min(60, Math.round(heightM / state.floorHeight)));

  // width ratio per floor = LOWER-QUARTILE of the RAW rows in that floor's band.
  // Horizontal shelf strokes at setbacks read as full-width rows; the raw (un-
  // smoothed) lower quartile ignores them where a smoothed median would not.
  const ratios = [];
  for (let f = 0; f < floors; f++) {
    const y1 = Math.round(bottom - (f + 1) * (hPx / floors));
    const y2 = Math.round(bottom - f * (hPx / floors));
    const band = [];
    for (let y = Math.max(top, y1); y <= Math.min(bottom, y2); y++) if (rows[y] > 0) band.push(rows[y]);
    band.sort((a, b) => a - b);
    ratios.push(Math.min(1.15, (band[Math.floor(band.length * 0.25)] || basePx) / basePx));
  }
  // cluster consecutive similar ratios into segments
  let segments = [];
  let curStart = 0, curSum = ratios[0], curN = 1;
  for (let f = 1; f < floors; f++) {
    const mean = curSum / curN;
    if (Math.abs(ratios[f] - mean) > 0.09) {
      segments.push({ fromFloor: curStart, scale: curSum / curN });
      curStart = f; curSum = ratios[f]; curN = 1;
    } else { curSum += ratios[f]; curN++; }
  }
  segments.push({ fromFloor: curStart, scale: curSum / curN });
  // merge near-identical neighbours, then absorb slivers (<2 floors ≈ shelf-line artifacts)
  const merged = [segments[0]];
  for (let i = 1; i < segments.length; i++) {
    const prev = merged[merged.length - 1];
    if (Math.abs(segments[i].scale - prev.scale) < 0.07) prev.scale = (prev.scale + segments[i].scale) / 2;
    else merged.push(segments[i]);
  }
  const solid2 = [];
  for (let i = 0; i < merged.length; i++) {
    const span = (i + 1 < merged.length ? merged[i + 1].fromFloor : floors) - merged[i].fromFloor;
    if (span < 2 && i > 0) continue;                        // sliver: let the previous segment run through it
    if (span < 2 && i === 0 && merged.length > 1) {         // sliver at the base: start from the next real one
      merged[i + 1].fromFloor = 0;
      continue;
    }
    solid2.push(merged[i]);
  }
  segments = solid2.map(s => ({ fromFloor: s.fromFloor, scale: round2(Math.max(0.25, Math.min(1.05, s.scale))) }));

  // How well do flat plateaus explain the profile? A high residual means the
  // hand drew CURVES — switch vocabulary from stacked steps to a lofted profile.
  const segScaleAt = f => { let s = segments[0].scale; for (const seg of segments) if (f >= seg.fromFloor) s = seg.scale; return s; };
  const residual = ratios.reduce((a, r, f) => a + Math.abs(r - segScaleAt(f)), 0) / ratios.length;

  if (opts.forceProfile || residual > 0.055 || segments.length > 6) {
    // freeform: sample width AND centreline drift per slice (curves + leans survive)
    const S = 40;
    const profile = [];
    for (let i = 0; i < S; i++) {
      const y = Math.round(bottom - (i + 0.5) * (hPx / S));
      const band = [];
      const cxs = [];
      for (let k = -2; k <= 2; k++) {
        const yy = Math.max(top, Math.min(bottom, y + k));
        if (rows[yy] > 0) { band.push(rows[yy]); cxs.push((mins[yy] + maxs[yy]) / 2); }
      }
      band.sort((a, b) => a - b);
      const wr = (band[Math.floor(band.length / 2)] || basePx) / basePx;
      const cx = cxs.length ? (cxs.reduce((a, b) => a + b, 0) / cxs.length - GRID / 2) / basePx : 0;
      profile.push({ t: i / (S - 1), w: round2(Math.max(0.12, Math.min(1.3, wr))), cx: round2(Math.max(-0.8, Math.min(0.8, cx))) });
    }
    // gentle smoothing pass
    for (let i = 1; i < S - 1; i++) {
      profile[i].w = round2((profile[i - 1].w + profile[i].w * 2 + profile[i + 1].w) / 4);
      profile[i].cx = round2((profile[i - 1].cx + profile[i].cx * 2 + profile[i + 1].cx) / 4);
    }
    // a curve that meets the ground must STAND on the ground: the base slices
    // inherit the widest reading of the lower quarter (no pin-point footings)
    const lower = profile.slice(0, Math.max(4, Math.floor(S / 4)));
    const wBase = Math.max(...lower.map(p => p.w));
    for (let i = 0; i < 4; i++) profile[i].w = round2(Math.max(profile[i].w, wBase * (1 - i * 0.02)));
    // recentre on the lower quarter's median drift, not a single noisy slice
    const cxs2 = lower.map(p => p.cx).sort((a, b) => a - b);
    const cx0 = cxs2[Math.floor(cxs2.length / 2)];
    for (const p of profile) p.cx = round2(p.cx - cx0);
    return { mode: 'massing', floors, segments: [], taper: 1, profile, footprint: null };
  }

  // a monotonic staircase of small steps ≈ the hand drew a taper
  const monotonic = segments.every((s, i) => i === 0 || s.scale <= segments[i - 1].scale + 0.02);
  const smallSteps = segments.every((s, i) => i === 0 || Math.abs(s.scale - segments[i - 1].scale) < 0.2);
  if (segments.length >= 4 && monotonic && smallSteps) {
    const topScale = segments[segments.length - 1].scale;
    return { mode: 'massing', floors, segments: [], taper: Math.max(0.45, Math.min(1.05, round2(topScale))), profile: null, footprint: null };
  }
  segments = segments.slice(0, 6);
  // normalise so the base segment is 1.0
  const s0 = segments[0].scale || 1;
  for (const s of segments) s.scale = round2(Math.min(1.05, s.scale / s0));
  return { mode: 'massing', floors, segments: segments.length > 1 ? segments : [], taper: 1, profile: null, footprint: null };
}

// ---------------- plan: contour trace -> footprint polygon ----------------

const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

export function interpretPlan(inkCv, state) {
  const raw = inkMask(inkCv);
  // dilate once so gappy hand strokes connect
  const mask = new Uint8Array(GRID * GRID);
  for (let y = 1; y < GRID - 1; y++) for (let x = 1; x < GRID - 1; x++) {
    let on = 0;
    for (let dy = -1; dy <= 1 && !on; dy++) for (let dx = -1; dx <= 1 && !on; dx++) {
      if (raw[(y + dy) * GRID + (x + dx)]) on = 1;
    }
    mask[y * GRID + x] = on;
  }
  // find start: leftmost ink pixel of the largest row band
  let sx = -1, sy = -1;
  outer: for (let x = 0; x < GRID; x++) for (let y = 0; y < GRID; y++) {
    if (mask[y * GRID + x]) { sx = x; sy = y; break outer; }
  }
  if (sx < 0) return null;

  // Moore-neighbor boundary trace
  const path = [];
  let cx = sx, cy = sy, dir = 6;
  for (let i = 0; i < 6000; i++) {
    path.push([cx, cy]);
    let found = false;
    for (let k = 0; k < 8; k++) {
      const d = (dir + 6 + k) % 8; // start from backtrack direction
      const nx = cx + DIRS[d][0], ny = cy + DIRS[d][1];
      if (nx >= 0 && ny >= 0 && nx < GRID && ny < GRID && mask[ny * GRID + nx]) {
        cx = nx; cy = ny; dir = d; found = true; break;
      }
    }
    if (!found) break;
    if (cx === sx && cy === sy && path.length > 8) break;
  }
  if (path.length < 24) return null;

  let pts = rdp(path, 3.2);
  if (pts.length > 14) pts = rdp(path, 5);
  if (pts.length < 3) return null;

  // scale: longest bbox side -> current base width
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const [x, y] of pts) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const span = Math.max(maxX - minX, maxY - minY);
  if (span < GRID * 0.1) return null;
  const scale = Math.max(state.baseWidth, state.baseDepth) / span;
  const cxm = (minX + maxX) / 2, cym = (minY + maxY) / 2;
  const footprint = pts.map(([x, y]) => [round2((x - cxm) * scale), round2((y - cym) * scale)]);

  // polygon must have real area, not a scribble
  if (Math.abs(polyArea(footprint)) < 40) return null;
  return { mode: 'plan', footprint, segments: [], taper: 1, profile: null };
}

function rdp(points, eps) {
  if (points.length < 3) return points.slice();
  let dmax = 0, idx = 0;
  const [x1, y1] = points[0], [x2, y2] = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const d = Math.abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1) / (Math.hypot(y2 - y1, x2 - x1) || 1);
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax > eps) {
    const a = rdp(points.slice(0, idx + 1), eps), b = rdp(points.slice(idx), eps);
    return a.slice(0, -1).concat(b);
  }
  return [points[0], points[points.length - 1]];
}

export function polyArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

const round2 = v => Math.round(v * 100) / 100;

export function interpret(inkCv, mode, state) {
  return mode === 'plan' ? interpretPlan(inkCv, state) : interpretMassing(inkCv, state);
}

// ---------------- multi-view: the visual hull ----------------
// Front gives width(t) and side-to-side sway; Side gives depth(t) and
// front-to-back sway; Plan gives the section shape. Their intersection is the
// classic visual hull — hand-drawn, fully deterministic.

// Always-freeform silhouette sampling (used for the side view's depth profile).
export function extractProfile(inkCv) {
  const r = interpretMassing(inkCv, { baseWidth: 32, floorHeight: 3.6 }, { forceProfile: true });
  return r?.profile || null;
}

export function interpretViews(sk, state) {
  const hasFront = sk.viewHasInk('front');
  const hasSide = sk.viewHasInk('side');
  const hasPlan = sk.viewHasInk('plan');
  if (!hasFront && !hasSide && !hasPlan) return null;

  // plan only → classic footprint extrusion
  const plan = hasPlan ? interpretPlan(sk.inkCanvasFor('plan'), state) : null;
  if (!hasFront && !hasSide) return plan;

  // if a side view exists, the form is inherently 3D-sculpted → force freeform
  const front = hasFront
    ? interpretMassing(sk.inkCanvasFor('front'), state, { forceProfile: hasSide })
    : null;
  const side = hasSide ? extractProfile(sk.inkCanvasFor('side')) : null;

  const patch = front || {
    mode: 'massing', floors: state.floors, segments: [], taper: 1,
    profile: side, footprint: null,
  };
  if (front && side && !front.profile) patch.profile = null; // orthogonal front stays orthogonal
  patch.profileSide = side;
  if (plan?.footprint) patch.footprint = plan.footprint;   // plan shapes the section
  else if (front) patch.footprint = null;
  patch.views = { front: hasFront, side: hasSide, plan: hasPlan };
  return patch;
}

// ---------------- reverse: a rendering/photo -> ink -> the same pipeline ----------------

export async function imageInkCanvas(dataURL, size = 220) {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataURL; });
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const c = cv.getContext('2d');
  c.fillStyle = '#fff';
  c.fillRect(0, 0, size, size);
  const s = Math.min(size / img.width, size / img.height);
  c.drawImage(img, (size - img.width * s) / 2, (size - img.height * s) / 2, img.width * s, img.height * s);
  const id = c.getImageData(0, 0, size, size);
  const d = id.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
  const mean = sum / (d.length / 4);
  for (let i = 0; i < d.length; i += 4) {
    const lum = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    const ink = lum < mean - 18 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = ink;
  }
  c.putImageData(id, 0, 0);
  return cv;
}

// ---------------- the primary interpreter: Claude reads the sketch ----------------
// A perspective/axon sketch is a COMPOSITION, not a silhouette. Claude decomposes
// it into a scene graph of massing volumes with roles, proportions and facade
// treatments — the same way an architect would read it.

// Robust JSON extraction. The staged-reasoning prompts emit prose then JSON;
// if the budget ran out mid-object we repair the truncation instead of dying
// with "Unexpected end of JSON input" (which used to silently drop the whole
// AI reading and fall back to the crude local reader).
export function parseJsonLoose(text, stopReason) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error(stopReason === 'max_tokens' ? 'reply hit the token limit before any JSON' : 'no JSON in reply');
  let body = text.slice(start);
  const end = body.lastIndexOf('}');
  const whole = end > 0 ? body.slice(0, end + 1) : body;
  try { return JSON.parse(whole); } catch { /* fall through to repair */ }

  // repair: close any unterminated string, then balance braces/brackets
  let s = body;
  let inStr = false, esc = false;
  const stack = [];
  let lastSafe = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') stack.push(c);
    else if (c === '}' || c === ']') stack.pop();
    // a complete element boundary at depth>=1 is a safe truncation point
    if ((c === '}' || c === ']') && stack.length >= 1) lastSafe = i;
  }
  if (inStr) s = s.slice(0, lastSafe > 0 ? lastSafe + 1 : s.length);
  else if (lastSafe > 0 && stack.length) s = s.slice(0, lastSafe + 1);
  s = s.replace(/,\s*$/, '');
  // rebuild the closers
  let inStr2 = false, esc2 = false;
  const open = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc2) { esc2 = false; continue; }
    if (c === '\\') { esc2 = true; continue; }
    if (c === '"') { inStr2 = !inStr2; continue; }
    if (inStr2) continue;
    if (c === '{' || c === '[') open.push(c);
    else if (c === '}' || c === ']') open.pop();
  }
  if (inStr2) s += '"';
  while (open.length) s += open.pop() === '{' ? '}' : ']';
  return JSON.parse(s);
}

export function sanitizeMasses(arr) {
  if (!Array.isArray(arr)) return null;
  const cl = (v, a, b, d) => Number.isFinite(+v) ? Math.max(a, Math.min(b, +v)) : d;
  const out = arr.slice(0, 10).map((m, i) => ({
    id: String(m.id || m.role || `v${i + 1}`).slice(0, 24),
    role: String(m.role || `volume-${i + 1}`).slice(0, 24),
    w: cl(m.w, 2, 90, 15), d: cl(m.d, 2, 90, 12), h: cl(m.h, 2, 180, 12),
    x: cl(m.x, -90, 90, 0), y: cl(m.y, 0, 120, 0), z: cl(m.z, -90, 90, 0),
    rotY: cl(m.rotY, -90, 90, 0),
    facade: ['slats-v', 'slats-h', 'glass', 'solid'].includes(m.facade) ? m.facade : 'solid',
    cantilever: !!m.cantilever,
    on: typeof m.on === 'string' ? m.on.slice(0, 24) : null,
    flush: Array.isArray(m.flush) ? m.flush.slice(0, 4).map(String) : [],
    partOf: typeof m.partOf === 'string' ? m.partOf.slice(0, 24) : null,
    storeys: Number.isFinite(+m.storeys) ? Math.round(+m.storeys) : null,
  })).filter(m => m.w > 1 && m.h > 1);
  return out.length ? snapMasses(out) : null;
}

// Constraint snap: relations beat eyeballed numbers. "Sits on" and "flush"
// hints from the model are resolved into EXACT shared coordinates.
export function snapMasses(masses) {
  const byId = new Map(masses.map(m => [m.id, m]));
  for (const m of masses) {
    if (m.on && m.on !== 'ground') {
      const s = byId.get(m.on);
      if (s) m.y = Math.round((s.y + s.h) * 100) / 100;
    } else if (m.on === 'ground' && !m.cantilever) m.y = 0;
  }
  for (const m of masses) {
    for (const f of m.flush || []) {
      const [face, id] = String(f).split(':');
      const t = byId.get(id);
      if (!t) continue;
      const r2 = v => Math.round(v * 100) / 100;
      if (face === 'front') m.z = r2(t.z + t.d / 2 - m.d / 2);
      else if (face === 'back') m.z = r2(t.z - t.d / 2 + m.d / 2);
      else if (face === 'left') m.x = r2(t.x - t.w / 2 + m.w / 2);
      else if (face === 'right') m.x = r2(t.x + t.w / 2 - m.w / 2);
      else if (face === 'top') m.y = r2(t.y + t.h - m.h);
    }
  }
  return masses;
}

// ---------------- talking to the vision endpoint ----------------

// The API explains every 400 in its response body; throwing the bare status
// hid the one sentence that says what is wrong.
async function apiError(res, what) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || body?.message || '';
  } catch { /* not JSON */ }
  return new Error(`${what} ${res.status}${detail ? ': ' + detail : ''}`);
}

// Claude resizes anything over 1568px on its long edge anyway, and refuses a
// payload over 5 MB. A picture straight from the render model can be either,
// so it is fitted and re-encoded once, which also pins the media type to
// something the endpoint definitely accepts.
const MAX_EDGE = 1400;
function claudeImage(dataURL) {
  return new Promise(resolve => {
    const done = (media, data) => resolve({ type: 'image', source: { type: 'base64', media_type: media, data } });
    const raw = () => {
      const semi = dataURL.indexOf(';'), comma = dataURL.indexOf(',');
      done(semi > 5 && semi < comma ? dataURL.slice(5, semi) : 'image/png', dataURL.slice(comma + 1));
    };
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => {
      try {
        const scale = Math.min(1, MAX_EDGE / Math.max(im.width, im.height));
        const w = Math.max(1, Math.round(im.width * scale));
        const h = Math.max(1, Math.round(im.height * scale));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const c = cv.getContext('2d');
        c.fillStyle = '#ffffff';           // JPEG has no alpha; keep ink on white
        c.fillRect(0, 0, w, h);
        c.drawImage(im, 0, 0, w, h);
        const data = cv.toDataURL('image/jpeg', 0.92).split(',')[1];
        console.info('[napkin] picture for Claude:', w + '×' + h, Math.round(data.length * 0.75 / 1024) + ' KB', 'image/jpeg');
        done('image/jpeg', data);
      } catch (e) {
        console.warn('[napkin] could not re-encode the picture, sending it as it came', e);
        raw();     // a cross-origin picture taints the canvas
      }
    };
    im.onerror = raw;
    im.src = dataURL;
  });
}

export async function visionMasses(dataURL, cfg) {
  if (!cfg.anthropicKey) return null;
  const picture = await claudeImage(dataURL);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: cfg.anthropicModel, max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          picture,
          { type: 'text', text: `You are an architect reading a massing sketch. The image (perspective, axon, elevation or plan) shows a composition of simple volumes. Rebuild it as boxes so faithfully that a render from the same viewpoint would match the drawing.

Work in four stages. Stages 1-3 are short plain prose — never type { or } anywhere before the final JSON.

STAGE 1 — SCENE. Two sentences: what is drawn, and the viewpoint (which facades are visible, eye height).

STAGE 2 — STOREYS. Count drawn floor lines, slats, mullions, doors or people. State each major volume's storey count (one storey ≈ 3.6 m). If uncountable, say "estimating".

STAGE 3 — VOLUMES AND RELATIONS. Name each box (tower, bar, podium, wing, canopy...). For each, state its relations BEFORE any numbers: what it sits on, which faces are flush with which neighbour, what it cantilevers past, what it butts against. An opening, portal or gate through a volume is never one box — decompose it: two legs plus a lintel spanning them, together keeping the parent's overall envelope. A notch = the L of remaining boxes.

STAGE 4 — NUMBERS. Coordinate frame, tied to the drawing: y up, ground y=0. The main front facade faces +z (toward the viewer). x increases to the RIGHT in the sketch. z increases toward the viewer — nearer volumes have larger z. A box occupies x±w/2, z±d/2, y to y+h. Volumes that appear to touch must share coordinates exactly — compute positions from the relations, not by eye:
- B sits on A: B.y = A.y + A.h exactly.
- Flush faces share the plane exactly: fronts, B.z+B.d/2 = A.z+A.d/2; left sides, B.x-B.w/2 = A.x-A.w/2; likewise right/back/top.
- Side-by-side touch: A.x+A.w/2 = B.x-B.w/2. No gaps, no accidental overlaps; interpenetrate only where the drawing shows piercing.
- Portal: leg.x = parent.x ± (parentW-legW)/2; lintel.w = parentW; lintel.y = leg height.
- Nothing floats unless drawn cantilevered — then cantilever:true and y = top of its support.
Centre the composition near x=0, z=0. Verify every stated relation holds in your numbers.

Then output ONLY this JSON, nothing after it:
{"reading":"<=18 words — the design intent",
 "masses":[{"id":"short-slug","role":"tower|bar|podium|canopy|wing|core|volume","w":metres,"d":metres,"h":metres,"x":centre,"z":centre,"y":base elevation,"rotY":degrees,"facade":"slats-v|slats-h|glass|solid","cantilever":bool,"on":"ground"|"<id>","flush":["front|back|left|right|top:<id>"],"partOf":"<slug>"|null,"storeys":int|null}],
 "camera":{"yawDeg":-180..180,"pitchDeg":4..60},
 "floorsHint":int|null,"type":"office|laboratory|residential|hotel|school"|null}

Max 10 boxes. h = storeys × 3.6 wherever storeys were counted. camera = the sketch's viewpoint: yawDeg 0 faces the front (+z) facade; positive yaw walks around to the right (two-point perspective showing front+right ≈ 25-40); pitchDeg = height above horizon (street ≈ 8, aerial ≈ 35). Ignore ground lines, hatching, people, trees.` },
        ],
      }],
    }),
  });
  if (!res.ok) throw await apiError(res, 'vision');
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || '').join('');
  const parsed = parseJsonLoose(text, data.stop_reason);
  const masses = sanitizeMasses(parsed.masses);
  if (!masses) throw new Error('no usable masses');
  const cam = parsed.camera && Number.isFinite(+parsed.camera.yawDeg)
    ? { yawDeg: Math.max(-180, Math.min(180, +parsed.camera.yawDeg)), pitchDeg: Math.max(4, Math.min(60, +parsed.camera.pitchDeg || 18)) }
    : null;
  return { reading: String(parsed.reading || '').slice(0, 140), masses, camera: cam, floorsHint: parsed.floorsHint, type: parsed.type };
}

// Analysis-by-synthesis refinement: show the model its own reconstruction next
// to the sketch, get a structured critique, then corrected masses. Research
// (IR3D-Bench, SceneCraft, SEIG) shows this loop is the single biggest
// fidelity lever — spatial alignment improves monotonically over passes.
export async function visionRefine(sketchDataURL, renderDataURL, masses, camera, cfg) {
  if (!cfg.anthropicKey) return null;
  // both pictures are fitted before the body is built — claudeImage decodes
  // through an <img>, so it has to be awaited, not dropped into the array
  const [imgA, imgB] = await Promise.all([claudeImage(sketchDataURL), claudeImage(renderDataURL)]);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: cfg.anthropicModel, max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          imgA,
          imgB,
          { type: 'text', text: `The FIRST image (A) is the designer's sketch. The SECOND image (B) is a render of the current box-massing reconstruction, taken from the estimated same viewpoint. Your job: make B match A.

Current reconstruction (metres; frame: y up, ground y=0, front facade faces +z, x = right in the sketch, z = toward viewer; a box occupies x±w/2, z±d/2, y to y+h):
MASSES: ${JSON.stringify(masses)}
CAMERA: ${JSON.stringify(camera || { yawDeg: 30, pitchDeg: 18 })}

Critique first, in plain prose — never type { or } before the final JSON. One or two short lines per heading; write "ok" where B already matches A:

CAMERA — is B seen from the same angle as A? If A shows more of the right flank, yaw is too low; if A looks down more, pitch is too low. State corrected yaw/pitch.
POSITION — volumes in the wrong place relative to each other: what should sit on / be flush with / butt against what, but doesn't; what floats or intersects wrongly. Judge relations between volumes, not raw pixels — a global skew is a CAMERA error, not a position error.
PROPORTION — per volume: too wide/deep/tall and by roughly what factor. Use storey counts visible in A as the ruler (one storey ≈ 3.6 m).
MISSING — drawn in A but absent from B. Remember: a portal or opening = two legs + a lintel; a notch = an L of boxes.
EXTRA — present in B but not drawn in A.
FACADE — faces reading as glass / vertical slats / horizontal slats / solid in A but wrong in B.

Then fix everything you criticized and NOTHING else: every mass you marked "ok" keeps identical numbers, role and facade. Recompute corrected positions from relations so touching volumes share coordinates exactly: B sits on A means B.y = A.y + A.h; flush faces share the plane; side-by-side neighbours touch with no gap and no accidental overlap. Nothing floats unless cantilevered (cantilever:true, y = top of support). Keep the composition centred near x=0, z=0.

Output ONLY this JSON, nothing after it:
{"masses":[ the FULL corrected array, every mass, same schema as given, max 10 boxes ],
 "camera":{"yawDeg":-180..180,"pitchDeg":4..60},
 "changes":"<=25 words summarising the fixes"}` },
        ],
      }],
    }),
  });
  if (!res.ok) throw await apiError(res, 'refine');
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || '').join('');
  const parsed = parseJsonLoose(text, data.stop_reason);
  const edited = sanitizeMasses(parsed.masses);
  if (!edited) throw new Error('no usable masses in refine');
  const cam = parsed.camera && Number.isFinite(+parsed.camera.yawDeg)
    ? { yawDeg: Math.max(-180, Math.min(180, +parsed.camera.yawDeg)), pitchDeg: Math.max(4, Math.min(60, +parsed.camera.pitchDeg || 18)) }
    : null;
  return { masses: edited, camera: cam, changes: String(parsed.changes || '').slice(0, 160) };
}

// Red-pen annotation on the 3D view + a comment -> edited masses.
// The 3D-native version of commenting on a design.
export async function visionAnnotatedEdit(annotatedDataURL, comment, masses, cfg) {
  if (!cfg.anthropicKey) return null;
  const picture = await claudeImage(annotatedDataURL);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: cfg.anthropicModel, max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          picture,
          { type: 'text', text: `This is the current 3D massing model. The RED PEN marks are the designer's annotation, and their note says: "${comment}".

Current masses (metres, y = base elevation):
${JSON.stringify(masses)}

Apply the annotated change. You may resize, move, add, remove or re-facade masses — but change ONLY what the annotation and note ask for; keep everything else identical.
Answer ONLY JSON:
{"masses": [ ...the FULL edited array, same schema... ],
 "reply": "<= 16 words on what you changed"}` },
        ],
      }],
    }),
  });
  if (!res.ok) throw await apiError(res, 'vision edit');
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || '').join('');
  const parsed = parseJsonLoose(text, data.stop_reason);
  const edited = sanitizeMasses(parsed.masses);
  if (!edited) throw new Error('no usable masses in edit');
  return { masses: edited, reply: String(parsed.reply || 'Changed.').slice(0, 120) };
}

// Claude vision: full massing decomposition of a rendering — the smart reverse path.
export async function visionParams(dataURL, cfg) {
  if (!cfg.anthropicKey) return null;
  const picture = await claudeImage(dataURL);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: cfg.anthropicModel, max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          picture,
          { type: 'text', text: `Decompose the main building in this image into massing parameters. Answer ONLY JSON:
{"floors": int (estimate from windows/storeys, 3-70),
 "taper": number 0.4-1.15 (top width / base width, 1 if straight),
 "twist": number -90..90 (0 unless visibly twisting),
 "aspect": number 0.5-2 (plan depth/width guess),
 "steps": [{"atFraction": 0-1, "scale": 0.3-1}] (major setbacks, max 3, [] if none),
 "type": "office|laboratory|residential|hotel|school"|null,
 "greenRoof": bool,
 "notes": "<12 words on what you saw"}` },
        ],
      }],
    }),
  });
  if (!res.ok) throw await apiError(res, 'vision');
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || '').join('');
  return parseJsonLoose(text, data.stop_reason);
}

// ---------------- optional adviser: Claude vision on photos ----------------

export async function claudeAdvise(photoDataURL, cfg) {
  if (!cfg.anthropicKey || !photoDataURL) return null;
  const picture = await claudeImage(photoDataURL);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.anthropicKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: cfg.anthropicModel, max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          picture,
          { type: 'text', text: 'This is a napkin sketch of a building. Answer ONLY JSON: {"view":"plan|elevation","floors":int|null,"notes":"<12 words"}. floors only if the sketch clearly indicates storey count (drawn lines or a written number).' },
        ],
      }],
    }),
  });
  if (!res.ok) throw await apiError(res, 'vision');
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || '').join('');
  return parseJsonLoose(text, data.stop_reason);
}
