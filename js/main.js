// Orchestration: landing → workspace, sketch → parameters → model → metrics → render.
import * as sketch from './sketch.js';
import { interpretViews, interpretMassing, visionMasses, visionAnnotatedEdit, visionRefine, imageInkCanvas, cropReferenceImage } from './interpret.js';
import * as model from './model.js';
import { compute, TYPES } from './metrics.js';
import { renderImage, hasGemini, conceptModelImage, writeRenderPrompt } from './render.js';
import * as hands from './hands.js';
import { SITES, getSite, seasonDate, daylightWindow } from './solar.js';
import { initDevice, deviceKind, isTouch, showPane, onDeviceChange } from './device.js';
import { EXAMPLES, strokesFor } from './examples.js';
import { renderGallery, initGalleryScroll, saveProject, deleteProject } from './gallery.js';
import { initSplitters } from './splitters.js';
import { interpretCommand, hasAI } from './chat.js';
import { gptBuildMasses, hasGPT } from './openai.js';
import { buildWithProtocol, fastBuild, quickCorrect } from './builder.js';
import { hasClaude } from './claudecore.js';
import * as versions from './versions.js';
import * as ui from './ui.js';

const $ = id => document.getElementById(id);

// the two marks the build button swaps between, drawn like every other icon
const ICON = {
  arrow: '<svg class="ico" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h14.4"/><path d="M13.6 7.2 18.4 12l-4.8 4.8"/></svg>',
  redo: '<svg class="ico" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20.4 12a8.4 8.4 0 1 1-2.5-6"/><path d="M18.6 3.2v3.6H15"/></svg>',
};

let built = false;
let styleId = 'photo';
let refDataURL = null;
let autoRenderTimer = 0;
let customTypeText = '';

// ---------------- view modes / render layer / compare ----------------

let viewMode = 'white';
let lastRenderURL = null;
let compareOn = false;

function setViewMode(mode) {
  viewMode = mode;
  document.querySelectorAll('.vmode').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const layer = $('render-layer');
  $('render-strip').classList.toggle('hidden', mode !== 'render' || !$('render-strip').children.length);
  if (mode === 'render') {
    if (!lastRenderURL) { ui.addChatMsg('ai', 'No render yet — type what you want and press Render ✦.'); }
    layer.classList.toggle('hidden', !lastRenderURL);
  } else {
    layer.classList.add('hidden');
    setCompare(false);
    model.setModelMode(mode);
    model.rebuild();
    if (selected.size) model.setSelection([...selected]);
  }
}

let renderCamera = null;

function showRender(url, { local = false } = {}) {
  lastRenderURL = url;
  lastRenderIsLocal = local;
  $('render-img').src = url;
  $('btn-compare').classList.remove('hidden');
  // the render belongs to the view it was made from — go back to it
  if (renderCamera) model.restoreCameraPose(renderCamera);
  setViewMode('render');
}
let lastRenderIsLocal = false;

function setCompare(on) {
  compareOn = on && !!lastRenderURL;
  $('render-layer').classList.toggle('compare', compareOn);
  $('compare-divider').classList.toggle('hidden', !compareOn);
  $('btn-compare').classList.toggle('active', compareOn);
  if (compareOn) $('render-layer').classList.remove('hidden');
}

function initCompareDrag() {
  const div = $('compare-divider'), layer = $('render-layer');
  let dragging = false;
  const setSplit = e => {
    const r = layer.getBoundingClientRect();
    const pct = Math.max(2, Math.min(98, ((e.clientX - r.left) / r.width) * 100));
    layer.style.setProperty('--split', pct + '%');
    div.style.setProperty('--split', pct + '%');
  };
  div.addEventListener('pointerdown', e => { dragging = true; div.setPointerCapture(e.pointerId); e.stopPropagation(); });
  div.addEventListener('pointermove', e => { if (dragging) setSplit(e); });
  div.addEventListener('pointerup', () => { dragging = false; });
  layer.style.setProperty('--split', '50%');
  div.style.setProperty('--split', '50%');
}

// ---------------- designer signature ----------------

function todayLabel() {
  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

let authorName = '', authorDate = '';

function applySignature(name = authorName, date = authorDate) {
  authorName = (name || '').trim();
  authorDate = (date || '').trim();
  localStorage.setItem('napkin_author', authorName);
  localStorage.setItem('napkin_author_date', authorDate);

  const hero = $('hero-sig');
  hero.innerHTML = authorName
    ? `${esc(authorName)}${authorDate ? `<span class="sig-date">${esc(authorDate)}</span>` : ''}`
    : '';
  hero.classList.toggle('on', !!authorName);

  $('napkin-sig').querySelector('.ns-name').textContent = authorName;
  $('napkin-sig').querySelector('.ns-date').textContent = authorDate;
  $('dash-signature').textContent = authorName;
}
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------- gallery ----------------

function refreshGallery() {
  renderGallery($('gallery'), {
    onOpen: openProject,
    onDelete: id => { deleteProject(id); refreshGallery(); },
  });
}

function openProject(item, isUser) {
  leaveImported();
  clearSelection();
  // a reopened project keeps its identity, so further work updates it in place
  currentProjectId = isUser ? item.id : null;
  // the sketch is regenerated from the massing so napkin and model always agree
  sketch.restoreStrokes({ front: item.strokes || strokesFor(item.masses), side: [], plan: [] });
  sketch.restorePhoto(item.photo || null);
  // the concept pass and the last render come back to their panes
  conceptURL = item.concept || null;
  $('concept-img').src = conceptURL || '';
  $('concept-pane').classList.toggle('hidden', !conceptURL);
  lastRenderURL = item.render || null;
  if (lastRenderURL) $('render-img').src = lastRenderURL;
  if (item.customType) { customTypeText = item.customType; }
  const patch = item.archetype === 'tower'
    ? Object.assign({}, structuredClone(item.params), {
        archetype: 'tower', masses: null, reading: item.reading || item.name,
        profile: null, profileSide: null, footprint: null, segments: [], mode: 'massing',
      })
    : {
        archetype: null, masses: structuredClone(item.masses), reading: item.reading || item.name,
        profile: null, profileSide: null, footprint: null, segments: [], mode: 'massing',
      };
  if (item.type && TYPES[item.type]) { patch.type = item.type; patch.floorHeight = TYPES[item.type].fh; }
  model.applyPatch(patch);
  if (item.type) {
    $('type-select').value = item.type;
    $('kind-select').value = item.type;
  }
  enterWorkspace();
  refresh();
  if (item.camera) {
    model.setCameraAngle(item.camera.yawDeg, item.camera.pitchDeg, item.camera.fovDeg);
    model.frameBuilding(1.14);
    lastCamera = item.camera;
  }
  syncParams();
  lastSketchShot = null;                    // it was never a photographed napkin
  if (deviceKind() !== 'phone') {
    $('params-panel').classList.remove('hidden');
    $('btn-params').classList.add('active');
  }
  commitVersion(`opened ${item.name}`);
  ui.addChatMsg('ai', `${item.name} — ${item.reading || 'opened from the rail'}. Pull it apart: click a volume, or open ⚌ Params.`);
  if (deviceKind() === 'phone') showPane('model');
}

// A project is the whole desk, not just the boxes: the photo on the napkin,
// the concept pass, the last render, the words. Reopening it must feel like
// nothing was ever put away.
let currentProjectId = null;

// localStorage holds ~5 MB for the whole app, so every picture is shrunk
// before it is stored — a gallery record is a keepsake, not an archive.
function shrinkDataURL(url, maxEdge = 640, q = 0.72) {
  return new Promise(resolve => {
    if (!url) return resolve(null);
    const img = new Image();
    img.onload = () => {
      const f = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(img.width * f));
      cv.height = Math.max(1, Math.round(img.height * f));
      const c = cv.getContext('2d');
      c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
      c.drawImage(img, 0, 0, cv.width, cv.height);
      resolve(cv.toDataURL('image/jpeg', q));
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function saveToGallery() {
  if (!model.state.masses?.length) return;
  const name = (model.state.reading || 'Untitled')
    .split(/[,—.]/)[0].trim().replace(/^a /i, '').slice(0, 26) || 'Untitled';
  currentProjectId = currentProjectId || 'u' + Date.now();
  const [photo, concept, render] = await Promise.all([
    shrinkDataURL(sketch.photoDataURL(900)),
    shrinkDataURL(conceptURL),
    shrinkDataURL(lastRenderURL, 900, 0.78),
  ]);
  saveProject({
    id: currentProjectId,
    name: name.charAt(0).toUpperCase() + name.slice(1),
    type: model.state.type,
    reading: model.state.reading,
    masses: structuredClone(model.state.masses),
    strokes: sketch.serializeStrokes().front,
    thumb: sketch.thumbnail(),
    sig: authorName,
    camera: lastCamera,
    photo, concept, render,
    customType: customTypeText || null,
  });
  refreshGallery();
}

// ---------------- refresh pipeline ----------------

function metricsBrief(m) {
  return `${model.state.floors} fl · ${Math.round(m.heightFt)} ft · $${Math.round(m.cost)}M · ${Math.round(m.carbon)} kgCO₂/m² · LEED ${m.leed} ${m.tier}`;
}

let importedBadge = null;
function leaveImported() { model.clearImported(); importedBadge = null; }

function refresh({ reinterpret = false } = {}) {
  if (reinterpret && sketch.hasInk()) {
    const patch = interpretViews(sketch, model.state);
    if (patch) model.applyPatch(patch);
    else if (built) ui.toast('I could not read a building in that ink yet — keep drawing.');
  }
  if (!model.hasImported()) model.rebuild();   // an imported mesh stays on stage until a parametric edit
  const m = compute(customTypeText);
  ui.renderMetrics(m);
  ui.setModelBadge(model.hasImported() && importedBadge ? importedBadge : '');
  $('wire-pane').classList.toggle('hidden', !(built && (model.state.masses?.length || model.state.profile || model.state.mode === 'plan')));
  window.__liveSync?.();
  return m;
}

function commitVersion(label) {
  const m = compute(customTypeText);
  versions.commit({
    label,
    thumb: sketch.thumbnail(),
    params: model.snapshotState(),
    strokes: sketch.serializeStrokes(),
    brief: metricsBrief(m),
  });
  $('version-count').textContent = versions.stream.commits.length;
}

// ---------------- build / landing transition ----------------

function enterWorkspace(msg) {
  if (built) return false;
  built = true;
  document.body.classList.remove('landing');
  document.body.classList.add('workspace');
  $('btn-build').innerHTML = 'Update' + ICON.redo;
  setTimeout(() => refresh(), 500);   // rebuild after panes unfold so canvases have size
  setTimeout(() => refresh(), 1100);
  if (msg) ui.toast(msg);
  return true;
}

// The vision one-shots keep a cfg parameter for shape; the OpenAI key is
// read inside the transport, so there is nothing to pass any more.
function anthropicCfg() { return {}; }

// fetch reports a bad header as a parse failure with no hint of which one.
// The only header we fill in is the key, so say that plainly.
function readFailure(e) {
  const raw = String(e?.message || e);
  if (/headers|ISO-8859-1|Failed to read the/i.test(raw)) {
    return 'the API key has characters the browser cannot put in a request header — usually an invisible one picked up while copying. Open ⚙ and paste it again';
  }
  if (/401|authentication|invalid x-api-key/i.test(raw)) return 'the API key was rejected (401)';
  if (/429|quota|rate/i.test(raw)) return 'the account is out of quota (429)';
  if (/Failed to fetch|NetworkError/i.test(raw)) return 'the request could not leave the browser — check the connection';
  return raw.slice(0, 200);   // the API's own sentence is the useful part
}

async function build() {
  if (!sketch.hasInk()) { ui.toast('Draw something first — even a rectangle is a building.'); return; }
  enterWorkspace();
  // The passes take real seconds. Without something turning in the middle of
  // the model there is no way to tell working from finished.
  ui.veil(true, 'reading your sketch…');
  try {
    await buildPasses();
  } finally {
    ui.veil(false);
  }
}

// The one number the drawing states beyond doubt: how wide the silhouette is
// against how tall. Measured from the actual ink, handed to the builder as
// ground truth to check itself against.
function measureInkAspect() {
  try {
    const cv = sketch.inkCanvas(200);
    const d = cv.getContext('2d').getImageData(0, 0, 200, 200).data;
    let minx = 200, maxx = -1, miny = 200, maxy = -1;
    for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) {
      if (d[(y * 200 + x) * 4] < 120) {
        if (x < minx) minx = x; if (x > maxx) maxx = x;
        if (y < miny) miny = y; if (y > maxy) maxy = y;
      }
    }
    if (maxx < 0 || maxy - miny < 8) return null;
    return (maxx - minx + 1) / (maxy - miny + 1);
  } catch { return null; }
}

async function buildPasses() {

  let patch = null, reading = '';
  if (hasAI() || hasGPT()) {
    $('btn-build').disabled = true;
    lastSketchShot = sketch.sketchDataURL();
    lastReferenceShot = await cropReferenceImage(lastSketchShot);

    // Sixty seconds is the longest a person waits in front of this screen, so
    // fast is the default and the survey-and-audit protocol is a mode.
    const deepMode = (localStorage.getItem('napkin_build_mode') || 'fast') === 'deep';

    // The concept pass paints in parallel — it is display (and the deep
    // mode's reading aid), never something the fast lane waits behind.
    let readShot = lastSketchShot;
    let conceptPromise = null;
    if (hasGemini()) {
      const cbusy = ui.addChatMsg('ai', 'Concept pass — redrawing your sketch as a clean model…', 'busy');
      const m0 = compute(customTypeText);
      conceptPromise = conceptModelImage({ sketchDataURL: lastSketchShot, typeLabel: m0.type.label })
        .then(concept => {
          if (concept) {
            conceptURL = concept;
            $('concept-img').src = concept;
            $('concept-pane').classList.remove('hidden');
            cbusy.classList.remove('busy');
            cbusy.textContent = 'Concept pass done.';
          } else cbusy.remove();
          return concept;
        })
        .catch(e => {
          cbusy.className = 'cmsg ai err';
          cbusy.textContent = `Concept pass skipped (${String(e.message).slice(0, 70)}).`;
          return null;
        });
      if (deepMode) readShot = (await conceptPromise) || lastSketchShot;
    }

    const busy = ui.addChatMsg('ai', deepMode
      ? 'Deep protocol — surveying, building level by level, auditing until convergence…'
      : 'Reading the drawing and building…', 'busy');
    ui.veil(true, deepMode ? 'deep protocol — survey, build, audit…' : 'reading & building…');
    let agentRan = false;
    try {
      // The builder loop drives the live scene the way an agent drives a CAD
      // program: draft, render, compare with the sketch, revise. Every error
      // it makes is one it gets to see. The engine is a choice — Claude or
      // ChatGPT, same tools, same scene — and each falls back to the other,
      // then to the one-shot reading.
      const io = {
        hints: { inkAspect: measureInkAspect() },
        apply: async (masses, camera) => {
          leaveImported();
          model.applyPatch({ archetype: null, masses, profile: null, profileSide: null, footprint: null, segments: [], mode: 'massing' });
          refresh();
          if (camera) model.setCameraAngle(camera.yawDeg, camera.pitchDeg, camera.fovDeg);
          model.frameBuilding(1.14);
          await new Promise(r => setTimeout(r, 120));   // one painted frame
        },
        snapshot: () => model.modelSnapshot(1100, { isolate: true }),
        step: label => { ui.veil(true, label); busy.textContent = label; },
        audit: a => {
          const n = (a.elements || a.features || []).length;
          const hyp = (a.hypotheses || []).length;
          ui.addChatMsg('ai', `Survey locked — ${a.visibleStoreys} levels · ${n} features` + (hyp ? ` · ${hyp} recorded hypotheses` : '') + ` · ${a.projection}.`, 'prompt');
        },
      };
      // the loop compares against the napkin itself; the concept render, when
      // pass 1 produced one, goes along only as a reading aid
      io.aidURL = readShot !== lastSketchShot ? readShot : null;
      let v = null, engineUsed = '';
      if (hasClaude()) {
        try {
          if (deepMode) {
            v = await buildWithProtocol(lastSketchShot, io); engineUsed = 'the Claude protocol';
          } else {
            v = await fastBuild(lastSketchShot, io); engineUsed = 'the fast lane';
            if (v) scheduleSelfCheck(v.targetURL || lastSketchShot);
          }
          agentRan = !!v;
        } catch (agentErr) { console.warn('Claude build failed', agentErr); }
      }
      if (!v && hasGPT()) {
        try {
          v = await gptBuildMasses(lastReferenceShot || lastSketchShot, io); engineUsed = 'ChatGPT'; agentRan = true;
        } catch (agentErr) { console.warn('ChatGPT builder failed', agentErr); }
      }
      if (!v && hasAI()) {
        ui.veil(true, 'pass 2 — reading volumes and storeys…');
        v = await visionMasses(readShot, anthropicCfg());
      }
      if (!v) throw new Error('no builder engine could read the sketch — check the keys in ⚙');
      if (engineUsed) busy.textContent = 'Built by the ' + engineUsed + ' builder loop.';
      busy.remove();
      patch = {
        archetype: null, masses: v.masses, reading: v.reading,
        profile: null, profileSide: null, footprint: null, segments: [], mode: 'massing',
      };
      if (v.type && TYPES[v.type]) {
        patch.type = v.type; patch.floorHeight = TYPES[v.type].fh;
        $('type-select').value = v.type;
      }
      reading = v.reading;
      agentRanOnLastBuild = agentRan;
      if (v.camera) pendingCamera = v.camera;
    } catch (e) {
      console.warn('vision read failed → local reader', e);
      const msg = hasAI()
        ? `ChatGPT could not read the sketch — ${readFailure(e)}. Falling back to the local silhouette reader.`
        : 'This device has no OpenAI key, so the sketch was read by the local silhouette engine. Add one in ⚙ — it stays in this browser only.';
      ui.addChatMsg('ai', msg, 'err');
    }
    $('btn-build').disabled = false;
  }
  if (!patch) {
    patch = interpretViews(sketch, model.state);
    if (patch) { patch.masses = null; patch.reading = null; }
  }
  if (!patch) { ui.toast('I could not find a building in the ink. Bolder lines help.'); return; }

  leaveImported();
  clearSelection();
  model.applyPatch(patch);
  refresh();
  if (pendingCamera) {
    model.setCameraAngle(pendingCamera.yawDeg, pendingCamera.pitchDeg, pendingCamera.fovDeg);
    model.frameBuilding(1.14);
    lastCamera = pendingCamera; pendingCamera = null;
  }
  syncParams();
  commitVersion(versions.stream.commits.length ? `sketch v${versions.stream.commits.length + 1}` : 'first sketch');
  if (deviceKind() === 'phone') showPane('model');
  saveToGallery();
  if (reading) ui.addChatMsg('ai', `“${reading}”`);
  // The builder loop already looked at itself; only the one-shot fallback
  // still benefits from an automatic render-compare-correct pass.
  if (patch.masses && hasAI() && lastSketchShot && !agentRanOnLastBuild) await runRefine(true);
}

let agentRanOnLastBuild = false;
let pendingCamera = null;
let lastCamera = null;
let lastSketchShot = null;
let lastReferenceShot = null;
let conceptURL = null;

// ---------------- the background self-check ----------------
// Fires after the fast lane has already put a model on screen. If the user
// starts editing meanwhile, their edits win and the correction is dropped.
function scheduleSelfCheck(targetURL) {
  const stamp = JSON.stringify(model.state.masses);
  setTimeout(async () => {
    const note = ui.addChatMsg('ai', 'Self-check — comparing the model against your sketch in the background…', 'busy');
    try {
      const r = await quickCorrect(targetURL, model.state.masses, lastCamera, {
        snapshot: () => model.modelSnapshot(1000, { isolate: true }),
      });
      if (!r) { note.classList.remove('busy'); note.textContent = '✓ Self-check passed — the model matches the sketch.'; return; }
      if (JSON.stringify(model.state.masses) !== stamp) {
        note.classList.remove('busy');
        note.textContent = 'Self-check found corrections, but you were already editing — kept your version.';
        return;
      }
      model.applyPatch({ masses: r.masses });
      if (r.camera) { lastCamera = r.camera; model.setCameraAngle(r.camera.yawDeg, r.camera.pitchDeg, r.camera.fovDeg); model.frameBuilding(1.14); }
      refresh(); syncParams(); commitVersion('⟲ self-check');
      note.classList.remove('busy');
      note.textContent = '⟲ Self-checked against the sketch and corrected.';
    } catch (e) { note.remove(); }
  }, 400);
}

// ---------------- analysis-by-synthesis refinement ----------------

async function runRefine(auto = false) {
  if (!model.state.masses?.length) { if (!auto) ui.addChatMsg('ai', 'Refine works on the AI composition — press Update ↻ first.', 'err'); return; }
  if (!hasAI() || !lastSketchShot) { if (!auto) ui.addChatMsg('ai', 'Refine needs the sketch and an OpenAI key.', 'err'); return; }
  const busy = ui.addChatMsg('ai', auto ? 'Self-check: comparing the model against your sketch…' : 'Comparing the model against your sketch…', 'busy');
  if ($('btn-refine')) $('btn-refine').disabled = true;
  ui.veil(true, 'checking the model against your sketch…');
  try {
    if (lastCamera) model.setCameraAngle(lastCamera.yawDeg, lastCamera.pitchDeg, lastCamera.fovDeg);
    model.frameBuilding(1.14);
    const shot = model.modelSnapshot(1280, { isolate: true });
    const r = await visionRefine(lastReferenceShot || lastSketchShot, shot, model.state.masses, lastCamera, anthropicCfg());
    model.applyPatch({ masses: r.masses });
    if (r.camera) { lastCamera = r.camera; }
    refresh();
    if (lastCamera) model.setCameraAngle(lastCamera.yawDeg, lastCamera.pitchDeg, lastCamera.fovDeg);
    model.frameBuilding(1.14);
    syncParams();
    commitVersion('⟲ refine');
    busy.classList.remove('busy');
    busy.textContent = `⟲ ${r.changes || 'Self-corrected against the sketch.'}`;
  } catch (e) {
    console.error(e);
    busy.className = 'cmsg ai err';
    busy.textContent = `Refine failed: ${String(e.message).slice(0, 80)}`;
  } finally {
    ui.veil(false);
    if ($('btn-refine')) $('btn-refine').disabled = false;
  }
}

// ---------------- selection (click a volume, then talk about it) ----------------

let selected = new Set();

function clearSelection() {
  selected.clear();
  model.setSelection([]);
  $('sel-bar').classList.add('hidden');
}

function onPickMass(idx) {
  if (idx === null || idx === undefined) { clearSelection(); return; }
  if (selected.has(idx)) selected.delete(idx);
  else selected.add(idx);
  model.setSelection([...selected]);
  const roles = [...selected].map(i => model.state.masses?.[i]?.role || `#${i}`);
  $('sel-chips').innerHTML = roles.map(r => `<span class="sel-chip">${r}</span>`).join('');
  $('sel-bar').classList.toggle('hidden', !roles.length);
  if (roles.length) {
    $('chat-input').placeholder = `Talking about ${roles.join(' + ')} — “make it longer”, “push it back”, “glass facade”…`;
    $('chat-input').focus();
  }
}

// ---------------- red-pen annotation (3D mark-up -> AI edit) ----------------

let annoStrokes = [];

function setupAnnotation() {
  const cv = $('anno-canvas');
  const ctx2 = cv.getContext('2d');
  const sizeIt = () => { cv.width = cv.clientWidth * devicePixelRatio; cv.height = cv.clientHeight * devicePixelRatio; drawAnno(); };
  new ResizeObserver(sizeIt).observe(cv);

  function drawAnno() {
    ctx2.clearRect(0, 0, cv.width, cv.height);
    ctx2.strokeStyle = '#c0392b';
    ctx2.lineWidth = 3 * devicePixelRatio;
    ctx2.lineCap = ctx2.lineJoin = 'round';
    for (const s of annoStrokes) {
      ctx2.beginPath();
      s.forEach((p, i) => i ? ctx2.lineTo(p[0] * cv.width, p[1] * cv.height) : ctx2.moveTo(p[0] * cv.width, p[1] * cv.height));
      ctx2.stroke();
    }
  }

  let cur = null;
  cv.addEventListener('pointerdown', e => {
    const r = cv.getBoundingClientRect();
    cur = [[(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]];
    annoStrokes.push(cur);
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', e => {
    if (!cur) return;
    const r = cv.getBoundingClientRect();
    cur.push([(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]);
    drawAnno();
  });
  cv.addEventListener('pointerup', () => {
    cur = null;
    if (annoStrokes.length) {
      $('chat-input').placeholder = 'Describe what the red mark should become — then Say it';
      $('chat-input').focus();
    }
  });

  window._drawAnno = drawAnno;
}

function annotationActive() { return document.body.classList.contains('annotating') && annoStrokes.length; }

function clearAnnotation() {
  annoStrokes = [];
  window._drawAnno?.();
  document.body.classList.remove('annotating');
  $('btn-anno').classList.remove('active');
}

function annotatedSnapshot() {
  const snap = model.modelSnapshot();
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const c = cv.getContext('2d');
      c.drawImage(img, 0, 0);
      c.strokeStyle = '#c0392b';
      c.lineWidth = Math.max(3, cv.width / 240);
      c.lineCap = c.lineJoin = 'round';
      for (const s of annoStrokes) {
        c.beginPath();
        s.forEach((p, i) => i ? c.lineTo(p[0] * cv.width, p[1] * cv.height) : c.moveTo(p[0] * cv.width, p[1] * cv.height));
        c.stroke();
      }
      res(cv.toDataURL('image/png'));
    };
    img.src = snap;
  });
}

// ---------------- reverse pipelines ----------------

async function importModelFile(file) {
  enterWorkspace();
  try {
    const dims = await model.importMesh(file);
    // derive the parametric twin from the mesh's own silhouette — same brain as the napkin
    const sil = model.meshSilhouette();
    const patch = sil ? interpretMassing(sil, model.state) : null;
    if (patch) {
      patch.baseWidth = Math.max(14, Math.min(60, Math.round(dims.width)));
      patch.baseDepth = Math.max(12, Math.min(55, Math.round(dims.depth || dims.width * 0.8)));
      model.applyPatch(patch);
    }
    // metrics from the twin, but keep showing the imported mesh
    const m = compute(customTypeText);
    ui.renderMetrics(m);
    importedBadge = `imported: ${file.name}<br/>parametric twin: ${model.state.floors} floors · ${Math.round(m.stats.height)} m — chat edits switch to the twin`;
    ui.setModelBadge(importedBadge);
    commitVersion(`import: ${file.name.slice(0, 22)}`);
    ui.toast(patch
      ? `Mesh on stage. I read ${patch.floors} floors off its silhouette — render it, or say “twist it” to continue on the twin.`
      : 'Mesh on stage — render away. I could not derive a twin from its silhouette.');
  } catch (e) {
    console.error(e);
    ui.toast('Could not read that file — .obj or .glb please.');
  }
}

async function decomposeRender(dataURL) {
  enterWorkspace();
  showRender(dataURL);
  ui.veil(true, 'decomposing the image into massing…');
  try {
    let patch = null, notes = '';
    if (hasAI()) {
      try {
        const v = await visionMasses(dataURL, anthropicCfg());
        patch = {
          masses: v.masses, reading: v.reading,
          profile: null, profileSide: null, footprint: null, segments: [], mode: 'massing',
        };
        if (v.type && TYPES[v.type]) { patch.type = v.type; $('type-select').value = v.type; }
        notes = v.reading || '';
      } catch (e) { console.warn('vision decompose failed → silhouette fallback', e); }
    }
    if (!patch) {
      patch = interpretMassing(await imageInkCanvas(dataURL), model.state);
      if (patch) { patch.masses = null; patch.reading = null; }
      notes = 'silhouette fallback — add an OpenAI key for intent-level decomposition';
    }
    if (!patch) { ui.toast('I could not find a building in that image.'); return; }
    leaveImported();
    model.applyPatch(patch);
    refresh();
    commitVersion('decomposed render');
    ui.toast(patch.masses ? `“${notes}” — ${patch.masses.length} volumes rebuilt.` : `Rebuilt from silhouette. ${notes}`, 5200);
  } finally {
    ui.veil(false);
  }
}

// ---------------- render ----------------

// The render pipeline, narrated. Four visible steps, exactly like promptitect:
//   1  freeze the current view and use it as the INPUT image
//   2  expand one sentence into a full architectural brief (Claude)
//   3  send input + style reference + brief to Nano Banana Pro
//   4  lock the camera and lay the render over the model for comparison
// Every step reports into the chat, and a failure says which step failed and why.
async function doRender(userLine = '') {
  if (!built) { ui.addChatMsg('ai', 'Build something first, then I can render it.', 'err'); return; }

  const m = compute(customTypeText);
  const steps = [];
  const step = (text, cls = 'busy') => { const el = ui.addChatMsg('ai', text, cls); steps.push(el); return el; };
  const done = (el, text) => { el.classList.remove('busy'); el.textContent = text; };

  $('chat-render').disabled = true;
  ui.veil(true, 'freezing the view…');

  try {
    // ---- 1. the input image is exactly what you are looking at ----
    const s1 = step('① Capturing this exact view as the input image…');
    // a render can only be as faithful as its input: if the building is half
    // out of frame, fit it first and say so rather than sending a sliver
    const framing = model.buildingFraming();
    let framed = false;
    if (framing.visible < 0.85) { framed = model.frameBuilding(); }
    const snapshot = model.modelSnapshot();
    renderCamera = model.getCameraPose();       // lock: the render belongs to this view
    const shotSize = await new Promise(res => { const i = new Image(); i.onload = () => res(`${i.width}\u00d7${i.height}`); i.src = snapshot; });
    done(s1, `\u2460 Input image captured at ${shotSize} — this is the structure the render must follow.`);
    if (framed) ui.addChatMsg('ai', 'The building was partly outside the frame, so I fitted the view before capturing — a render can only follow what the input image shows.');
    ui.addChatImages(refDataURL
      ? [{ url: snapshot, label: 'IMAGE 1 · your model (structure)' }, { url: refDataURL, label: 'IMAGE 2 · your reference (style only)' }]
      : [{ url: snapshot, label: 'IMAGE 1 · your model (structure)' }]);

    // ---- 2. one sentence becomes a full brief ----
    let brief = userLine;
    if (hasAI()) {
      const s2 = step('② Writing the render brief from your words…');
      ui.veil(true, 'writing the brief…');
      try {
        const written = await writeRenderPrompt(userLine, {
          typeLabel: m.type.label,
          floors: model.state.floors,
          heightM: Math.round(m.stats.height),
          structure: model.state.structure,
          gfa: Math.round(m.stats.gfa),
          styleHint: userLine || 'photorealistic golden hour',
          weather: model.getWeather().label,
          setting: model.getLandscape().label,
          hasRef: !!refDataURL,
        });
        if (written) {
          brief = written;
          done(s2, '② Brief written:');
          ui.addChatMsg('ai', written, 'prompt');     // the full prompt, verbatim
        } else done(s2, '② No brief returned — using your words as written.');
      } catch (e) {
        s2.className = 'cmsg ai err';
        s2.textContent = `② Brief writer failed (${String(e.message).slice(0, 70)}) — using your words as written.`;
      }
    } else {
      step('② No OpenAI key — sending your words straight through.', '');
    }

    // ---- 3. the actual image model ----
    const s3 = step(refDataURL
      ? '③ Nano Banana Pro is painting — your view as structure, your reference for style…'
      : '③ Nano Banana Pro is painting…');
    ui.veil(true, hasGemini() ? 'Nano Banana Pro is painting…' : 'no Gemini key — stylising locally');

    const { url, engine } = await renderImage({
      snapshot,
      styleId,
      userPrompt: brief,
      refDataURL,
      typeLabel: m.type.label,
    });

    const local = engine.startsWith('local');
    if (!local) {
      done(s3, `③ Image returned by ${engine}.`);
    } else {
      s3.className = 'cmsg ai err';
      if (!hasGemini()) {
        s3.textContent = '③ This device has no Gemini key, so nothing was sent to the image model — what you see is a local tint, not a render. Keys cannot ship with a public site, so paste yours once here; it stays in this browser only.';
        const btn = document.createElement('button');
        btn.className = 'build-btn small';
        btn.style.cssText = 'margin-top:8px;width:100%';
        btn.textContent = 'Add your keys →';
        btn.onclick = () => ui.settingsModal(() => ui.toast('Saved on this device. Press Render again.'));
        s3.appendChild(btn);
      } else if (/429|quota/i.test(engine)) {
        s3.textContent = '③ Google refused with 429 — the key is valid but its project has no image-generation quota. Turn on billing for that project at aistudio.google.com, then press Render again. Showing a local tint meanwhile.';
      } else {
        s3.textContent = `③ Gemini failed: ${engine.replace(/^local \(|\)$/g, '').slice(0, 160)}. Showing a local tint meanwhile.`;
      }
    }

    // ---- 4. overlay on the model, camera pinned, compare ready ----
    showRender(url, { local });
    ui.addToStrip(url, u => { showRender(u, { local }); setCompare(true); });
    if (!local) {
      const s4 = step('④ Laid over the model — drag the divider to compare.', '');
      setCompare(true);
      void s4;
    }
  } catch (e) {
    console.error(e);
    ui.addChatMsg('ai', `Render pipeline failed: ${String(e.message).slice(0, 160)}`, 'err');
  } finally {
    $('chat-render').disabled = false;
    ui.veil(false);
  }
}

// ---------------- chat ----------------

async function onChat() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || !built) { if (!built) ui.toast('Build first — then we can talk.'); return; }
  input.value = '';
  input.classList.add('thinking');
  input.placeholder = 'thinking…';
  ui.veil(true, 'working on the building…');
  try {
    // red-pen annotation + note → vision edit of the composition
    if (annotationActive()) {
      ui.addChatMsg('user', `✏ ${text}`);
      if (!hasAI()) { ui.addChatMsg('ai', 'The red pen needs an OpenAI key — add one in ⚙.', 'err'); return; }
      if (!model.state.masses?.length) {
        ui.addChatMsg('ai', 'The red pen edits the AI composition, but this model came from the local reader. Press Update ↻ so Claude reads the sketch into volumes first.', 'err');
        clearAnnotation();
        return;
      }
      const busy = ui.addChatMsg('ai', 'Applying the red-pen note…', 'busy');
      try {
        const shot = await annotatedSnapshot();
        const r = await visionAnnotatedEdit(shot, text, model.state.masses, anthropicCfg());
        clearAnnotation();
        clearSelection();
        model.applyPatch({ masses: r.masses });
        refresh();
        syncParams();
        commitVersion(`✏ “${text.slice(0, 22)}${text.length > 22 ? '…' : ''}”`);
        busy.classList.remove('busy');
        busy.textContent = r.reply;
      } catch (e) {
        console.error(e);
        busy.className = 'cmsg ai err';
        busy.textContent = `Red-pen edit failed: ${String(e.message).slice(0, 80)}`;
      }
      return;
    }

    ui.addChatMsg('user', text);
    const busy = ui.addChatMsg('ai', 'thinking…', 'busy');
    const selectedRoles = [...selected].map(i => model.state.masses?.[i]?.role).filter(Boolean);
    const { edits, reply } = await interpretCommand(text, { selectedRoles });
    if (Object.keys(edits).length) {
      if (edits.type && TYPES[edits.type]) {
        $('type-select').value = edits.type;
        edits.floorHeight = edits.floorHeight ?? TYPES[edits.type].fh;
      }
      leaveImported();
      model.applyPatch(edits);
      refresh();
      if (selected.size) model.setSelection([...selected]);
      syncParams();
      commitVersion(`“${text.slice(0, 26)}${text.length > 26 ? '…' : ''}”`);
    }
    busy.classList.remove('busy');
    busy.textContent = reply;
  } finally {
    ui.veil(false);
    input.classList.remove('thinking');
    input.placeholder = 'Talk to the building — “three floors taller”, “twist it 15 degrees”, “make it a library”…';
    input.focus();
  }
}

// ---------------- parameters panel ----------------

let rebuildThrottle = 0;
function liveRebuild() {
  clearTimeout(rebuildThrottle);
  rebuildThrottle = setTimeout(() => {
    model.rebuild();
    if (selected.size) model.setSelection([...selected]);
  }, 50);
}

const paramHooks = {
  onMassEdit(i, k, v, commit) {
    const m = model.state.masses?.[i];
    if (!m) return;
    m[k] = v;
    if (commit) { refresh(); commitVersion(`param ${m.role}.${k}`); }
    else liveRebuild();
  },
  // One drag moves every volume and position together against the size the
  // drawing was read at, so it stays exact however far it is pushed back.
  onMassScale(f, commit) {
    model.scaleMasses(f);
    if (commit) { refresh(); syncParams(); commitVersion(`scaled to ${Math.round(f * 100)}%`); }
    else liveRebuild();
    return model.designedHeight();
  },
  onMassFacade(i, f) {
    if (!model.state.masses?.[i]) return;
    model.state.masses[i].facade = f;
    refresh(); syncParams(); commitVersion('facade change');
  },
  onMassDelete(i) {
    if (!model.state.masses) return;
    model.state.masses.splice(i, 1);
    clearSelection(); refresh(); syncParams(); commitVersion('volume removed');
  },
  onMassAdd() {
    model.state.masses = model.state.masses || [];
    model.state.masses.push({
      id: 'v' + (model.state.masses.length + 1), role: 'volume',
      w: 12, d: 10, h: 10, x: 0, y: 0, z: 0, rotY: 0,
      facade: 'solid', cantilever: false, on: 'ground', flush: [], partOf: null, storeys: null,
    });
    refresh(); syncParams(); commitVersion('volume added');
  },
  onGlobalEdit(k, v, commit) {
    model.applyPatch({ [k]: v });
    if (commit) { refresh(); commitVersion(`param ${k}`); }
    else liveRebuild();
  },
  onMassHover(i) {
    if (i === null || i === undefined) model.setSelection([...selected]);
    else model.setSelection([i]);
    ui.highlightParamGroup(i);
  },
};

function syncParams() { ui.renderParams(model.state, paramHooks); }

// ---------------- wiring ----------------


function syncSunControls() {
  const { hour } = model.getSunTime();
  if ($('sun-hour')) $('sun-hour').value = hour;
  const h = Math.floor(hour), mm = Math.round((hour - h) * 60);
  if ($('sun-readout')) $('sun-readout').textContent = `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function wire() {
  // Which machine this is has to be settled first — the frame ratio, the
  // default level of detail and half the layout all branch on it.
  const dev = initDevice();

  $('btn-build').addEventListener('click', build);

  // ---- napkin tools ----
  const setTool = t => {
    sketch.setTool(t);
    $('tool-pen').classList.toggle('active', t === 'pen');
    $('tool-erase').classList.toggle('active', t === 'erase');
  };
  $('tool-pen').addEventListener('click', () => setTool('pen'));
  $('tool-erase').addEventListener('click', () => setTool('erase'));
  $('tool-undo').addEventListener('click', () => {
    sketch.undo();
    if (built) { leaveImported(); refresh({ reinterpret: !hasAI() }); }
  });
  // Screwing up a bad sketch and lobbing it is what this button means, so it
  // does that: crumple, throw, and a clean one floats up. The ink is cleared
  // while the ball is off-screen, so the new napkin arrives already blank.
  let binning = false;
  $('tool-clear').addEventListener('click', () => {
    if (binning) return;
    const nap = $('napkin');
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still || !nap) {
      sketch.clearAll(); setTool('pen');
      $('concept-pane').classList.add('hidden');
      ui.toast('Fresh napkin.');
      return;
    }
    binning = true;
    // a real throw never repeats: direction, arc and spin are drawn fresh
    const dir = Math.random() < 0.42 ? -1 : 1;
    nap.style.setProperty('--lob-x', (dir * (34 + Math.random() * 30)).toFixed(0) + 'vw');
    nap.style.setProperty('--lob-peak', (-(22 + Math.random() * 20)).toFixed(0) + 'vh');
    nap.style.setProperty('--lob-spin', (dir * (360 + Math.random() * 280)).toFixed(0) + 'deg');
    nap.classList.add('crumpling');
    setTimeout(() => {
      sketch.clearAll();
      setTool('pen');
      $('concept-pane').classList.add('hidden');
      nap.classList.remove('crumpling');
      nap.classList.add('arriving');
      setTimeout(() => { nap.classList.remove('arriving'); binning = false; }, 600);
    }, 1400);
  });

  $('photo-input').addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await sketch.loadPhoto(file);
      ui.toast(built ? 'Photo on the napkin — press Update ↻ to read it.' : 'Photo on the napkin — press Build it →');
    } catch (err) {
      console.error(err);
      ui.toast('Could not read that image.');
    }
    e.target.value = '';
  });

  // while drawing in the workspace: local reader updates live; the AI reader
  // costs a call, so it waits for an explicit Update ↻
  let nudged = false;
  sketch.initSketch($('sketch-canvas'), () => {
    if (!built) return;
    if (hasAI()) {
      if (!nudged) { ui.toast('Sketch changed — press Update ↻ and ChatGPT re-reads it.', 2600); nudged = true; setTimeout(() => nudged = false, 15000); }
    } else { leaveImported(); refresh({ reinterpret: true }); }
  });

  $('type-select').addEventListener('change', e => {
    const v = e.target.value;
    if ($('kind-select').value !== v) $('kind-select').value = v;
    $('type-custom').classList.toggle('hidden', v !== 'custom');
    if (v !== 'custom') {
      customTypeText = '';
      model.applyPatch({ type: v, floorHeight: TYPES[v].fh });
      if (built) { leaveImported(); refresh(); commitVersion(`program: ${TYPES[v].label}`); }
    } else $('type-custom').focus();
  });
  $('type-custom').addEventListener('change', e => {
    customTypeText = e.target.value.trim();
    model.applyPatch({ type: 'office' });
    if (built) { refresh(); ui.toast(`Custom program “${customTypeText}” — mapped to nearest baseline for loads.`); }
  });

  $('ref-input').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      refDataURL = rd.result;
      const chip = $('ref-chip');
      chip.textContent = `ref: ${f.name} ✕`;
      chip.classList.remove('hidden');
      chip.onclick = () => { refDataURL = null; chip.classList.add('hidden'); $('ref-input').value = ''; };
    };
    rd.readAsDataURL(f);
  });

  $('obj-input').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) importModelFile(f);
    e.target.value = '';
  });
  $('reverse-input').addEventListener('change', e => {
    const f = e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => decomposeRender(rd.result);
    rd.readAsDataURL(f);
    e.target.value = '';
  });

  // Dictation. Speech recognition is a browser feature, no key needed; Safari
  // and Chrome expose it under different names and it needs a secure origin.
  (() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = $('btn-mic');
    if (!btn) return;
    if (!SR) { btn.style.display = 'none'; return; }
    let rec = null;
    btn.addEventListener('click', () => {
      if (rec) { rec.stop(); return; }
      rec = new SR();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.continuous = false;
      const input = $('chat-input');
      const before = input.value ? input.value.trim() + ' ' : '';
      btn.classList.add('active');
      btn.textContent = '\u25cf';
      rec.onresult = e => {
        input.value = before + [...e.results].map(r => r[0].transcript).join(' ').trim();
      };
      rec.onerror = ev => {
        ui.addChatMsg('ai', ev.error === 'not-allowed'
          ? 'Microphone blocked — allow it in the browser, and note dictation needs https or localhost.'
          : `Dictation stopped: ${ev.error}`, 'err');
      };
      rec.onend = () => {
        rec = null;
        btn.classList.remove('active');
        btn.textContent = '\ud83c\udfa4';
        input.focus();
      };
      try { rec.start(); } catch { rec = null; btn.classList.remove('active'); btn.textContent = '\ud83c\udfa4'; }
    });
  })();

  $('chat-send').addEventListener('click', onChat);
  $('chat-render').addEventListener('click', () => {
    const line = $('chat-input').value.trim();
    if (line) { ui.addChatMsg('user', '✦ ' + line); $('chat-input').value = ''; }
    doRender(line);
  });
  $('chat-input').addEventListener('keydown', e => { if (e.key === 'Enter') onChat(); });

  document.querySelectorAll('.vmode').forEach(b =>
    b.addEventListener('click', () => {
      if (b.dataset.mode === 'wood' && viewMode === 'wood') {
        const W = model.cycleWood();
        b.textContent = `Wood · ${W.label}`;
        ui.addChatMsg('ai', `Model stock: ${W.label.toLowerCase()}.`);
        return;
      }
      if (b.dataset.mode !== 'wood') b.textContent = b.dataset.mode === 'white' ? 'White' : b.textContent;
      setViewMode(b.dataset.mode);
      if (b.dataset.mode === 'wood') b.textContent = `Wood · ${model.currentWood().label}`;
    }));

  $('btn-params').addEventListener('click', () => {
    const p = $('params-panel');
    const show = p.classList.contains('hidden');
    p.classList.toggle('hidden', !show);
    $('btn-params').classList.toggle('active', show);
    if (show) syncParams();
    setTimeout(() => dispatchEvent(new Event('resize')), 60);
  });

  $('btn-home').addEventListener('click', () => { currentProjectId = null; }, { capture: true });
  $('btn-home').addEventListener('click', () => {
    document.body.classList.remove('workspace');
    document.body.classList.add('landing');
    built = false;
    $('btn-build').innerHTML = 'Build it' + ICON.arrow;
    clearSelection();
    clearAnnotation();
    // the working panes belong to the workspace, not the front page
    for (const id of ['wire-pane', 'concept-pane', 'params-panel', 'render-layer']) $(id).classList.add('hidden');
    $('btn-params').classList.remove('active');
    setCompare(false);
    refreshGallery();
    setTimeout(() => dispatchEvent(new Event('resize')), 60);
  });

  // Single click steps to the next one; double click returns to the default.
  // A short guard keeps the second click of a double from also stepping.
  const cycler = (btn, step, reset, describe) => {
    let timer = 0;
    btn.addEventListener('click', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const item = step();
        btn.textContent = item.label;
        ui.toast(describe(item), 2200);
      }, 190);
    });
    btn.addEventListener('dblclick', () => {
      clearTimeout(timer);
      const item = reset();
      btn.textContent = item.label;
      ui.toast(`${item.label} · back to the default`, 2000);
    });
  };

  if (isTouch() && innerWidth <= 1200) {
    // one home for everything that changes how the scene looks
    $('site-bar').prepend($('view-modes'));
  }

  // Frame ratio: the canvas is letterboxed to this, so what you compose is
  // exactly what the render model receives.
  const RATIOS = [['16:9', 16 / 9], ['3:2', 3 / 2], ['4:3', 4 / 3], ['1:1', 1], ['9:16', 9 / 16]];
  // A phone is tall and narrow: a 16:9 frame leaves the building the height of
  // a postage stamp, so it opens square there and wide everywhere else.
  const DEFAULT_RATIO = deviceKind() === 'phone' ? '1:1' : '16:9';
  const ratioOf = label => Math.max(0, RATIOS.findIndex(r => r[0] === label));
  let ratioIndex = ratioOf(localStorage.getItem('napkin_ratio') || DEFAULT_RATIO);
  // The frame is measured here rather than in CSS: letterboxing a canvas with
  // aspect-ratio makes its layout size depend on its own drawing buffer, and
  // that loop is what stretched the model when the ratio changed.
  function fitFrame() {
    const vp = $('viewport'), fr = $('vp-frame');
    if (!vp || !fr) return;
    if (document.body.classList.contains('fs')) { fr.style.width = ''; fr.style.height = ''; return; }
    const a = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--vp-aspect')) || 16 / 9;
    const W = vp.clientWidth, H = vp.clientHeight;
    if (W < 8 || H < 8) return;
    const w = Math.min(W, H * a);
    fr.style.width = Math.round(w) + 'px';
    fr.style.height = Math.round(w / a) + 'px';
  }
  new ResizeObserver(fitFrame).observe($('viewport'));

  function applyRatio() {
    const [label, value] = RATIOS[ratioIndex];
    document.documentElement.style.setProperty('--vp-aspect', String(value));
    $('btn-aspect').textContent = label;
    localStorage.setItem('napkin_ratio', label);
    fitFrame();
  }

  // ---- fullscreen: the model takes the whole screen, ratio set aside ----
  // Done in CSS first because an iPhone only grants the Fullscreen API to a
  // <video>; the API is asked for on top, where it exists, to drop the chrome.
  let camHome = null;
  function placeCamPane() {
    const cam = $('cam-pane'), vp = $('viewport');
    if (!cam) return;
    if (document.body.classList.contains('fs')) {
      if (cam.parentElement !== vp) { camHome = cam.parentElement; vp.appendChild(cam); }
    } else if (camHome && cam.parentElement !== camHome) {
      camHome.appendChild(cam);
    }
  }
  function setFullscreen(on) {
    if (on) closeSheets();     // nothing should sit over a fullscreen model
    document.body.classList.toggle('fs', on);
    placeCamPane();
    fitFrame();
    $('btn-fs').title = on ? 'Leave fullscreen' : 'Fullscreen — the model fills the screen';
    if (on && !document.fullscreenElement) $('viewport').requestFullscreen?.().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }
  $('btn-fs').addEventListener('click', () => setFullscreen(!document.body.classList.contains('fs')));
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('fs')) setFullscreen(false);
  });
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.body.classList.contains('fs')) setFullscreen(false);
  });
  $('btn-aspect').addEventListener('click', () => {
    ratioIndex = (ratioIndex + 1) % RATIOS.length;
    applyRatio();
  });
  $('btn-aspect').addEventListener('dblclick', () => { ratioIndex = ratioOf(DEFAULT_RATIO); applyRatio(); });
  applyRatio();

  cycler($('btn-landscape'),
    () => {
      if (!$('btn-context').classList.contains('active')) {
        $('btn-context').classList.add('active');
        model.toggleContext(true);
      }
      return model.cycleLandscape(1);
    },
    () => model.resetLandscape(),
    L => `${L.label} · ${L.note}`);

  cycler($('btn-weather'),
    () => { const W = model.cycleWeather(1); syncSunControls(); return W; },
    () => { const W = model.resetWeather(); syncSunControls(); return W; },
    W => `${W.label} · ${W.note}`);

  // Phone: one bottom sheet at a time, raised from the work bar. Tapping the
  // same button again, or anywhere on the model, puts it away.
  const SHEETS = ['scene', 'tools', 'params', 'chat', 'metric'];
  function closeSheets() {
    SHEETS.forEach(k => document.body.classList.remove('sheet-' + k));
    document.querySelectorAll('#phone-bar button').forEach(b => b.classList.remove('active'));
  }
  const SHEET_EL = { scene: 'site-bar', tools: 'model-controls', params: 'params-panel', chat: 'chatbar', metric: 'metric-sheet' };

  function openSheet(kind) {
    const already = document.body.classList.contains('sheet-' + kind);
    closeSheets();
    if (already) return;

    // Every tab except Napkin is about the building, so bring the model
    // forward first — otherwise the controls would act on a hidden view.
    if (document.body.classList.contains('pane-sketch')) showPane('model');
    document.querySelector('#phone-bar [data-sheet="napkin"]')?.classList.remove('active');

    // The panels are display:none until first use on desktop; a sheet slides
    // rather than toggles, so it has to be displayed before it can move.
    const el = $(SHEET_EL[kind]);
    el?.classList.remove('hidden');

    if (kind === 'params') syncParams();
    if (kind === 'metric') {
      const sheet = $('metric-sheet');
      sheet.innerHTML = '';
      [...$('metric-rail').children].forEach(c => sheet.appendChild(c.cloneNode(true)));
      if (!sheet.children.length) sheet.innerHTML = '<div class="sheet-empty">Build something and the numbers appear here.</div>';
    }

    document.body.classList.add('sheet-' + kind);
    document.querySelector(`#phone-bar [data-sheet="${kind}"]`)?.classList.add('active');
    if (kind === 'chat') setTimeout(() => $('chat-input').focus(), 260);
  }
  document.querySelectorAll('#phone-bar button').forEach(b => b.addEventListener('click', () => {
    const kind = b.dataset.sheet;
    if (kind === 'napkin') {
      closeSheets();
      showPane('sketch');
      b.classList.add('active');
      return;
    }
    openSheet(kind);
  }));
  // A sheet stays put while you work the model. Half of what these panels do
  // — sun hour, level of detail, a parameter slider — only makes sense while
  // you are turning the building, and closing on first touch made the panel
  // and the model mutually exclusive. It closes on its own tab, on another
  // tab, or on the way into fullscreen.

  $('btn-compare').addEventListener('click', () => setCompare(!compareOn));
  initCompareDrag();
  initSplitters();

  // designer signature — name and date, both optional, never abbreviated
  const savedName = localStorage.getItem('napkin_author') || '';
  // the date tracks today unless the author typed one of their own
  const savedDate = localStorage.getItem('napkin_date_custom') === '1'
    ? (localStorage.getItem('napkin_author_date') || todayLabel())
    : todayLabel();
  $('author-input').value = savedName;
  $('author-date').value = savedDate;
  applySignature(savedName, savedDate);
  $('author-input').addEventListener('input', e => applySignature(e.target.value, $('author-date').value));
  $('author-date').addEventListener('input', e => {
    localStorage.setItem('napkin_date_custom', '1');
    applySignature($('author-input').value, e.target.value);
  });
  $('author-date').addEventListener('focus', e => { if (!e.target.value) { e.target.value = todayLabel(); applySignature($('author-input').value, e.target.value); } });
  $('author-input').setAttribute('placeholder', savedName ? savedName : 'your name');

  // gallery rail
  refreshGallery();
  initGalleryScroll($('gallery'));

  // project archetype picker sits next to Build and mirrors the dashboard
  $('kind-select').addEventListener('change', e => {
    const v = e.target.value;
    $('type-select').value = v;
    $('type-select').dispatchEvent(new Event('change'));
  });

  // hand control — camera preview appears where the line study used to live
  $('btn-hand').addEventListener('click', async () => {
    const btn = $('btn-hand');
    if (hands.isRunning()) {
      hands.stopHands($('hand-video'));
      btn.classList.remove('active');
      $('cam-pane').classList.add('hidden');
      hands.drawCursor($('hand-canvas'), null);
      ui.addChatMsg('ai', 'Hand control off.');
      return;
    }
    ui.addChatMsg('ai', 'Hand control asks for your camera. The video stays on this machine — nothing is uploaded.');
    btn.classList.add('active');
    const busy = ui.addChatMsg('ai', 'Starting the camera…', 'busy');
    try {
      const hc = $('hand-canvas');
      const sizeHand = () => { hc.width = hc.clientWidth * devicePixelRatio; hc.height = hc.clientHeight * devicePixelRatio; };
      sizeHand();
      new ResizeObserver(sizeHand).observe(hc);
      let grabbed = null;
      await hands.startHands($('hand-video'), $('cam-canvas'), {
        onCursor: cur => hands.drawCursor(hc, cur),
        onGestureStart: (g, x, y) => {
          if (g === 'pinch') grabbed = model.beginDrag(x, y);
        },
        onGestureMove: (g, x, y, dx, dy) => {
          if (g === 'pinch' && grabbed !== null) model.moveDrag(x, y);
          else if (g === 'open') model.orbitCamera(dx, dy);
          else if (g === 'fist') model.zoomCamera(1 + dy * 2.2);
        },
        onGestureEnd: g => {
          if (g === 'pinch' && grabbed !== null) {
            model.endDrag(); refresh(); syncParams(); commitVersion('✋ moved by hand');
            grabbed = null;
          }
        },
        onHold: () => { model.frameBuilding(); ui.toast('Re-framed.'); },
      });
      $('cam-pane').classList.remove('hidden');
      placeCamPane();
      busy.classList.remove('busy');
      busy.textContent = 'Hands on: open palm orbits · pinch grabs a volume · fist rises and falls to zoom · hold an open palm still to re-frame.';
    } catch (e) {
      btn.classList.remove('active');
      busy.className = 'cmsg ai err';
      busy.textContent = `Camera unavailable: ${String(e.message).slice(0, 220)}`;
    }
  });

  $('btn-anno').addEventListener('click', () => {
    if (!built) { ui.toast('Build first.'); return; }
    const on = document.body.classList.toggle('annotating');
    $('btn-anno').classList.toggle('active', on);
    if (on) ui.toast('Red pen armed — circle a part of the model, then type what should change and Say it.', 4200);
    else clearAnnotation();
  });

  $('sel-clear').addEventListener('click', clearSelection);

  // Rhino live-link: pick a folder once; every change writes napkin-live.3dm there.
  let liveDir = null, liveTimer = 0;
  window.__liveSync = async () => {
    if (!liveDir || !built) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(async () => {
      try {
        const bytes = await model.rhinoBytes(JSON.stringify(model.snapshotState()), metricsBrief(compute(customTypeText)));
        const fh = await liveDir.getFileHandle('napkin-live.3dm', { create: true });
        const w = await fh.createWritable();
        await w.write(bytes);
        await w.close();
      } catch (e) { console.warn('live sync failed', e); }
    }, 900);
  };
  $('btn-live').addEventListener('click', async () => {
    if (!('showDirectoryPicker' in window)) { ui.toast('This browser has no folder access API — use ⇩ Rhino instead.'); return; }
    if (liveDir) { liveDir = null; $('btn-live').classList.remove('active'); ui.toast('Live-link off.'); return; }
    try {
      liveDir = await showDirectoryPicker({ mode: 'readwrite' });
      $('btn-live').classList.add('active');
      window.__liveSync();
      ui.toast('Live-link on: napkin-live.3dm updates in that folder on every change. Run rhino_live_watch.py inside Rhino to auto-reload it.', 6400);
    } catch { /* user cancelled */ }
  });

  $('btn-rhino').addEventListener('click', async () => {
    if (!built) { ui.toast('Build first — then take it to Rhino.'); return; }
    ui.toast('Writing .3dm…');
    const kind = await model.exportRhino(JSON.stringify(model.snapshotState(), null, 2), metricsBrief(compute(customTypeText)));
    const caged = model.exportCageObj();
    ui.toast((kind === '3dm'
      ? 'napkin-building.3dm downloaded — drag it into Rhino. Parameters ride along in document user text.'
      : 'Rhino engine unavailable here — exported .obj instead (Rhino opens it fine).')
      + (caged ? ' Plus napkin-cage.obj: quad control cages — select and ToSubD in Rhino to sculpt.' : ''), 5200);
  });

  $('btn-spin').addEventListener('click', () => {
    const on = $('btn-spin').classList.toggle('active');
    model.toggleSpin(on);
  });
  // ---- device adaptation ----
  document.querySelectorAll('#mobile-tabs button').forEach(b =>
    b.addEventListener('click', () => showPane(b.dataset.pane)));
  if (dev === 'phone') showPane('sketch');
  // hand control needs a webcam pointed at you AND a spare hand — desktop only
  if (isTouch()) $('btn-hand').classList.add('hidden');
  // a touch device gets the lighter model by default so it stays at 60fps
  if (dev === 'phone') {
    model.setDetail('massing');
    document.querySelectorAll('#detail-seg button').forEach(x =>
      x.classList.toggle('active', x.dataset.detail === 'massing'));
  }
  onDeviceChange(k => { if (k !== 'phone') document.body.classList.remove('pane-sketch', 'pane-model'); });

  // ---- site / time / detail bar (ported from CONCORD) ----
  $('site-select').innerHTML = Object.entries(SITES)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  $('site-select').value = getSite().key;

  function applySun(patch) {
    model.setSunTime(patch);
    syncSunControls();
    refresh();                   // metrics follow latitude
  }
  $('site-select').addEventListener('change', e => {
    applySun({ site: e.target.value });
    const s = getSite();
    const w = daylightWindow(model.getSunTime().date);
    ui.addChatMsg('ai', `Site: ${s.label} (${s.lat.toFixed(2)}°, ${s.desc}). Daylight today ${w ? `${w.rise.toFixed(1)}h–${w.set.toFixed(1)}h` : 'polar'} — daylight and energy metrics just moved with it.`);
  });
  document.querySelectorAll('#season-seg button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#season-seg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    applySun({ date: seasonDate(b.dataset.season) });
  }));
  $('sun-hour').addEventListener('input', e => applySun({ hour: +e.target.value }));
  document.querySelectorAll('#detail-seg button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#detail-seg button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    model.setDetail(b.dataset.detail);
    model.rebuild();
    if (selected.size) model.setSelection([...selected]);
  }));
  $('btn-context').addEventListener('click', () => {
    const on = $('btn-context').classList.toggle('active');
    model.toggleContext(on);
  });
  syncSunControls();

  $('btn-settings').addEventListener('click', () => ui.settingsModal(() => ui.toast('Saved.')));
  $('btn-versions').addEventListener('click', () => ui.versionsModal(
    id => {
      const c = versions.stream.commits.find(x => x.id === id);
      if (!c) return;
      leaveImported();
      model.restoreState(c.params);
      sketch.restoreStrokes(c.strokes);
      $('type-select').value = TYPES[c.params.type] ? c.params.type : 'office';
      refresh();
      syncParams();
      ui.toast(`Travelled back to ${c.label}.`);
    },
    () => versions.exportStream(model.snapshotState()),
  ));
}

// ---------------- boot ----------------

model.initModel($('model-canvas'), onPickMass);
model.initWire($('wire-canvas'));
setupAnnotation();
wire();
ui.renderMetrics(compute());
