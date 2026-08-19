// Hand control — webcam gestures via MediaPipe Hands (lazy CDN load).
//
// Gesture vocabulary, like handling a physical model:
//   PINCH (thumb+index closed)      grab the volume under the cursor and drag it
//   OPEN PALM (fingers spread)      orbit the camera by moving your hand
//   FIST (fingers curled)           zoom: raise to zoom out, lower to zoom in
//   OPEN PALM, held still           re-frame the building
//
// Three rules keep it from firing by accident, which is what makes camera
// gestures unusable otherwise:
//   - a shape has to hold for DWELL_MS before it becomes the active mode, so
//     the pinch a hand passes through on its way to a fist never grabs;
//   - movement under DEADZONE is treated as a resting hand, not a drag;
//   - a hand out of frame ends the gesture and nothing moves.
//
// A live preview window shows the camera with the tracked skeleton drawn over
// it, so you can see exactly what the machine sees.

let stream = null, camLoop = 0, hands = null;
let cb = {};
let mode = null;            // 'pinch' | 'open' | 'fist' | null
let smooth = { x: 0.5, y: 0.5 };
let lastPos = null;
let pending = null, pendingSince = 0;   // a shape waiting out its dwell
let stillSince = 0, heldFired = false;  // open palm parked in place

const DWELL_MS = 130;      // long enough to skip shapes passed through
const DEADZONE = 0.006;    // a resting hand drifts about this much per frame
const HOLD_MS = 1200;      // open palm held still re-frames the view
const STILL = 0.02;        // how far "still" is allowed to wander

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
  // Browsers only expose the camera API on secure origins: HTTPS, localhost
  // or 127.0.0.1. A LAN address over plain http gets no mediaDevices at all.
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
  hands.setOptions({ maxNumHands: 1, modelComplexity: 0, minDetectionConfidence: 0.6, minTrackingConfidence: 0.55 });
  hands.onResults(res => onResults(res, video, previewCanvas));

  const pump = async () => {
    if (!stream) return;
    try { await hands.send({ image: video }); } catch { /* frame skipped */ }
    camLoop = requestAnimationFrame(pump);
  };
  pump();
}

function classify(lm) {
  const wrist = lm[0], midMcp = lm[9];
  const span = Math.hypot(wrist.x - midMcp.x, wrist.y - midMcp.y) || 0.1;
  const d = (a, b) => Math.hypot(lm[a].x - lm[b].x, lm[a].y - lm[b].y) / span;

  const pinchGap = d(4, 8);
  // fingertip-to-palm distances for the four fingers
  const curls = [d(8, 0), d(12, 0), d(16, 0), d(20, 0)];
  const avgExt = curls.reduce((a, b) => a + b, 0) / 4;

  if (pinchGap < 0.55) return 'pinch';
  if (avgExt < 1.35) return 'fist';
  if (avgExt > 1.75) return 'open';
  return null;
}

function onResults(res, video, canvas) {
  const lm = res.multiHandLandmarks?.[0];
  drawPreview(canvas, video, lm);

  if (!lm) {
    if (mode) { cb.onGestureEnd?.(mode); mode = null; lastPos = null; }
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

  // dwell: a shape earns the mode only once it has held still-ish for a moment
  if (raw !== pending) { pending = raw; pendingSince = now; }
  const settled = raw !== null && now - pendingSince >= DWELL_MS;

  if (settled && raw !== mode) {
    if (mode) cb.onGestureEnd?.(mode);
    mode = raw;
    lastPos = { x: smooth.x, y: smooth.y };
    stillSince = now; heldFired = false;
    cb.onGestureStart?.(mode, smooth.x, smooth.y);
    return;
  }
  if (raw === null && mode && now - pendingSince >= DWELL_MS) {
    cb.onGestureEnd?.(mode); mode = null; lastPos = null;
    return;
  }
  if (!mode || !lastPos) return;

  const dx = smooth.x - lastPos.x, dy = smooth.y - lastPos.y;

  // an open palm parked in one place is a request to re-frame, not a drag
  if (Math.hypot(dx, dy) > STILL) { stillSince = now; heldFired = false; }
  else if (mode === 'open' && !heldFired && now - stillSince >= HOLD_MS) {
    heldFired = true;
    cb.onHold?.(mode);
    return;
  }

  if (Math.abs(dx) < DEADZONE && Math.abs(dy) < DEADZONE) return;
  cb.onGestureMove?.(mode, smooth.x, smooth.y, dx, dy);
  lastPos = { x: smooth.x, y: smooth.y };
}

// ---- the preview window: mirrored camera + skeleton ----
function drawPreview(canvas, video, lm) {
  if (!canvas) return;
  const c = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  c.save();
  c.clearRect(0, 0, w, h);
  c.translate(w, 0); c.scale(-1, 1);          // mirror, like a mirror
  c.drawImage(video, 0, 0, w, h);
  if (lm) {
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
  // gesture label, un-mirrored
  if (lm && mode) {
    c.fillStyle = '#00000088';
    c.fillRect(6, h - 24, 74, 18);
    c.fillStyle = '#fff';
    c.font = '11px Inter, sans-serif';
    c.fillText(mode === 'pinch' ? 'grab' : mode === 'open' ? 'orbit' : 'zoom', 12, h - 11);
  }
}

export function stopHands(video) {
  cancelAnimationFrame(camLoop);
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (video) video.srcObject = null;
  if (mode) { cb.onGestureEnd?.(mode); mode = null; }
  cb.onCursor?.(null);
}

export function isRunning() { return !!stream; }

// on-screen cursor in the 3D viewport
export function drawCursor(canvas, cur) {
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, canvas.width, canvas.height);
  if (!cur) return;
  const x = cur.x * canvas.width, y = cur.y * canvas.height;
  const g = cur.gesture;
  const r = (g === 'pinch' ? 12 : 18) * devicePixelRatio;
  c.strokeStyle = g === 'pinch' ? '#bd5f3d' : g === 'open' ? '#62d6b2' : g === 'fist' ? '#4a6fa5' : '#2b292688';
  c.fillStyle = c.strokeStyle + '33';
  c.lineWidth = 2.4 * devicePixelRatio;
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill(); c.stroke();
  c.beginPath(); c.arc(x, y, 2.6 * devicePixelRatio, 0, Math.PI * 2);
  c.fillStyle = c.strokeStyle; c.fill();
}
