// The napkin: a vector-first sketch surface. Strokes are stored normalized
// (0..1) so the canvas can resize without losing the drawing. A photo can sit
// underneath the ink. Interpretation never sees pixels from the screen — it
// gets a clean offscreen "ink canvas" rendered from strokes (+ thresholded photo).

const PEN = '#2d3e57';
const PEN_W = 0.006;      // stroke width as a fraction of canvas size
const ERASE_W = 0.05;

let canvas, ctx, dpr = 1;
// Feather-style view layers: each view keeps its own strokes + photo.
const views = {
  front: { strokes: [], photo: null },
  side: { strokes: [], photo: null },
  plan: { strokes: [], photo: null },
};
let currentView = 'front';
let strokes = views.front.strokes;   // alias to the active layer
let photo = null;
let drawing = null;
let changeCb = null, changeTimer = 0;

export function setView(v) {
  if (!views[v]) return;
  currentView = v;
  strokes = views[v].strokes;
  photo = views[v].photo;
  paint();
}
export function getView() { return currentView; }
export function viewHasInk(v) { return views[v].strokes.some(s => s.tool === 'pen') || !!views[v].photo; }
export function inkCanvasFor(v, size = 220) {
  const keep = currentView;
  currentView = v; strokes = views[v].strokes; photo = views[v].photo;
  const cv = inkCanvas(size);
  currentView = keep; strokes = views[keep].strokes; photo = views[keep].photo;
  return cv;
}

export function initSketch(el, onChange) {
  canvas = el;
  ctx = canvas.getContext('2d');
  changeCb = onChange;
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  // Pen/touch policy: a finger always draws. Palm rejection only bites while a
  // stylus is actually on the glass, or just after it lifted — a sticky "pen
  // seen once" flag would leave an iPad owner unable to draw with a finger
  // ever again.
  const PALM_MS = 900;
  let penDownAt = 0, penActive = false;
  let activeId = null;
  const pressureOf = e => {
    if (e.pointerType !== 'pen') return 1;
    // Safari reports 0 pressure for hover-then-touch; clamp to a usable range
    const raw = e.pressure > 0 ? e.pressure : 0.5;
    return 0.45 + raw * 1.15;
  };

  canvas.addEventListener('pointerdown', e => {
    if (e.pointerType === 'pen') { penActive = true; penDownAt = performance.now(); }
    else if (e.pointerType === 'touch' && (penActive || performance.now() - penDownAt < PALM_MS)) {
      return;                                                 // that is the palm, not the hand
    }
    if (activeId !== null) return;                            // one stroke at a time
    activeId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    const p = norm(e);
    p.pr = pressureOf(e);
    drawing = { tool: currentTool, pts: [p] };
    strokes.push(drawing);
    paint();
  });
  canvas.addEventListener('pointermove', e => {
    if (!drawing || e.pointerId !== activeId) return;
    // Coalesced events keep fast pencil strokes smooth instead of polygonal.
    // The list comes back empty on some paths, and an empty list would drop
    // every point and leave the stroke looking like a tap, so fall back to
    // the event itself.
    let evs = [e];
    if (e.getCoalescedEvents) {
      try { const c = e.getCoalescedEvents(); if (c && c.length) evs = c; } catch { /* keep e */ }
    }
    let added = false;
    for (const ev of evs) {
      const p = norm(ev);
      p.pr = pressureOf(ev);
      const last = drawing.pts[drawing.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) > 0.0022) { drawing.pts.push(p); added = true; }
    }
    if (added) paint();
  });
  // A small window onto the input state — a stroke that goes missing is
  // otherwise invisible from the outside.
  window.__napkin = {
    strokes: () => strokes.length,
    points: () => strokes[strokes.length - 1]?.pts.length ?? 0,
    tool: () => currentTool,
    active: () => activeId,
    penWindow: () => ({ penActive, sincePen: Math.round(performance.now() - penDownAt) }),
  };

  const up = e => {
    if (e && e.pointerType === 'pen') { penActive = false; penDownAt = performance.now(); }
    if (e && e.pointerId !== activeId) return;
    activeId = null;
    if (!drawing) return;
    if (drawing.pts.length < 2) strokes.pop();  // discard taps
    drawing = null;
    fireChange();
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
}

let currentTool = 'pen';
export function setTool(t) { currentTool = t; }
export function undo() { strokes.pop(); paint(); fireChange(); }
export function clearAll() {
  views[currentView].strokes.length = 0;
  views[currentView].photo = null;
  photo = null;
  paint(); fireChange();
}
export function hasInk() { return viewHasInk('front') || viewHasInk('side') || viewHasInk('plan'); }

export async function loadPhoto(file) {
  photo = await createImageBitmap(file);
  views[currentView].photo = photo;
  paint();
  fireChange();
}

function fireChange() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => changeCb?.(), 650);
}

function norm(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
}

function resize() {
  dpr = Math.min(devicePixelRatio, 2);
  const r = canvas.getBoundingClientRect();
  if (r.width < 2) return;
  canvas.width = r.width * dpr;
  canvas.height = r.height * dpr;
  paint();
}

// Deterministic pseudo-random (stable across repaints — no shimmer)
function jit(seed) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return (x - Math.floor(x)) - 0.5;
}

// Pressure from speed: a slow, deliberate line presses harder than a flick.
function strokeWidths(pts) {
  const raw = pts.map((p, i) => {
    const d = i ? Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0.004;
    return Math.max(0.4, Math.min(1.7, 1.6 - d * 52));
  });
  return raw.map((v, i) => ((raw[i - 1] ?? v) + v * 2 + (raw[i + 1] ?? v)) / 4);
}

const GRAPHITE = '#41454e';

function paintPencil(c, s, size) {
  const pts = s.pts;
  if (pts.length < 2) return;
  const ws = strokeWidths(pts);
  const base = Math.max(1.3, 0.0056 * size);
  const passes = [
    { off: 0, alpha: 0.58, wf: 1 },        // core
    { off: 0.0015, alpha: 0.20, wf: 0.72 },// grain strand
    { off: -0.0012, alpha: 0.15, wf: 0.55 },
  ];
  c.save();
  c.lineCap = c.lineJoin = 'round';
  c.strokeStyle = GRAPHITE;
  for (const p of passes) {
    for (let i = 1; i < pts.length; i++) {
      const taper = Math.min(1, 0.35 + Math.min(i, pts.length - 1 - i) * 0.22);
      c.globalAlpha = p.alpha * (0.7 + 0.3 * ws[i]) * taper * (0.85 + 0.3 * Math.abs(jit(i * 3 + p.off * 999)));
      c.lineWidth = base * ws[i] * p.wf * (pts[i].pr ?? 1);
      const jx = jit(i * 7.3 + pts[i].x * 91) * 0.0022 * size;
      const jy = jit(i * 5.1 + pts[i].y * 77) * 0.0022 * size;
      c.beginPath();
      c.moveTo(pts[i - 1].x * size + p.off * size, pts[i - 1].y * size + p.off * size * 0.6);
      c.lineTo(pts[i].x * size + p.off * size + jx, pts[i].y * size + p.off * size * 0.6 + jy);
      c.stroke();
    }
  }
  c.restore();
  c.globalAlpha = 1;
}

function drawStrokes(c, size, inkOnly = false) {
  for (const s of strokes) {
    if (s.tool === 'erase') {
      c.save();
      c.globalCompositeOperation = 'destination-out';
      c.lineWidth = ERASE_W * size;
      c.strokeStyle = '#000';
      c.lineJoin = c.lineCap = 'round';
      c.beginPath();
      s.pts.forEach((p, i) => i ? c.lineTo(p.x * size, p.y * size) : c.moveTo(p.x * size, p.y * size));
      c.stroke();
      c.restore();
    } else if (inkOnly) {
      c.save();
      c.lineWidth = Math.max(2.4, PEN_W * 1.4 * size);
      c.strokeStyle = '#000';
      c.lineJoin = c.lineCap = 'round';
      c.beginPath();
      s.pts.forEach((p, i) => i ? c.lineTo(p.x * size, p.y * size) : c.moveTo(p.x * size, p.y * size));
      c.stroke();
      c.restore();
    } else {
      paintPencil(c, s, size);
    }
  }
}

function paint() {
  if (!ctx) return;
  const size = canvas.width;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (photo) {
    ctx.save();
    ctx.globalAlpha = 0.9;
    const s = Math.min(canvas.width / photo.width, canvas.height / photo.height);
    const w = photo.width * s, h = photo.height * s;
    ctx.drawImage(photo, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    ctx.restore();
  }
  drawStrokes(ctx, size);
  const hint = document.getElementById('napkin-hint');
  if (hint) hint.style.opacity = hasInk() ? '0' : '1';
}

// Clean binary ink bitmap for the interpreter: strokes in black, photo thresholded.
export function inkCanvas(size = 220) {
  const off = document.createElement('canvas');
  off.width = off.height = size;
  const c = off.getContext('2d');
  c.fillStyle = '#fff';
  c.fillRect(0, 0, size, size);

  if (photo) {
    const s = Math.min(size / photo.width, size / photo.height);
    const w = photo.width * s, h = photo.height * s;
    c.drawImage(photo, (size - w) / 2, (size - h) / 2, w, h);
    // adaptive threshold: mean luminance − margin
    const img = c.getImageData(0, 0, size, size);
    const d = img.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
    const mean = sum / (d.length / 4);
    for (let i = 0; i < d.length; i += 4) {
      const lum = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
      const ink = lum < mean - 26 ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = ink;
    }
    c.putImageData(img, 0, 0);
  }
  drawStrokes(c, size, true);
  return off;
}

export function thumbnail(size = 128) {
  const off = document.createElement('canvas');
  off.width = off.height = size;
  const c = off.getContext('2d');
  c.fillStyle = '#f6f2e8';
  c.fillRect(0, 0, size, size);
  if (photo) {
    const s = Math.min(size / photo.width, size / photo.height);
    c.globalAlpha = 0.85;
    c.drawImage(photo, (size - photo.width * s) / 2, (size - photo.height * s) / 2, photo.width * s, photo.height * s);
    c.globalAlpha = 1;
  }
  drawStrokes(c, size);
  return off.toDataURL('image/png');
}

// High-res composite (photo + strokes) — what the AI interpreter actually reads.
export function sketchDataURL(size = 640) {
  const off = document.createElement('canvas');
  off.width = off.height = size;
  const c = off.getContext('2d');
  c.fillStyle = '#faf8f2';
  c.fillRect(0, 0, size, size);
  if (photo) {
    const s = Math.min(size / photo.width, size / photo.height);
    c.drawImage(photo, (size - photo.width * s) / 2, (size - photo.height * s) / 2, photo.width * s, photo.height * s);
  }
  drawStrokes(c, size);
  return off.toDataURL('image/jpeg', 0.88);
}

export function photoDataURL(max = 800) {
  if (!photo) return null;
  const s = Math.min(1, max / Math.max(photo.width, photo.height));
  const off = document.createElement('canvas');
  off.width = photo.width * s; off.height = photo.height * s;
  off.getContext('2d').drawImage(photo, 0, 0, off.width, off.height);
  return off.toDataURL('image/jpeg', 0.85);
}

export function serializeStrokes() {
  return {
    front: structuredClone(views.front.strokes),
    side: structuredClone(views.side.strokes),
    plan: structuredClone(views.plan.strokes),
  };
}
export function restoreStrokes(saved) {
  if (Array.isArray(saved)) {           // legacy single-layer shape
    views.front.strokes = structuredClone(saved);
    views.side.strokes = []; views.plan.strokes = [];
  } else {
    views.front.strokes = structuredClone(saved?.front || []);
    views.side.strokes = structuredClone(saved?.side || []);
    views.plan.strokes = structuredClone(saved?.plan || []);
  }
  views.front.photo = views.side.photo = views.plan.photo = null;
  strokes = views[currentView].strokes;
  photo = null;
  paint();
}
