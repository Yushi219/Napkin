// Draggable boundaries. Every seam in the layout is a handle: napkin | model,
// model | parameters, stage | chat, and on the front page the napkin | rail.
// Sizes persist per browser, and a double-click on any seam restores it.

const KEY = 'napkin_splits_v1';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
function save(patch) {
  const all = Object.assign(load(), patch);
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* quota */ }
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const settle = () => setTimeout(() => dispatchEvent(new Event('resize')), 30);

// One drag implementation for all four seams.
function drag(handle, { onMove, onReset, axis }) {
  let active = false;
  handle.addEventListener('pointerdown', e => {
    active = true;
    try { handle.setPointerCapture(e.pointerId); } catch { /* capture is a nicety, not a requirement */ }
    handle.classList.add('dragging');
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  handle.addEventListener('pointermove', e => { if (active) onMove(e); });
  const end = () => {
    if (!active) return;
    active = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    settle();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => { onReset(); settle(); });
}

export function initSplitters() {
  const $ = id => document.getElementById(id);
  const stage = $('stage');
  const saved = load();

  // ---- napkin | model (workspace) and napkin | rail (landing) ----
  const applyMain = px => {
    if (!document.body.classList.contains('workspace')) return;
    stage.style.gridTemplateColumns = `${px}px 1fr 0fr`;
  };
  const applyRail = px => {
    if (!document.body.classList.contains('landing')) return;
    stage.style.gridTemplateColumns = `1fr 0fr ${px}px`;
  };
  // the grid template belongs to whichever mode is on screen
  const refreshTemplate = () => {
    const s = load();
    if (document.body.classList.contains('workspace')) {
      if (s.main) applyMain(s.main); else stage.style.gridTemplateColumns = '';
    } else {
      if (s.rail) applyRail(s.rail); else stage.style.gridTemplateColumns = '';
    }
  };

  const hMain = $('split-main');
  if (hMain) {
    drag(hMain, {
      axis: 'x',
      onMove: e => {
        const r = stage.getBoundingClientRect();
        const px = clamp(e.clientX - r.left, 280, r.width - 420);
        applyMain(px);
        save({ main: px });
      },
      onReset: () => { save({ main: 0 }); stage.style.gridTemplateColumns = ''; },
    });
  }

  const hRail = $('split-rail');
  if (hRail) {
    drag(hRail, {
      axis: 'x',
      onMove: e => {
        const r = stage.getBoundingClientRect();
        const px = clamp(r.right - e.clientX, 120, 420);
        applyRail(px);
        save({ rail: px });
      },
      onReset: () => { save({ rail: 0 }); stage.style.gridTemplateColumns = ''; },
    });
  }

  // ---- model | parameters ----
  const hParams = $('split-params');
  const panel = $('params-panel');
  if (hParams && panel) {
    const setParamsWidth = px => {
      panel.style.width = px ? px + 'px' : '';
      hParams.style.right = (px || 268) + 'px';
    };
    if (saved.params) setParamsWidth(saved.params);
    drag(hParams, {
      axis: 'x',
      onMove: e => {
        const r = panel.getBoundingClientRect();
        const px = clamp(r.right - e.clientX, 190, 460);
        setParamsWidth(px);
        save({ params: px });
      },
      onReset: () => { setParamsWidth(0); save({ params: 0 }); },
    });
  }

  // ---- stage | chat ----
  const hChat = $('split-chat');
  const chat = $('chatbar');
  if (hChat && chat) {
    if (saved.chat) chat.style.height = saved.chat + 'px';
    drag(hChat, {
      axis: 'y',
      onMove: e => {
        const px = clamp(innerHeight - e.clientY, 52, Math.min(420, innerHeight * 0.6));
        chat.style.height = px + 'px';
        save({ chat: px });
      },
      onReset: () => { chat.style.height = ''; save({ chat: 0 }); },
    });
  }

  // the two column seams share one grid, so re-apply on every mode change
  new MutationObserver(refreshTemplate)
    .observe(document.body, { attributes: true, attributeFilter: ['class'] });
  refreshTemplate();
}
