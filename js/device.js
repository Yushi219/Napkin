// Device adaptation. NAPKIN is at its best where you actually sketch — an iPad
// with a pencil — so the app detects what it is running on and reshapes itself:
//   desktop : three panes, hover affordances, mouse orbit
//   tablet  : bigger napkin, larger hit targets, pencil pressure, palm rejection
//   phone   : one pane at a time behind a tab bar, everything thumb-reachable
//
// Detection is capability-first (pointer type + touch points + screen size),
// never user-agent sniffing alone — iPadOS lies and claims to be a Mac.

let kind = 'desktop';
let hasPen = false;
let listeners = [];

export function deviceKind() { return kind; }
export const __detectForTest = detect;   // classifier is pure — testable with probes
export function isTouch() { return kind !== 'desktop'; }
export function penDetected() { return hasPen; }
export function onDeviceChange(fn) { listeners.push(fn); }

function detect(probe) {
  const coarse = probe?.coarse ?? matchMedia('(pointer: coarse)').matches;
  const fine = probe?.fine ?? matchMedia('(pointer: fine)').matches;
  const noHover = probe?.noHover ?? matchMedia('(hover: none)').matches;
  const touchPoints = probe?.tp ?? (navigator.maxTouchPoints || 0);
  const ua = probe?.ua ?? navigator.userAgent;
  const scr = probe?.screen ?? [screen.width, screen.height];
  // iPadOS 13+ reports as Macintosh; the give-away is a touch-capable "Mac"
  const iPadOS = /Macintosh/.test(ua) && touchPoints > 1;
  const iPhone = /iPhone|iPod/.test(ua);
  const android = /Android/.test(ua);
  const androidPhone = android && /Mobile/.test(ua);

  // Real mobile OSes are identified by UA first — iPadOS is the one that lies,
  // and its tell is a touch-capable "Macintosh".
  if (iPhone || androidPhone) return 'phone';
  if (/iPad/.test(ua) || iPadOS || (android && !/Mobile/.test(ua))) return 'tablet';

  // Anything else with a PRECISE pointer is a computer, even when the screen
  // also happens to be a touchscreen (Surface, touch-enabled laptops) — those
  // want the desktop layout, not thumb-sized controls.
  if (fine) return 'desktop';
  if (touchPoints === 0) return 'desktop';

  const shortSide = Math.min(scr[0], scr[1]);
  const longSide = Math.max(scr[0], scr[1]);
  if (coarse || noHover || touchPoints > 0) {
    // unknown touch device: decide by physical size, not window size
    return shortSide < 480 || longSide < 820 ? 'phone' : 'tablet';
  }
  return 'desktop';
}

function apply() {
  const next = detect();
  const changed = next !== kind;
  kind = next;
  document.body.classList.remove('dev-desktop', 'dev-tablet', 'dev-phone');
  document.body.classList.add('dev-' + kind);
  if (changed) listeners.forEach(fn => fn(kind));
}

export function initDevice() {
  apply();
  addEventListener('resize', apply);
  addEventListener('orientationchange', () => setTimeout(apply, 250));

  // stylus: the first pen event upgrades the drawing experience
  addEventListener('pointerdown', e => {
    if (e.pointerType === 'pen' && !hasPen) {
      hasPen = true;
      document.body.classList.add('has-pen');
    }
  }, { capture: true, passive: true });

  // iOS: kill rubber-band scrolling and double-tap zoom, keep the app app-like
  document.addEventListener('gesturestart', e => e.preventDefault());
  document.addEventListener('touchmove', e => {
    if (e.touches.length > 1 && !e.target.closest('#viewport')) e.preventDefault();
  }, { passive: false });
  let lastTouch = 0;
  document.addEventListener('touchend', e => {
    // never interfere with the napkin or the model — they handle their own input
    if (e.target.closest('#sketch-canvas, #viewport, input, textarea, select, button, label')) { lastTouch = Date.now(); return; }
    const now = Date.now();
    if (now - lastTouch < 320) e.preventDefault();
    lastTouch = now;
  }, { passive: false });

  return kind;
}

// Phone: which single pane is showing
export function showPane(pane) {
  document.body.classList.remove('pane-sketch', 'pane-model', 'pane-metrics');
  document.body.classList.add('pane-' + (pane === 'metrics' ? 'model' : pane));
  document.querySelectorAll('#mobile-tabs button').forEach(b =>
    b.classList.toggle('active', b.dataset.pane === pane));
  if (pane === 'metrics') document.getElementById('metric-rail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  // canvases must re-measure after a display:none → block flip
  setTimeout(() => dispatchEvent(new Event('resize')), 60);
}
