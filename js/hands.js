// Hand control — webcam gestures via MediaPipe Hands (lazy CDN load).
//
// The vocabulary, like handling a physical model:
//   OPEN PALM facing you          orbit the camera; hold still to re-frame
//   FIST                          zoom: raise to zoom out, lower to zoom in
//   KARATE CHOP (palm sideways)   slide left/right — section cut through the model
//   PALM UP (palm to the sky)     raise/lower — horizontal cut, hiding the top
//   TWO OPEN PALMS                spread apart — exploded axonometric; bring
//                                 them together to reassemble
//   POINT (thumb+index open)      aim at a face — it highlights
//   PINCH (thumb+index closed)    grab the highlighted face and pull it
//
// Three rules keep it from firing by accident: a shape holds for DWELL_MS
// before it becomes the mode; movement under DEADZONE reads as a resting
// hand; a hand out of frame ends everything and nothing moves.

let stream = null, camLoop = 0, hands = null;
let cb = {};
let mode = null;            // 'orbit'|'fist'|'sectionX'|'sectionY'|'point'|'pinch'|'explode'|null
let smooth = { x: 0.5, y: 0.5 };
let lastPos = null;
let pending = null, pendingSince = 0;
let stillSince = 0, heldFired = false;

const DWELL_MS = 140;
const DEADZONE = 0.006;
const HOLD_MS = 1200;
const STILL = 0.02;

const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/';

const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src; s.crossOrigin = 'anonymous';
    s.onload = res; s.onerror = () => rej(new Error('could not load ' + src));
    document.head.appendChild(s);
  });
}

export async function startHands(video, previewCanvas, callbacks) {
  cb = callbacks;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const lanOverHttp = location.protocol === 'http:'
      && !['localhost', '127.0.0.1'].includes(location.hostname);
    throw new Error(lanOverHttp
      ? `the camera API needs a secure origin. On this computer open http://localhost:8137/Napkin/ instead of http://${location.hostname}:8137 — for iPad/phone the page must be served over HTTPS`
      : 'this browser does not expose a camera API');
  }
  stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' } });
  video.srcObject = stream;
  await video.play();

  await loadScript(CDN + 'hands.js');
  // eslint-disable-next-line no-undef
  hands = new Hands({ locateFile: f => CDN + f });
  hands.setOptions({ maxNumHands: 2, modelComplexity: 0, minDetectionConfidence: 0.6, minTrackingConfidence: 0.55 });
  hands.onResults(res => onResults(res, video, previewCanvas));

  const pump = async () => {
    if (!stream) return;
    try { await hands.send({ image: video }); } catch { /* frame skipped */ }
    camLoop = requestAnimationFrame(pump);
  };
  pump();
}

// ---- pose reading ----

const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

// The palm's facing, from the plane spanned by wrist → index-mcp / pinky-mcp.
// Normal mostly toward the camera = the familiar orbit palm; mostly sideways
// = a chop; mostly vertical in the image = palm up (or down).
export function palmOrient(lm) {
  const w = lm[0], i = lm[5], p = lm[17];
  const v1 = { x: i.x - w.x, y: i.y - w.y, z: (i.z || 0) - (w.z || 0) };
  const v2 = { x: p.x - w.x, y: p.y - w.y, z: (p.z || 0) - (w.z || 0) };
  const nx = v1.y * v2.z - v1.z * v2.y;
  const ny = v1.z * v2.x - v1.x * v2.z;
  const nz = v1.x * v2.y - v1.y * v2.x;
  const ax = Math.abs(nx), ay = Math.abs(ny) * 0.9, az = Math.abs(nz) * 0.8;
  if (ax >= ay && ax >= az) return 'side';
  if (ay >= az) return 'up';
  return 'camera';
}

export function classify(lm) {
  const wrist = lm[0], midMcp = lm[9];
  // 3D distances: a palm turned to the sky foreshortens its fingers to almost
  // nothing in 2D — its extension lives in z, and MediaPipe provides it
  const span = d3(wrist, midMcp) || 0.1;
  const d = (a, b) => d3(lm[a], lm[b]) / span;

  const pinchGap = d(4, 8);
  const idx = d(8, 0), mid = d(12, 0), ring = d(16, 0), pinky = d(20, 0);
  const avgExt = (idx + mid + ring + pinky) / 4;

  if (pinchGap < 0.55) return 'pinch';
  // thumb+index open, the rest curled: aiming at a face
  if (pinchGap > 0.62 && idx > 1.55 && mid < 1.3 && ring < 1.3 && pinky < 1.35) return 'point';
  if (avgExt < 1.35) return 'fist';
  if (avgExt > 1.7) {
    const o = palmOrient(lm);
    return o === 'side' ? 'sectionX' : o === 'up' ? 'sectionY' : 'orbit';
  }
  return null;
}

const isOpen = lm => {
  const span = d3(lm[0], lm[9]) || 0.1;
  const d = (a, b) => d3(lm[a], lm[b]) / span;
  return (d(8, 0) + d(12, 0) + d(16, 0) + d(20, 0)) / 4 > 1.6;
};

function endMode() {
  if (!mode) return;
  if (mode === 'pinch') cb.onFaceRelease?.();
  else if (mode === 'point') cb.onHoverEnd?.();
  else if (mode === 'sectionX' || mode === 'sectionY') cb.onSectionEnd?.();
  else if (mode === 'explode') cb.onExplodeEnd?.();
  mode = null; lastPos = null;
}

function onResults(res, video, canvas) {
  const all = res.multiHandLandmarks || [];
  drawPreview(canvas, video, all);

  // ---- two open palms: the exploded axon ----
  if (all.length === 2 && isOpen(all[0]) && isOpen(all[1])) {
    if (mode !== 'explode') { endMode(); mode = 'explode'; }
    const dist = d3(all[0][0], all[1][0]);
    const t = Math.max(0, Math.min(1, (dist - 0.18) / 0.4));
    cb.onExplode?.(t);
    cb.onCursor?.(null);
    return;
  }
  if (mode === 'explode' && all.length !== 2) endMode();

  const lm = all[0];
  if (!lm) {
    endMode();
    pending = null; stillSince = 0; heldFired = false;
    cb.onCursor?.(null);
    return;
  }

  const px = 1 - (lm[8].x * 0.5 + lm[4].x * 0.5);   // mirrored
  const py = lm[8].y * 0.5 + lm[4].y * 0.5;
  smooth.x += (px - smooth.x) * 0.35;
  smooth.y += (py - smooth.y) * 0.35;

  const raw = classify(lm);
  const now = performance.now();
  cb.onCursor?.({ x: smooth.x, y: smooth.y, gesture: mode || raw });

  if (raw !== pending) { pending = raw; pendingSince = now; }
  const settled = raw !== null && now - pendingSince >= DWELL_MS;

  if (settled && raw !== mode) {
    endMode();
    mode = raw;
    lastPos = { x: smooth.x, y: smooth.y };
    stillSince = now; heldFired = false;
    if (mode === 'pinch') cb.onFaceGrab?.(smooth.x, smooth.y);
    else if (mode === 'point') cb.onHover?.(smooth.x, smooth.y);
    else if (mode === 'sectionX') cb.onSection?.('x', smooth.x);
    else if (mode === 'sectionY') cb.onSection?.('y', smooth.y);
    return;
  }
  if (raw === null && mode && now - pendingSince >= DWELL_MS) { endMode(); return; }
  if (!mode || !lastPos) return;

  const dx = smooth.x - lastPos.x, dy = smooth.y - lastPos.y;

  if (Math.hypot(dx, dy) > STILL) { stillSince = now; heldFired = false; }
  else if (mode === 'orbit' && !heldFired && now - stillSince >= HOLD_MS) {
    heldFired = true;
    cb.onHold?.();
    return;
  }

  // sections and aiming track the hand continuously, even tiny moves
  if (mode === 'sectionX') { cb.onSection?.('x', smooth.x); lastPos = { x: smooth.x, y: smooth.y }; return; }
  if (mode === 'sectionY') { cb.onSection?.('y', smooth.y); lastPos = { x: smooth.x, y: smooth.y }; return; }
  if (mode === 'point') { cb.onHover?.(smooth.x, smooth.y); lastPos = { x: smooth.x, y: smooth.y }; return; }

  if (Math.abs(dx) < DEADZONE && Math.abs(dy) < DEADZONE) return;
  if (mode === 'orbit') cb.onOrbit?.(dx, dy);
  else if (mode === 'fist') cb.onZoomStep?.(1 + dy * 2.2);
  else if (mode === 'pinch') cb.onFaceDrag?.(smooth.x, smooth.y);
  lastPos = { x: smooth.x, y: smooth.y };
}

// ---- the preview window: mirrored camera + skeletons ----
const MODE_LABEL = {
  orbit: 'orbit', fist: 'zoom', pinch: 'pull face', point: 'aim',
  sectionX: 'section', sectionY: 'cut top', explode: 'explode',
};

function drawPreview(canvas, video, allHands) {
  if (!canvas) return;
  const c = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  c.save();
  c.clearRect(0, 0, w, h);
  c.translate(w, 0); c.scale(-1, 1);          // mirror, like a mirror
  c.drawImage(video, 0, 0, w, h);
  for (const lm of allHands || []) {
    c.strokeStyle = '#62d6b2';
    c.lineWidth = 2;
    for (const [a, b] of BONES) {
      c.beginPath();
      c.moveTo(lm[a].x * w, lm[a].y * h);
      c.lineTo(lm[b].x * w, lm[b].y * h);
      c.stroke();
    }
    c.fillStyle = '#bd5f3d';
    for (const p of lm) {
      c.beginPath(); c.arc(p.x * w, p.y * h, 3, 0, 7); c.fill();
    }
  }
  c.restore();
  if (allHands?.length && mode) {
    c.fillStyle = '#00000088';
    c.fillRect(6, h - 24, 84, 18);
    c.fillStyle = '#fff';
    c.font = '11px Inter, sans-serif';
    c.fillText(MODE_LABEL[mode] || mode, 12, h - 11);
  }
}

export function stopHands(video) {
  cancelAnimationFrame(camLoop);
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (video) video.srcObject = null;
  endMode();
  cb.onCursor?.(null);
}

export function isRunning() { return !!stream; }

// on-screen cursor in the 3D viewport
const CURSOR_COL = {
  pinch: '#bd5f3d', point: '#bd5f3d', orbit: '#62d6b2',
  fist: '#4a6fa5', sectionX: '#8a6bbf', sectionY: '#8a6bbf',
};
export function drawCursor(canvas, cur) {
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, canvas.width, canvas.height);
  if (!cur) return;
  const x = cur.x * canvas.width, y = cur.y * canvas.height;
  const g = cur.gesture;
  const r = (g === 'pinch' ? 12 : 18) * devicePixelRatio;
  c.strokeStyle = CURSOR_COL[g] || '#2b292688';
  c.lineWidth = 2.5 * devicePixelRatio;
  c.beginPath(); c.arc(x, y, r, 0, 7); c.stroke();
  if (g === 'point') { c.fillStyle = CURSOR_COL.point; c.beginPath(); c.arc(x, y, 3 * devicePixelRatio, 0, 7); c.fill(); }
}
