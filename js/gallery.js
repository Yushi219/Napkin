// The napkin rail: starter projects on the left, everything you have built
// after them. Drag it, flick it, hover a napkin to bring it forward, click to
// open it. User projects persist in localStorage so the rail fills up over time.
import { EXAMPLES, thumbSVG } from './examples.js';

const KEY = 'napkin_gallery_v1';
const MAX_USER = 24;

export function userProjects() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}

export function saveProject(p) {
  const list = userProjects().filter(x => x.id !== p.id);
  list.push(p);
  while (list.length > MAX_USER) list.shift();
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota */ }
  return list;
}

export function deleteProject(id) {
  const list = userProjects().filter(x => x.id !== id);
  localStorage.setItem(KEY, JSON.stringify(list));
  return list;
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function tile(item, isUser) {
  const art = isUser && item.thumb
    ? `<img src="${item.thumb}" alt="" />`
    : thumbSVG(item.masses);
  return `<button class="nap-tile${isUser ? ' user' : ''}" data-id="${esc(item.id)}" data-user="${isUser ? 1 : 0}" title="${esc(item.reading || item.name)}">
      <span class="nt-paper">${art}${item.sig ? `<span class="nt-sig">${esc(item.sig)}</span>` : ''}</span>
      <span class="nt-name">${esc(item.name)}</span>
      <span class="nt-type">${esc(item.type || '')}</span>
      ${isUser ? '<span class="nt-del" title="Remove">✕</span>' : ''}
    </button>`;
}


// A hovered napkin grows into a floating card anchored beside the rail. The rail
// itself has to clip (it scrolls), so the enlarged view lives outside it.
function ensurePreview() {
  let el = document.getElementById('gal-preview');
  if (!el) {
    el = document.createElement('div');
    el.id = 'gal-preview';
    document.body.appendChild(el);
  }
  return el;
}

function showPreview(tile, item, isUser) {
  const el = ensurePreview();
  const art = isUser && item.thumb ? '<img src="' + item.thumb + '" alt="" />' : thumbSVG(item.masses);
  el.innerHTML = '<div class="gp-paper">' + art + '</div>' +
    '<div class="gp-name">' + esc(item.name) + '</div>' +
    (item.reading ? '<div class="gp-read">' + esc(item.reading) + '</div>' : '');
  const r = tile.getBoundingClientRect();
  const W = 240;
  const left = r.left - W - 22;
  el.style.left = Math.max(12, left) + 'px';
  el.style.top = Math.max(12, Math.min(innerHeight - 320, r.top + r.height / 2 - 130)) + 'px';
  requestAnimationFrame(() => el.classList.add('on'));
}

function hidePreview() {
  const el = document.getElementById('gal-preview');
  if (el) el.classList.remove('on');
}

export function renderGallery(el, { onOpen, onDelete }) {
  const users = userProjects().slice().reverse();
  el.innerHTML =
    EXAMPLES.map(e => tile(e, false)).join('') +
    (users.length ? '<span class="nap-divider"></span>' : '') +
    users.map(u => tile(u, true)).join('');

  el.querySelectorAll('.nap-tile').forEach(t => {
    const isU = t.dataset.user === '1';
    const data = () => isU ? userProjects().find(x => x.id === t.dataset.id)
      : EXAMPLES.find(x => x.id === t.dataset.id);
    t.addEventListener('pointerenter', () => { const d = data(); if (d) showPreview(t, d, isU); });
    t.addEventListener('pointerleave', hidePreview);
    t.addEventListener('click', e => {
      if (el.dataset.dragged === '1') return;          // a flick is not a click
      if (e.target.classList.contains('nt-del')) {
        e.stopPropagation();
        onDelete(t.dataset.id);
        return;
      }
      const isUser = t.dataset.user === '1';
      const item = isUser ? userProjects().find(x => x.id === t.dataset.id)
        : EXAMPLES.find(x => x.id === t.dataset.id);
      if (item) { hidePreview(); onOpen(item, isUser); }
    });
  });
}

// Drag / flick scrolling with momentum, on whichever axis the rail runs.
// NOTE: no setPointerCapture here — capturing on the container retargets the
// subsequent click to the container, so tile clicks would never fire.
export function initGalleryScroll(el) {
  let down = false, start = 0, startScroll = 0, last = 0, lastT = 0, vel = 0, raf = 0;
  const vertical = () => el.scrollHeight > el.clientHeight + 4;
  const pos = e => (vertical() ? e.clientY : e.clientX);
  const getScroll = () => (vertical() ? el.scrollTop : el.scrollLeft);
  const setScroll = v => { if (vertical()) el.scrollTop = v; else el.scrollLeft = v; };

  const glide = () => {
    if (Math.abs(vel) < 0.4) return;
    setScroll(getScroll() + vel);
    vel *= 0.94;
    raf = requestAnimationFrame(glide);
  };

  el.addEventListener('pointerdown', e => {
    if (e.target.classList.contains('nt-del')) return;
    down = true;
    el.dataset.dragged = '0';
    start = last = pos(e);
    startScroll = getScroll();
    lastT = performance.now();
    cancelAnimationFrame(raf);
    vel = 0;
    el.classList.add('dragging');
  });
  const move = e => {
    if (!down) return;
    const d = pos(e) - start;
    if (Math.abs(d) > 5) el.dataset.dragged = '1';
    setScroll(startScroll - d);
    const now = performance.now();
    const dt = now - lastT;
    if (dt > 0) vel = -(pos(e) - last) / dt * 16;
    last = pos(e); lastT = now;
  };
  const up = () => {
    if (!down) return;
    down = false;
    el.classList.remove('dragging');
    if (el.dataset.dragged === '1') raf = requestAnimationFrame(glide);
    setTimeout(() => { el.dataset.dragged = '0'; }, 60);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);

  el.addEventListener('wheel', e => {
    if (vertical()) return;                                  // native vertical scroll is fine
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    el.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  initHoverScroll(el);
}

// Hover-to-browse: the rail has no scrollbar, so resting the pointer near its
// top or bottom edge glides it that way. Speed rises the closer you get to the
// edge, and it stops the moment the pointer leaves or you grab a napkin.
function initHoverScroll(el) {
  const ZONE = 0.30;          // top/bottom third of the rail is the throttle
  const MAX = 6.5;            // px per frame at the very edge
  let speed = 0, raf = 0, inside = false;

  const tick = () => {
    raf = 0;
    if (!inside || Math.abs(speed) < 0.05) return;
    const vert = el.scrollHeight > el.clientHeight + 4;
    if (vert) el.scrollTop += speed; else el.scrollLeft += speed;
    raf = requestAnimationFrame(tick);
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };

  el.addEventListener('pointerenter', () => { inside = true; });
  el.addEventListener('pointermove', e => {
    if (el.classList.contains('dragging')) { speed = 0; return; }
    const r = el.getBoundingClientRect();
    const vert = el.scrollHeight > el.clientHeight + 4;
    const extent = vert ? r.height : r.width;
    if (extent < 4) { speed = 0; return; }        // laid out at zero size — no NaN
    const t = vert ? (e.clientY - r.top) / extent : (e.clientX - r.left) / extent;
    if (t < ZONE) speed = -MAX * (1 - t / ZONE);
    else if (t > 1 - ZONE) speed = MAX * (1 - (1 - t) / ZONE);
    else speed = 0;
    if (!Number.isFinite(speed)) speed = 0;
    inside = true;
    kick();
  });
  el.addEventListener('pointerleave', () => { inside = false; speed = 0; });
}
