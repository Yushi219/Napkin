// Natural-language modelling. Claude translates speech into parameter edits via
// a strict tool schema; a bilingual keyword engine answers when offline.
import { state } from './model.js';
import { TYPES } from './metrics.js';
import { sanitizeMasses } from './interpret.js';
import { gptVisionCompat, hasGPT } from './gptcore.js';

// A key copied on a phone often arrives carrying something invisible — a
// zero-width space, a non-breaking space, a trailing newline. fetch refuses
// any header value outside Latin-1 and reports it as "Failed to read the
// 'headers' property", which names nothing the user can act on. So the key is
// reduced to printable ASCII at the one place it is read.
export const cleanKey = v => String(v ?? '').replace(/[^!-~]/g, '');

// One engine for everything spoken: ChatGPT. hasAI answers whether any
// AI edit path is live on this device.
export function hasAI() { return hasGPT(); }

const EDIT_SCHEMA = {
  floors: 'int 2..70', floorHeight: 'number 2.8..5.5 (metres)', baseWidth: 'number 14..60',
  baseDepth: 'number 12..55', twist: 'number -90..90 (total degrees)', taper: 'number 0.4..1.15 (top/base ratio)',
  orientation: 'number -90..90', greenRoof: 'bool', structure: "'concrete'|'steel'|'timber-hybrid'",
  type: "'office'|'laboratory'|'residential'|'hotel'|'school'",
  masses: 'ONLY if state.masses is set: the FULL edited array of {role,w,d,h,x,y,z,rotY,facade:slats-v|slats-h|glass|solid,cantilever}. Edit the volumes the user names ("the cantilever", "the tower"), keep the rest untouched.',
};

async function gptEdit(text, ctx = {}) {
  const pointing = ctx.selectedRoles?.length
    ? `\nThe user has SELECTED these volumes in the 3D view and is talking about them: ${ctx.selectedRoles.join(', ')}. Apply the edit to the selected volumes unless they clearly say otherwise.`
    : '';
  const { text: t } = await gptVisionCompat({
    max_tokens: 500,
    system: `You edit a parametric building. Current state: ${JSON.stringify(state)}.
Editable fields and ranges: ${JSON.stringify(EDIT_SCHEMA)}.${pointing}
The user speaks casually (English or Chinese). Reply ONLY JSON:
{"edits": {field: value, ...}, "reply": "<one warm sentence, <=18 words, saying what you did>"}
Relative asks ("taller", "高一点") adjust from current values. If nothing is editable, return empty edits and explain briefly in reply.`,
    messages: [{ role: 'user', content: text }],
  }, 'chat edit');
  return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
}

// ---- bilingual keyword fallback ----

function localEdit(text) {
  const t = text.toLowerCase();
  const edits = {};
  const said = [];
  const num = (re) => { const m = t.match(re); return m ? parseFloat(m[1]) : null; };

  const relUp = num(/(\d+)\s*(?:floors?|storeys?|stories|层|楼)?\s*(?:taller|higher)/) ?? num(/(?:加|高)\s*(\d+)\s*(?:层|楼)/);
  const relDown = num(/(\d+)\s*(?:floors?|storeys?|stories|层|楼)?\s*(?:shorter|lower)/) ?? num(/(?:减|矮|降)\s*(\d+)\s*(?:层|楼)/);
  const floorsTo = num(/(\d+)\s*(?:floors|storeys|stories|层|楼)/);
  if (relUp) { edits.floors = state.floors + relUp; said.push(`${relUp} floors taller`); }
  else if (relDown) { edits.floors = Math.max(2, state.floors - relDown); said.push(`${relDown} floors shorter`); }
  else if (floorsTo) { edits.floors = floorsTo; said.push(`${floorsTo} floors`); }
  else if (/taller|higher|加高|高一点|再高|长高/.test(t)) { edits.floors = state.floors + 3; said.push('3 floors taller'); }
  else if (/shorter|lower|矮|降低|低一点/.test(t)) { edits.floors = Math.max(2, state.floors - 3); said.push('3 floors shorter'); }

  const twistTo = num(/twist\D*(-?\d+)|扭\D*(-?\d+)/) ?? num(/(-?\d+)\s*(deg|度)/);
  if (/twist|扭/.test(t)) { edits.twist = twistTo ?? (state.twist ? 0 : 20); said.push(`twist ${edits.twist}°`); }
  if (/untwist|不扭|拉直|straight/.test(t)) { edits.twist = 0; said.push('untwisted'); }

  if (/taper|收分|上小下大|细/.test(t)) { edits.taper = Math.max(0.5, (state.taper || 1) - 0.15); said.push('more taper'); }
  const widthM = num(/(\d+)\s*(?:m|meters|metres|米)\s*(?:wide|宽)/) ?? num(/宽\s*(\d+)\s*米?/);
  if (widthM) { edits.baseWidth = widthM; said.push(`${widthM} m wide`); }
  else if (/wider|更宽|加宽/.test(t)) { edits.baseWidth = Math.min(60, state.baseWidth + 6); said.push('wider plate'); }
  if (/narrower|slimmer|窄|瘦/.test(t)) { edits.baseWidth = Math.max(14, state.baseWidth - 6); said.push('slimmer plate'); }
  if (/green roof|绿屋顶|屋顶花园|roof garden/.test(t)) { edits.greenRoof = true; said.push('green roof on'); }
  if (/timber|木/.test(t)) { edits.structure = 'timber-hybrid'; said.push('timber frame'); }
  if (/steel|钢/.test(t)) { edits.structure = 'steel'; said.push('steel frame'); }
  if (/concrete|混凝土/.test(t)) { edits.structure = 'concrete'; said.push('concrete frame'); }
  if (/rotate|旋转|转/.test(t)) { const d = num(/(-?\d+)/) ?? 15; edits.orientation = d; said.push(`rotated ${d}°`); }

  for (const [k, v] of Object.entries(TYPES)) {
    if (t.includes(k) || t.includes(v.label.toLowerCase())) { edits.type = k; said.push(v.label.toLowerCase()); }
  }
  if (/实验室/.test(text)) { edits.type = 'laboratory'; said.push('laboratory'); }
  if (/住宅|公寓/.test(text)) { edits.type = 'residential'; said.push('residential'); }
  if (/酒店/.test(text)) { edits.type = 'hotel'; said.push('hotel'); }
  if (/学校/.test(text)) { edits.type = 'school'; said.push('school'); }
  if (/办公/.test(text)) { edits.type = 'office'; said.push('office'); }

  return {
    edits,
    reply: Object.keys(edits).length
      ? `Done — ${said.join(', ')}.`
      : 'I heard you, but found no lever for that yet. Try floors, twist, taper, width, structure or program.',
  };
}

const CLAMP = {
  floors: v => Math.max(2, Math.min(70, Math.round(v))),
  floorHeight: v => Math.max(2.8, Math.min(5.5, v)),
  baseWidth: v => Math.max(14, Math.min(60, v)),
  baseDepth: v => Math.max(12, Math.min(55, v)),
  twist: v => Math.max(-90, Math.min(90, v)),
  taper: v => Math.max(0.4, Math.min(1.15, v)),
  orientation: v => Math.max(-90, Math.min(90, v)),
  greenRoof: v => !!v,
  structure: v => ['concrete', 'steel', 'timber-hybrid'].includes(v) ? v : state.structure,
  type: v => TYPES[v] ? v : state.type,
  masses: v => sanitizeMasses(v) || state.masses,
};

export async function interpretCommand(text, ctx = {}) {
  let out;
  if (hasAI()) {
    try { out = await gptEdit(text, ctx); }
    catch (e) { console.warn('claude chat failed → local', e); out = localEdit(text); out.engine = 'local (Claude unreachable)'; }
  } else out = localEdit(text);

  const clean = {};
  for (const [k, v] of Object.entries(out.edits || {})) {
    if (CLAMP[k] !== undefined && v !== null && v !== undefined) clean[k] = CLAMP[k](v);
  }
  return { edits: clean, reply: out.reply || 'Done.', engine: out.engine || (hasAI() ? 'gpt' : 'local') };
}
