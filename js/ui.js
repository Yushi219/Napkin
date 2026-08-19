// Dashboard rail, source popovers, modals, toast.
import { METRIC_DEFS } from './metrics.js';
import { STYLES } from './render.js';
import { SPONSORS, sponsorStatus, stream } from './versions.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- metric rail ----------
let lastValues = {};
export function renderMetrics(m) {
  const rail = $('metric-rail');
  rail.innerHTML = METRIC_DEFS.map(def => {
    const v = def.val(m);
    const prev = lastValues[def.id];
    const dir = prev !== undefined && prev !== v ? (parseFloat(String(v).replace(/[^\d.-]/g, '')) > parseFloat(String(prev).replace(/[^\d.-]/g, '')) ? '▲' : '▼') : '';
    lastValues[def.id] = v;
    return `<div class="metric s-${def.status(m)}" data-m="${def.id}">
      <div class="m-label">${def.label}</div>
      <div class="m-value">${v}<span class="unit">${def.unit}</span> <span class="m-delta">${dir}</span></div>
    </div>`;
  }).join('');
  lastM = m;   // the sheet on a phone shows clones, so the handler is delegated
}

// One delegated listener, because the Metrics sheet holds cloned cards and a
// clone never carries its listeners with it.
let lastM = null;
document.addEventListener('click', e => {
  const card = e.target.closest('.metric');
  if (!card || !lastM) return;
  showMetricPopover(card, card.dataset.m, lastM);
});

function showMetricPopover(anchor, id, m) {
  const def = METRIC_DEFS.find(d => d.id === id);
  const p = def.pop(m);
  const pop = $('popover');
  pop.innerHTML = `
    <h4>${esc(p.title)}</h4>
    <div class="p-value">${esc(p.value)}</div>
    <div class="p-body">${esc(p.body)}</div>
    <div class="p-formula">${esc(p.formula)}</div>
    <div class="p-src"><b>Source</b> · ${esc(p.source)}</div>`;
  pop.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const w = Math.min(320, innerWidth - 20);
  pop.style.width = w + 'px';
  // a card inside the bottom sheet has no room below it, so the note flips up
  const h = pop.offsetHeight || 200;
  const below = r.bottom + 10;
  pop.style.top = (below + h < innerHeight - 10 ? below : Math.max(10, r.top - h - 10)) + 'px';
  pop.style.left = Math.max(10, Math.min(innerWidth - w - 10, r.left + r.width / 2 - w / 2)) + 'px';
}
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#popover') && !e.target.closest('.metric')) $('popover')?.classList.add('hidden');
});

// (style chips retired — the chat line + auto prompt writer replaced them)

// ---------- render strip ----------
export function addToStrip(url, onPick) {
  const img = document.createElement('img');
  img.src = url;
  img.addEventListener('click', () => {
    onPick(url);
    document.querySelectorAll('#render-strip img').forEach(x => x.classList.remove('active'));
    img.classList.add('active');
  });
  const strip = $('render-strip');
  strip.prepend(img);
  while (strip.children.length > 12) strip.lastChild.remove();
}

// ---------- chat log ----------
export function addChatMsg(who, text, cls = '') {
  const log = $('chat-log');
  log.classList.remove('hidden');
  const d = document.createElement('div');
  d.className = `cmsg ${who} ${cls}`;
  d.textContent = text;
  log.appendChild(d);
  while (log.children.length > 40) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
  return d;
}

// What actually went to the image model, so a bad render can be diagnosed
// instead of guessed at.
export function addChatImages(items) {
  const log = $('chat-log');
  log.classList.remove('hidden');
  const d = document.createElement('div');
  d.className = 'cmsg ai sent-images';
  d.innerHTML = items.map(it =>
    `<figure><img src="${it.url}" alt="${esc(it.label)}" /><figcaption>${esc(it.label)}</figcaption></figure>`).join('');
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

// ---------- parameters panel ----------
// Full parameter desk for the torso-tower archetype (ported from CONCORD).
const TOWER_PARAMS = [
  ['Form', [
    ['floors', 'Floors', 8, 70, 1, ''],
    ['floorHeight', 'Floor height', 2.8, 6, 0.1, 'm'],
    ['baseWidth', 'Base width', 16, 60, 0.5, 'm'],
    ['baseDepth', 'Base depth', 14, 52, 0.5, 'm'],
    ['twist', 'Twist', -90, 90, 1, '\u00b0'],
    ['taper', 'Taper', 0.5, 1.15, 0.01, ''],
    ['orientation', 'Orientation', -90, 90, 1, '\u00b0'],
  ]],
  ['Articulation', [
    ['segCount', 'Segments', 1, 14, 1, ''],
    ['cornerRadius', 'Corner radius', 0, 8, 0.5, 'm'],
    ['finSpacing', 'Fin rhythm', 1.2, 6, 0.1, 'm'],
    ['balconyDepth', 'Balcony depth', 0, 2.5, 0.1, 'm'],
  ]],
  ['Ground and top', [
    ['liftGround', 'Open ground floors', 0, 3, 1, ''],
    ['podiumFloors', 'Podium floors', 0, 6, 1, ''],
    ['podiumExpand', 'Podium spread', 0, 12, 0.5, 'm'],
  ]],
];
const TOWER_CHOICES = [
  ['facade', 'Facade', ['glass', 'terracotta', 'timber']],
  ['structure', 'Structure', ['concrete', 'steel', 'timber-hybrid']],
  ['crown', 'Crown', ['flat', 'crown', 'garden']],
];
const TOWER_FLAGS = [['spine', 'Exposed spine truss'], ['greenRoof', 'Green roof']];

const MASS_FIELDS = [
  ['w', 2, 90, 0.5], ['d', 2, 90, 0.5], ['h', 2, 120, 0.5],
  ['x', -80, 80, 0.5], ['y', 0, 80, 0.5], ['z', -80, 80, 0.5], ['rotY', -90, 90, 1],
];
const FACADES = ['solid', 'glass', 'slats-v', 'slats-h'];

function slider(key, label, lo, hi, step, val, unit, attrs) {
  const shown = Math.round(val * 100) / 100;
  return '<div class="prow"><label title="' + esc(label) + '">' + esc(label) + '</label>' +
    '<input type="range" min="' + lo + '" max="' + hi + '" step="' + step + '" value="' + val + '" ' + attrs + ' />' +
    '<span class="pval" id="pv-' + key + '">' + shown + unit + '</span></div>';
}

export function renderParams(state, hooks) {
  const p = $('params-panel');

  // ---- torso tower: the full desk ----
  if (state.archetype === 'tower') {
    let html = '';
    for (const [group, rows] of TOWER_PARAMS) {
      html += '<div class="pgroup"><div class="pgroup-head"><span class="pg-role">' + group + '</span></div>';
      for (const [k, label, lo, hi, st, unit] of rows) {
        const v = state[k] === undefined ? lo : state[k];
        html += slider(k, label, lo, hi, st, v, unit, 'data-g="' + k + '" data-unit="' + unit + '"');
      }
      html += '</div>';
    }
    html += '<div class="pgroup"><div class="pgroup-head"><span class="pg-role">Material</span></div>';
    for (const [k, label, opts] of TOWER_CHOICES) {
      html += '<div class="pchoice"><label>' + label + '</label><select data-choice="' + k + '">' +
        opts.map(o => '<option ' + (state[k] === o ? 'selected' : '') + '>' + o + '</option>').join('') +
        '</select></div>';
    }
    for (const [k, label] of TOWER_FLAGS) {
      html += '<label class="pflag"><input type="checkbox" data-flag="' + k + '" ' + (state[k] ? 'checked' : '') + ' /> ' + label + '</label>';
    }
    const nGardens = (state.skyGardens || []).length;
    html += '<div class="prow"><label>Sky gardens</label>' +
      '<input type="range" min="0" max="4" step="1" value="' + nGardens + '" data-gardens="1" />' +
      '<span class="pval" id="pv-gardens">' + nGardens + '</span></div></div>';
    p.innerHTML = html;

    p.querySelectorAll('input[type=range][data-g]').forEach(el => {
      const k = el.dataset.g, unit = el.dataset.unit || '';
      el.addEventListener('input', () => {
        $('pv-' + k).textContent = (Math.round(+el.value * 100) / 100) + unit;
        hooks.onGlobalEdit(k, +el.value, false);
      });
      el.addEventListener('change', () => hooks.onGlobalEdit(k, +el.value, true));
    });
    p.querySelectorAll('[data-choice]').forEach(el =>
      el.addEventListener('change', () => hooks.onGlobalEdit(el.dataset.choice, el.value, true)));
    p.querySelectorAll('[data-flag]').forEach(el =>
      el.addEventListener('change', () => hooks.onGlobalEdit(el.dataset.flag, el.checked, true)));
    const g = p.querySelector('[data-gardens]');
    if (g) {
      const spread = n => Array.from({ length: n }, (_, i) =>
        Math.round(state.floors * (0.35 + 0.45 * (n === 1 ? 0.5 : i / (n - 1)))));
      g.addEventListener('input', () => {
        $('pv-gardens').textContent = g.value;
        hooks.onGlobalEdit('skyGardens', spread(+g.value), false);
      });
      g.addEventListener('change', () => hooks.onGlobalEdit('skyGardens', spread(+g.value), true));
    }
    return;
  }

  // ---- AI composition: per-volume controls ----
  if (state.masses && state.masses.length) {
    p.innerHTML = state.masses.map((m, i) =>
      '<div class="pgroup" data-mi="' + i + '">' +
        '<div class="pgroup-head"><span class="pg-role">' + esc(m.role) + '</span>' +
        '<select data-facade="' + i + '">' +
        FACADES.map(f => '<option ' + (f === m.facade ? 'selected' : '') + '>' + f + '</option>').join('') +
        '</select><button class="pg-del" data-del="' + i + '" title="Delete volume">\u2715</button></div>' +
        MASS_FIELDS.map(([k, lo, hi, st]) =>
          '<div class="prow"><label>' + k + '</label>' +
          '<input type="range" min="' + lo + '" max="' + hi + '" step="' + st + '" value="' + m[k] + '" data-mi="' + i + '" data-k="' + k + '" />' +
          '<span class="pval" id="pv-' + i + '-' + k + '">' + (Math.round(m[k] * 10) / 10) + '</span></div>').join('') +
      '</div>').join('') +
      '<button class="add-mass" id="add-mass">\uff0b add a volume</button>';

    p.querySelectorAll('input[type=range][data-k]').forEach(el => {
      el.addEventListener('input', () => {
        const i = +el.dataset.mi, k = el.dataset.k, v = +el.value;
        $('pv-' + i + '-' + k).textContent = Math.round(v * 10) / 10;
        hooks.onMassEdit(i, k, v, false);
      });
      el.addEventListener('change', () => hooks.onMassEdit(+el.dataset.mi, el.dataset.k, +el.value, true));
    });
    p.querySelectorAll('[data-facade]').forEach(el =>
      el.addEventListener('change', () => hooks.onMassFacade(+el.dataset.facade, el.value)));
    p.querySelectorAll('[data-del]').forEach(el =>
      el.addEventListener('click', () => hooks.onMassDelete(+el.dataset.del)));
    const add = p.querySelector('#add-mass');
    if (add) add.addEventListener('click', hooks.onMassAdd);
    p.querySelectorAll('.pgroup').forEach(el => {
      el.addEventListener('pointerenter', () => hooks.onMassHover && hooks.onMassHover(+el.dataset.mi));
      el.addEventListener('pointerleave', () => hooks.onMassHover && hooks.onMassHover(null));
    });
    return;
  }

  // ---- silhouette model ----
  const GLOBALS = [
    ['floors', 'Floors', 2, 70, 1], ['baseWidth', 'Width', 14, 60, 1], ['baseDepth', 'Depth', 12, 55, 1],
    ['twist', 'Twist', -90, 90, 1], ['taper', 'Taper', 0.4, 1.15, 0.01], ['orientation', 'Rotate', -90, 90, 1],
  ];
  p.innerHTML = '<div class="pgroup"><div class="pgroup-head"><span class="pg-role">Massing</span></div>' +
    GLOBALS.map(([k, label, lo, hi, st]) => slider(k, label, lo, hi, st, state[k], '', 'data-g="' + k + '"')).join('') +
    '</div>';
  p.querySelectorAll('input[type=range][data-g]').forEach(el => {
    const k = el.dataset.g;
    el.addEventListener('input', () => { $('pv-' + k).textContent = el.value; hooks.onGlobalEdit(k, +el.value, false); });
    el.addEventListener('change', () => hooks.onGlobalEdit(k, +el.value, true));
  });
}

export function highlightParamGroup(i) {
  document.querySelectorAll('.pgroup').forEach(el =>
    el.classList.toggle('selected', +el.dataset.mi === i));
}

// ---------- toast / modal ----------
let toastTimer;
export function toast(msg, ms = 3200) {
  const t = $('toast');
  t.innerHTML = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function openModal(html) {
  $('modal-card').innerHTML = `<button class="modal-close" id="mx">✕</button>` + html;
  $('modal-root').classList.remove('hidden');
  $('mx').onclick = closeModal;
  $('modal-backdrop').onclick = closeModal;
}
export function closeModal() { $('modal-root').classList.add('hidden'); }

// ---------- settings ----------
export function settingsModal(onSave) {
  const g = k => localStorage.getItem(k) || '';
  const sponsors = SPONSORS.map(s => `
    <div class="sponsor-row">
      <div><div class="s-name">${s.name}</div><div class="s-role">${s.role}</div></div>
      <span class="s-status ${g(s.field) ? 'on' : ''}">${esc(sponsorStatus(s))}</span>
    </div>
    <div class="settings-row" style="margin-top:6px"><input id="set-${s.id}" placeholder="${s.placeholder}" value="${esc(g(s.field))}" /></div>`).join('');
  openModal(`
    <div class="modal-kicker">Settings</div>
    <div class="modal-title" style="font-size:20px">Engines & platforms</div>
    <div class="settings-row"><label>Anthropic API key — chat modelling + photo vision</label>
      <input id="set-claude" type="password" placeholder="sk-ant-…" value="${esc(g('napkin_claude_key') || (window.NAPKIN_CONFIG?.anthropicKey ?? ''))}" /></div>
    <div class="settings-row"><label>Gemini API key — Nano Banana Pro renders</label>
      <input id="set-gemini" type="password" placeholder="AIza…" value="${esc(g('napkin_gemini_key') || (window.NAPKIN_CONFIG?.geminiKey ?? ''))}" /></div>
    <div style="margin:16px 0 6px; font-size:11px; letter-spacing:1.5px; text-transform:uppercase; color:var(--muted)">Sponsor platforms</div>
    ${sponsors}
    <button class="build-btn" id="set-save" style="width:100%; margin-top:14px">Save</button>
    <div class="settings-note">Keys live in this browser's localStorage and are sent only to their own APIs. Without keys, everything still runs on local engines — chat, vision and render fall back gracefully. Sponsor fields store credentials for the adapter stubs; wiring them is a transport swap, the data shapes are already theirs.</div>`);
  document.getElementById('set-save').onclick = () => {
    localStorage.setItem('napkin_claude_key', document.getElementById('set-claude').value.trim());
    localStorage.setItem('napkin_gemini_key', document.getElementById('set-gemini').value.trim());
    for (const s of SPONSORS) localStorage.setItem(s.field, document.getElementById(`set-${s.id}`).value.trim());
    closeModal();
    onSave?.();
  };
}

// ---------- versions ----------
export function versionsModal(onRestore, onExport) {
  const items = [...stream.commits].reverse().map(c => `
    <div class="version-card" data-v="${c.id}">
      <img src="${c.thumb}" alt="" />
      <div><div class="v-name">${esc(c.label)} <span style="color:var(--faint); font-weight:400">· ${c.at}</span></div>
        <div class="v-meta">${esc(c.brief)}</div></div>
    </div>`).join('');
  openModal(`
    <div class="modal-kicker">Version stream</div>
    <div class="modal-title" style="font-size:20px">The napkin's evolution</div>
    <div class="modal-sub">Every build is a commit: sketch, parameters, metrics. Click one to travel back. Speckle-ready — export and the handoff carries the whole story.</div>
    ${items || '<div style="color:var(--faint); text-align:center; padding:20px">No commits yet — build something.</div>'}
    <button class="pill-btn" id="v-export" style="margin-top:10px">⇩ Export stream JSON</button>`);
  document.querySelectorAll('.version-card').forEach(el =>
    el.addEventListener('click', () => { closeModal(); onRestore(el.dataset.v); }));
  document.getElementById('v-export').onclick = onExport;
}

export function setModelBadge(text) { $('model-badge').innerHTML = text; }
export function veil(show, label = 'rendering…') {
  $('render-veil').classList.toggle('hidden', !show);
  $('veil-label').textContent = label;
}
