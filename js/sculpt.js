// Sculpting a building out of a drawing, in locked stages.
//
// Two ideas taken from img2threejs, both aimed at the same failure: a model
// that reads the drawing correctly and then builds something else.
//
//   THE INVENTORY GATE. Before any geometry, enumerate every identity-defining
//   feature in the drawing — with a count and the evidence for it. Every
//   element built must then declare which inventory items it accounts for, and
//   code checks the coverage. A feature nobody claimed is a feature that got
//   lost; it is named, and the next stage is told to build it. The build cannot
//   quietly drop the loggia.
//
//   THE FROZEN BLOCKOUT. Build the primary masses alone and get them right
//   first. Then add detail WITHOUT touching them — later stages append and cut,
//   they never rewrite. This is the fix for the pattern where a good massing is
//   destroyed by a pass that was only supposed to add a canopy.
//
// Everything still lands as boxes in the same state the parameter desk edits
// and the Rhino export turns into NURBS solids, so nothing downstream changes.

import {
  MASS_SCHEMA as FULL_MASS_SCHEMA, sanitizeMasses, fitToEnvelope,
  claudeImage, cropReferenceImage, zoomTiles, geometryAudit,
} from './interpret.js';
import { claudeToolCall, hasClaude, claudeConfig } from './claudecore.js';
import { scoreAgainst, measurementReport } from './score.js';

const MASS_SCHEMA = {
  ...FULL_MASS_SCHEMA,
  properties: {
    ...FULL_MASS_SCHEMA.properties,
    covers: { type: 'array', items: { type: 'string' },
      description: 'ids of the inventory features this element accounts for' },
  },
  required: ['id', 'w', 'd', 'h', 'x', 'y', 'z', 'on'],
};

// ---------------- stage 1: the inventory ----------------

const INVENTORY_TOOL = {
  name: 'record_inventory',
  description: 'Enumerate every identity-defining feature of the building in the drawing.',
  input_schema: {
    type: 'object',
    properties: {
      parti: { type: 'string', description: 'the scheme in one sentence: the two or three primary masses and what each does' },
      buildingType: { type: 'string', enum: ['house', 'residential', 'office', 'laboratory', 'hotel', 'school', 'gallery', 'unknown'] },
      storeys: { type: 'integer', description: 'storeys counted off the drawing, not guessed' },
      envelope: { type: 'object', properties: { w: { type: 'number' }, d: { type: 'number' }, h: { type: 'number' } }, required: ['w', 'd', 'h'] },
      camera: { type: 'object', properties: { yawDeg: { type: 'number' }, pitchDeg: { type: 'number' }, fovDeg: { type: 'number' } }, required: ['yawDeg', 'pitchDeg'] },
      features: {
        type: 'array', minItems: 2, maxItems: 20,
        description: 'every feature that gives this building its identity. If it were missing, would the drawing read differently? Then it belongs here.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'short slug, e.g. "upper-cantilever"' },
            what: { type: 'string', description: 'what it is, in an architect’s words' },
            where: { type: 'string', description: 'where on the building' },
            count: { type: 'integer', description: 'how many, counted' },
            tier: { type: 'string', enum: ['primary', 'secondary', 'detail'] },
            evidence: { type: 'string', description: 'what in the drawing shows it — a counted line, a shadow, a change of plane' },
          },
          required: ['id', 'what', 'where', 'count', 'tier', 'evidence'],
        },
      },
    },
    required: ['parti', 'storeys', 'envelope', 'camera', 'features'],
  },
};

const INVENTORY_BRIEF = `You are surveying an architectural drawing before anyone models it. Do not design, do not simplify, do not model — inventory.

Name the PARTI first: the two or three primary masses this building is made of and what each does. A building is almost never twenty things; it is "a long bar on a glazed base" or "an L of two wings around a corner".

Then list every IDENTITY-DEFINING feature. The test for inclusion: if this feature were missing, would the drawing read as a different building? A deep cantilever passes. A recessed ground floor passes. A slatted screen passes, with its counted number of fins. A single window mullion does not.

For each, give the evidence — the counted line, the shadow, the change of plane that shows it. You are given the whole drawing plus enlarged halves; count in the enlargements. A count you guessed is worse than a count you refused to give.

Tier each feature: primary (an inhabitable mass), secondary (changes the silhouette — canopy, cantilever, entry frame, roof plane), detail (texture — fins, screens, balustrades).

What you miss here is lost for good: nothing downstream can build a feature you did not name.`;

export async function takeInventory(targetURL, io) {
  io.step?.('Stage 1 of 4 — surveying the drawing…');
  const tiles = await zoomTiles(targetURL);
  const content = [{ type: 'text', text: INVENTORY_BRIEF }, await claudeImage(targetURL)];
  for (const t of tiles) content.push({ type: 'text', text: 'THE DRAWING, ' + t.label }, await claudeImage(t.url));
  const inv = await claudeToolCall({ content, tool: INVENTORY_TOOL, maxTokens: 4000 }, 'inventory');
  io.tiles = tiles;
  return inv;
}

// ---------------- stage 2: the blockout ----------------

const BLOCKOUT_TOOL = {
  name: 'set_blockout',
  description: 'The primary masses only. No canopies, no fins, no voids.',
  input_schema: {
    type: 'object',
    properties: {
      masses: { type: 'array', minItems: 1, maxItems: 5, items: MASS_SCHEMA },
      camera: { type: 'object', properties: { yawDeg: { type: 'number' }, pitchDeg: { type: 'number' }, fovDeg: { type: 'number' } } },
    },
    required: ['masses'],
  },
};

const WORLD = `Metres; y up, ground y=0; the front facade faces +z; x increases to the right; a box occupies x±w/2, z±d/2, y to y+h. Storey height by type: house 3.0 · apartments 3.1 · hotel 3.2 · school 3.6 · office 3.9 · lab 4.5. Every elevated element names a real support in "on" and genuinely sits on it — the audit looks underneath rather than reading the label. Nothing floats.`;

export async function buildBlockout(targetURL, inv, io) {
  io.step?.('Stage 2 of 4 — the primary masses…');
  const brief = `Build ONLY the primary masses of this building — the two to four inhabitable volumes the parti names. Nothing else: no canopies, no fins, no screens, no voids, no window frames. Those come later and are not your job.

THE PARTI: ${inv.parti}
STOREYS COUNTED: ${inv.storeys}
ENVELOPE: ${inv.envelope.w} × ${inv.envelope.d} × ${inv.envelope.h} m — your masses must fill it.

The primary features to account for, from the survey:
${(inv.features || []).filter(f => f.tier === 'primary').map(f => `- ${f.id}: ${f.what}, ${f.where} (${f.evidence})`).join('\n') || '- (the survey named none; use the parti)'}

Each mass declares in "covers" which of those feature ids it accounts for. Getting these few boxes into the right proportion and the right relationship matters more than anything that follows — everything later is added on top of what you set here, and it will not be moved.

${WORLD}`;
  const out = await claudeToolCall({
    content: [{ type: 'text', text: brief }, await claudeImage(targetURL)],
    tool: BLOCKOUT_TOOL, maxTokens: 4000,
  }, 'blockout');
  let masses = sanitizeMasses(out.masses);
  if (!masses) throw new Error('the blockout produced no volumes');
  masses = masses.map((m, i) => ({ ...m, tier: 'primary', covers: out.masses[i]?.covers || [] }));
  masses = fitToEnvelope(masses, inv.envelope);
  return { masses, camera: out.camera || inv.camera || null };
}

// ---------------- stage 3: detail, without touching the blockout ----------------

const DETAIL_TOOL = {
  name: 'add_detail',
  description: 'Append secondary and detail elements. The blockout is frozen and must not be restated.',
  input_schema: {
    type: 'object',
    properties: {
      added: { type: 'array', maxItems: 14, items: MASS_SCHEMA,
        description: 'NEW elements only — canopies, cantilevered slabs, entry frames, screens (as one element with a repeat block), and voids cut into the masses' },
    },
    required: ['added'],
  },
};

export async function addDetail(targetURL, inv, blockout, missing, io) {
  io.step?.('Stage 3 of 4 — what the drawing shows on top…');
  const brief = `The primary masses are built and FROZEN — do not restate them, do not move them, do not resize them. Your job is only what sits on and cuts into them.

THE FROZEN BLOCKOUT (ids you may build against, never alter):
${blockout.masses.map(m => `- ${m.id}: ${m.w}×${m.d}×${m.h} m at (${m.x}, ${m.y}, ${m.z})`).join('\n')}

STILL UNACCOUNTED FOR — every one of these was found in the drawing and nothing built so far represents it. Build each:
${missing.map(f => `- ${f.id}: ${f.what}, ${f.where}. ${f.count > 1 ? `There are ${f.count} of them — one element with repeat {axis, count: ${f.count}, step}.` : ''} (${f.evidence})`).join('\n') || '- (nothing missing; add only what the drawing plainly shows)'}

Rules for what you add:
- A canopy, a cantilevered slab, an entry frame: kind="slab" or "member", tier="secondary", sitting on a real blockout mass.
- A screen or run of fins: ONE element, kind="member", tier="detail", with repeat {axis, count, step}. Never loose boxes.
- A recess, loggia, undercut or opening you can see through: kind="void", placed to cut INTO the mass it belongs to.
- Never window frames, mullions, glazing bars, sills or panel joints. A glazed wall is a facade, not boxes.
- Each element declares in "covers" which feature ids it accounts for.

${WORLD}`;
  const out = await claudeToolCall({
    content: [{ type: 'text', text: brief }, await claudeImage(targetURL)],
    tool: DETAIL_TOOL, maxTokens: 5000,
  }, 'detail');
  const frozen = new Set(blockout.masses.map(m => m.id));
  const raw = (out.added || []).filter(m => !frozen.has(m.id));
  const added = sanitizeMasses(raw) || [];
  added.forEach((m, i) => { m.covers = raw[i]?.covers || []; });
  return added;
}

// ---------------- the coverage gate ----------------
// Every feature the survey found must be claimed by something built. This is
// the check that catches a build quietly dropping the loggia.

export function coverage(inv, masses) {
  const claimed = new Set();
  for (const m of masses) for (const c of m.covers || []) claimed.add(c);
  const features = inv.features || [];
  const missing = features.filter(f => !claimed.has(f.id));
  return { total: features.length, claimed: features.length - missing.length, missing };
}

// ---------------- the whole sculpt ----------------

export async function sculpt(rawTargetURL, io) {
  if (!hasClaude()) return null;
  const targetURL = await cropReferenceImage(rawTargetURL);

  const inv = await takeInventory(targetURL, io);
  io.inventory?.(inv);

  const block = await buildBlockout(targetURL, inv, io);
  await io.apply(block.masses, block.camera);

  // measure the blockout on its own: proportion is cheapest to fix now
  let blockScore = null;
  try { blockScore = (await scoreAgainst(targetURL, await io.snapshot())).score; } catch { /* unscored */ }
  io.stage?.('blockout', blockScore, block.masses.length);

  const cov0 = coverage(inv, block.masses);
  const detail = await addDetail(targetURL, inv, block, cov0.missing.filter(f => f.tier !== 'primary'), io);

  let masses = [...block.masses, ...detail];
  await io.apply(masses, block.camera);

  const cov = coverage(inv, masses);
  io.coverage?.(cov);

  return {
    masses, camera: block.camera, targetURL, inventory: inv, coverage: cov,
    reading: inv.parti,
    type: inv.buildingType && inv.buildingType !== 'unknown' ? inv.buildingType : null,
    floorsHint: inv.storeys || null,
    blockoutIds: block.masses.map(m => m.id),
  };
}

// ---------------- the correction, aimed at what is missing ----------------

const FIX_TOOL = {
  name: 'fix_scene',
  description: 'Return the complete corrected scene.',
  input_schema: {
    type: 'object',
    properties: {
      masses: { type: 'array', items: MASS_SCHEMA },
      camera: { type: 'object', properties: { yawDeg: { type: 'number' }, pitchDeg: { type: 'number' }, fovDeg: { type: 'number' } } },
    },
    required: ['masses'],
  },
};

export async function correctSculpt(targetURL, masses, camera, inv, io) {
  const shot = await io.snapshot();
  let measured = null;
  try { measured = await scoreAgainst(targetURL, shot); } catch { /* unscored */ }
  const cov = coverage(inv, masses);
  const geo = geometryAudit(masses);

  const content = [
    { type: 'text', text: 'THE DRAWING this must become:' },
    await claudeImage(targetURL),
    { type: 'text', text: 'THE CURRENT MODEL, from its declared camera:' },
    await claudeImage(shot),
  ];
  content.push({ type: 'text', text:
    `Current scene: ${JSON.stringify(masses)}\nCamera: ${JSON.stringify(camera || {})}\n${geo.summary}`
    + (cov.missing.length
      ? `\n\nSTILL MISSING from the drawing — the survey found these and nothing in the model claims them:\n`
        + cov.missing.map(f => `- ${f.id}: ${f.what}, ${f.where} (${f.evidence})`).join('\n')
      : `\n\nEvery surveyed feature is accounted for (${cov.claimed}/${cov.total}).`)
    + (measured ? '\n\n' + measurementReport(measured) : '')
    + `

Close the gap, in this order: build what is still missing; then correct proportions where the measurements name a difference; then relations — what sits on what, what is flush, what cantilevers. Leave alone what the numbers say is already close, and keep every element's repeat block and covers list.

Return the COMPLETE corrected scene. If nothing is missing and the measurements are good, return masses: [].` });

  const out = await claudeToolCall({
    system: 'You correct a box massing model against the architectural drawing it is meant to be. You are not designing — you are closing a measured, enumerated gap.',
    content, tool: FIX_TOOL, maxTokens: 8000,
    model: io.model || claudeConfig().model,
  }, 'correction');
  if (!out?.masses?.length) return null;
  const fixed = sanitizeMasses(out.masses);
  if (!fixed) return null;
  fixed.forEach((m, i) => { m.covers = out.masses[i]?.covers || m.covers || []; });
  return { masses: fixed, camera: out.camera || null };
}
