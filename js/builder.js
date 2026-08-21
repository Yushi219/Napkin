// The reconstruction protocol. Not "read the picture, stack some boxes" —
// the drawing is first decomposed into verifiable information, the model is
// built level by level against it, and nothing ships until two independent
// audits — deterministic geometry checks in code, and a visual reviewer with
// fresh eyes — both come back clean. The stages:
//
//   1  FORENSICS   crop + enlarged tiles → a locked inventory with recorded
//                  hypotheses (what is seen vs what is assumed, and how each
//                  assumption could be falsified)
//   2  LAYERED     the scene is submitted level by level; each stage gets its
//      BUILD       silhouette measured off an actual render before the next
//   3  GEOMETRY    code audits the solids: floaters, cyclic supports, bad
//      AUDIT       seats, interpenetration — graded blocker / major / minor
//   4  REVIEWER    an independent Claude call that has seen none of the
//                  build reasoning judges reference vs render, same grammar
//   5  CONVERGE    fix → re-audit → re-review, until no blockers and no
//                  majors remain or the round budget runs out
//
// The volumes stay a low-poly quad cage in state.masses the whole way — the
// same cage the parameter desk edits and the Rhino export ships for SubD.

import {
  MASS_SCHEMA as FULL_MASS_SCHEMA, sanitizeMasses, fitToEnvelope, claudeImage, pairPicture,
  massExtents, geometryAudit, cropReferenceImage, zoomTiles, silhouetteMetrics,
} from './interpret.js';
import { claudeToolCall, claudeTurn, hasClaude, claudeConfig } from './claudecore.js';

// Claude is not strict-validated the way OpenAI is, so demand only the core
// fields and let sanitizeMasses fill the rest with sane defaults.
const MASS_SCHEMA = { ...FULL_MASS_SCHEMA, required: ['id', 'w', 'd', 'h', 'x', 'y', 'z', 'on'] };

// ---------- the fast lane ----------
// Sixty seconds is the longest a person waits in front of this screen. The
// fast lane is ONE forced tool call: read the drawing, return the whole scene.
// The deep survey-and-audit protocol stays available as a mode for when
// fidelity is worth minutes. After the fast scene lands, quickCorrect runs
// one look-and-fix behind the live model — the user is already working.

const FAST_TOOL = {
  name: 'build_scene',
  description: 'Return the complete reconstruction of the drawing in one pass.',
  input_schema: {
    type: 'object',
    properties: {
      // Enumerating before numbering is the cheapest accuracy there is: the
      // levels list forces a read of the drawing before any box is placed,
      // and it costs nothing extra - same single call.
      levels: {
        type: 'array', minItems: 1,
        description: 'the storeys/tiers you can see, bottom to top, BEFORE placing any box',
        items: { type: 'object', properties: {
          index: { type: 'integer' },
          description: { type: 'string', description: 'what sits at this level and how it shifts, cantilevers or opens' },
          heightM: { type: 'number' },
        }, required: ['index', 'description'] },
      },
      reading: { type: 'string', description: '<=18 words - the design intent' },
      type: { type: 'string', enum: ['office', 'laboratory', 'residential', 'hotel', 'school'] },
      floorsHint: { type: 'integer' },
      envelope: { type: 'object', properties: { w: { type: 'number' }, d: { type: 'number' }, h: { type: 'number' } }, required: ['w', 'd', 'h'] },
      camera: { type: 'object', properties: { yawDeg: { type: 'number' }, pitchDeg: { type: 'number' }, fovDeg: { type: 'number' } }, required: ['yawDeg', 'pitchDeg'] },
      masses: { type: 'array', items: MASS_SCHEMA },
    },
    required: ['levels', 'reading', 'envelope', 'camera', 'masses'],
  },
};

const FAST_BRIEF = `Replicate the building in this drawing as boxes, faithfully — main massing and details both. Fill "levels" FIRST: read the drawing storey by storey, bottom to top, and describe what each level does before you place a single box. Then let the boxes obey that list - every level you named must exist, with the shifts, cantilevers and openings you described. Return it all in one build_scene call.

EVIDENCE. You are given the whole drawing plus enlarged halves. Count storey lines, mullions, slats, railings and doors in the enlargements - a counted line beats an impression. Detail the drawing shows and the boxes lack is the most common failure here: secondary volumes, canopies, recessed voids, open frames.

RULES. Metres; y up, ground y=0; front facade faces +z; x right; a box occupies x±w/2, z±d/2, y to y+h. kind=volume|slab|member; members 0.08-0.6 m thick for posts, beams and frames — an opening or roofless frame is built open, never a filled box. Storey height by type: house 3.0 · apartments 3.1 · hotel 3.2 · school 3.6 · office 3.9 · lab 4.5; h = storeys × that. State the envelope first in your head and make the boxes fill it. Camera: yawDeg 0 faces the front, positive walks right; pitchDeg above horizon.

ASSEMBLIES — this is what makes a reading read. Anything the drawing repeats is declared ONCE with "repeat": {axis, count, step}, never stamped out by hand. A slatted screen is one 0.2 m fin repeated 24 times at 0.9 m along x. A colonnade is one 0.4 m post repeated 6 times. Floor bands, louvres, mullions, balustrades, piers — all repeats. Count them off the drawing and give the real count and the real spacing; a screen with the wrong rhythm reads wrong even at the right size.

STATICS — the model must stand up, and it is checked. Every elevated element names its true support in "on"; touching elements share coordinates exactly. A volume needs at least 40% of its plan bearing on its support, or it is a cantilever and must say so AND be no deeper than a third of the supported span. A member never carries a volume — if a canopy or slab is held up, it rests on posts or on a volume, and the posts stand on the ground or on a slab. Nothing floats.`;

export async function fastBuild(rawTargetURL, io) {
  if (!hasClaude()) return null;
  io.step?.('Reading the drawing and building — fast lane…');
  const targetURL = await cropReferenceImage(rawTargetURL);
  const hint = io.hints?.inkAspect
    ? ` MEASURED (by code, trust it): the ink silhouette is ${io.hints.inkAspect.toFixed(2)}× as wide as tall — the composition seen from your camera must match.`
    : '';
  // Same one call, more to look at: the full drawing plus its halves at double
  // scale, where storey lines and thin members survive the vision grid.
  const tiles = await zoomTiles(targetURL);
  const content = [
    { type: 'text', text: FAST_BRIEF + hint },
    await claudeImage(targetURL),
  ];
  for (const t of tiles) {
    content.push({ type: 'text', text: t.label }, await claudeImage(t.url));
  }
  const out = await claudeToolCall({
    content, tool: FAST_TOOL, maxTokens: 6000,
  }, 'fast build');
  let masses = sanitizeMasses(out.masses);
  if (!masses) throw new Error('the fast build produced no volumes');
  masses = fitToEnvelope(masses, out.envelope);
  await io.apply(masses, out.camera || null);
  return {
    masses, camera: out.camera || null, reading: out.reading || 'Fast reconstruction.',
    type: out.type || null, floorsHint: Number.isFinite(+out.floorsHint) ? +out.floorsHint : null,
    targetURL,
  };
}

// One look, one correction, on the quick model — run after the fast scene is
// already on screen, so none of this time is waited on.
const CORRECT_TOOL = {
  name: 'correct_scene',
  description: 'Return the complete corrected scene, or an empty masses array if the model already matches.',
  input_schema: {
    type: 'object',
    properties: {
      masses: { type: 'array', items: MASS_SCHEMA },
      camera: { type: 'object', properties: { yawDeg: { type: 'number' }, pitchDeg: { type: 'number' }, fovDeg: { type: 'number' } } },
    },
    required: ['masses'],
  },
};

export async function quickCorrect(targetURL, masses, camera, io) {
  const shot = await io.snapshot();
  const pair = (await pairPicture(targetURL, shot)) || (await claudeImage(shot));
  const geo = geometryAudit(masses);
  // The structural audit rides along: the same pass that makes it look right
  // makes it stand up, instead of leaving the user to find both separately.
  const flagged = (io.auditFindings || []).filter(x => x.severity !== 'minor');
  const auditText = flagged.length
    ? '\n\nThe structural and code audit on this scene reports:\n'
      + flagged.map(x => `- [${x.severity}] ${x.domain}/${x.where}: ${x.issue} → ${x.fix}`).join('\n')
      + '\nFix these too, without losing the likeness.'
    : '';
  const out = await claudeToolCall({
    system: 'You correct a box reconstruction against its reference drawing. Left pane: the drawing. Right pane: the current model. Return the COMPLETE corrected masses array — every element, changed or not, preserving the repeat block on any element that has one. If the model already reads as the same building AND the audit is quiet, return masses: [].',
    content: [
      { type: 'text', text: 'Current scene: ' + JSON.stringify(masses) + '\n' + geo.summary },
      pair,
      { type: 'text', text: 'Judge relations, storey counts, repeated rhythms, openings, silhouette proportion, camera — then the structure. Correct what is wrong.' },
    ],
    tool: CORRECT_TOOL, maxTokens: 5000, model: claudeConfig().reviewerModel,
  }, 'self-check');
  if (!out?.masses?.length) return null;
  const fixed = sanitizeMasses(out.masses);
  return fixed ? { masses: fixed, camera: out.camera || null } : null;
}

// ---------- stage 1: forensics ----------

const FORENSICS_TOOL = {
  name: 'record_forensics',
  description: 'Record the locked inventory of the reference drawing.',
  input_schema: {
    type: 'object',
    properties: {
      projection: { type: 'string', enum: ['perspective', 'axonometric', 'elevation', 'plan', 'uncertain'] },
      buildingType: { type: 'string', enum: ['house', 'residential', 'office', 'laboratory', 'hotel', 'school', 'gallery', 'unknown'] },
      storeyHeightM: { type: 'number' },
      visibleStoreys: { type: 'integer' },
      envelope: { type: 'object', properties: { w: { type: 'number' }, d: { type: 'number' }, h: { type: 'number' } }, required: ['w', 'd', 'h'] },
      camera: { type: 'object', properties: { yawDeg: { type: 'number' }, pitchDeg: { type: 'number' }, fovDeg: { type: 'number' } }, required: ['yawDeg', 'pitchDeg'] },
      levels: { type: 'array', items: { type: 'object', properties: {
        index: { type: 'integer' }, elevationM: { type: 'number' }, heightM: { type: 'number' },
        description: { type: 'string' }, supportBelow: { type: 'string' },
      }, required: ['index', 'description'] } },
      features: { type: 'array', items: { type: 'object', properties: {
        id: { type: 'string' }, level: { type: 'integer' }, role: { type: 'string' },
        evidence: { type: 'string', description: 'what in the drawing shows this — line, hatch, shadow, count' },
      }, required: ['id', 'evidence'] } },
      hypotheses: { type: 'array', description: 'assumptions where the drawing is ambiguous', items: { type: 'object', properties: {
        claim: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        falsifiedBy: { type: 'string', description: 'what view or measurement would disprove it' },
      }, required: ['claim', 'confidence'] } },
      mustPreserve: { type: 'array', items: { type: 'string' } },
    },
    required: ['projection', 'visibleStoreys', 'envelope', 'camera', 'levels', 'features', 'hypotheses', 'mustPreserve'],
  },
};

async function forensics(targetURL, aidURL, io) {
  io.step?.('① Forensics — cropping, enlarging, recording hypotheses…');
  const tiles = await zoomTiles(targetURL);
  const content = [
    { type: 'text', text: `Survey this architectural reference before a modeller touches it. Work like a building surveyor: inventory the levels bottom to top, list every feature with the EVIDENCE that shows it (a counted line, a shadow, a hatch), and record every assumption as a hypothesis with its confidence and what would falsify it. Multi-view: the full drawing first, then enlarged halves for counting storey lines and thin members. Do not design. Do not simplify. What you miss here is lost for good.` },
    await claudeImage(targetURL),
    ...(await Promise.all(tiles.map(async t => [{ type: 'text', text: t.label }, await claudeImage(t.url)]))).flat(),
  ];
  if (aidURL && aidURL !== targetURL) {
    content.push({ type: 'text', text: 'A cleaned massing render derived from the drawing, for depth reading only — the drawing stays authoritative.' }, await claudeImage(aidURL));
  }
  return claudeToolCall({ content, tool: FORENSICS_TOOL, maxTokens: 6000 }, 'forensics');
}

// ---------- stage 4: the independent reviewer ----------

const REVIEW_TOOL = {
  name: 'report_review',
  description: 'Report the visual comparison of reference vs model.',
  input_schema: {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: ['pass', 'revise'] },
      findings: { type: 'array', items: { type: 'object', properties: {
        severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
        where: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' },
      }, required: ['severity', 'where', 'issue'] } },
    },
    required: ['verdict', 'findings'],
  },
};

async function independentReview(pairPic, forensicsReport, io, round) {
  io.step?.(`④ Independent visual review — round ${round}…`);
  return claudeToolCall({
    system: 'You are an independent design reviewer. You did not build this model and owe its author nothing. You compare the reference drawing (left) against the reconstruction render (right) and grade every deviation: blocker = the composition is structurally different; major = a clearly visible deviation in massing, levels, openings or viewpoint; minor = cosmetic. Judge against the drawing and the survey inventory only. If levels, silhouettes, cantilevers and openings all read the same, say pass.',
    content: [
      { type: 'text', text: 'Survey inventory of the reference:\n' + JSON.stringify(forensicsReport) },
      pairPic,
      { type: 'text', text: 'Left: the reference. Right: the reconstruction from its declared camera. Report.' },
    ],
    tool: REVIEW_TOOL, maxTokens: 3000, model: claudeConfig().reviewerModel,
  }, 'review');
}

// ---------- stages 2, 3, 5: the layered build with converging audits ----------

const BUILD_TOOLS = [
  { name: 'submit_level',
    description: 'Submit ONE level of the building, lowest first. Call once per level, in order, in a single reply. Each level is checked against the drawn silhouette before the next.',
    input_schema: { type: 'object', properties: {
      level: { type: 'integer' },
      elements: { type: 'array', items: MASS_SCHEMA },
      camera: { type: 'object', properties: { yawDeg: { type: 'number' }, pitchDeg: { type: 'number' }, fovDeg: { type: 'number' } } },
    }, required: ['level', 'elements'] } },
  { name: 'look',
    description: 'Render the whole model beside the reference and see the comparison.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'replace_scene',
    description: 'Replace the complete scene with a corrected full array after audits.',
    input_schema: { type: 'object', properties: {
      masses: { type: 'array', items: MASS_SCHEMA },
      camera: { type: 'object', properties: { yawDeg: { type: 'number' }, pitchDeg: { type: 'number' }, fovDeg: { type: 'number' } } },
    }, required: ['masses'] } },
  { name: 'finish',
    description: 'Ask to close. Refused while blockers or majors remain in either audit, or before the reviewer has seen the model.',
    input_schema: { type: 'object', properties: {
      reading: { type: 'string' }, type: { type: 'string' }, floorsHint: { type: 'number' },
    }, required: ['reading'] } },
];

const BUILD_SYSTEM = `You are reconstructing the surveyed building as a low-poly quad cage in a live scene — Rhino-style layered modelling, one level at a time, every stage verified.

THE PROTOCOL. Submit level 0 first, then each level above it, each with submit_level, all in one reply. Each level is measured against the drawing's silhouette before the next is trusted. Then look. Then fix what the audits name, with replace_scene, and look again. finish is refused until the geometry audit and the independent reviewer are both clean of blockers and majors.

RULES OF THE WORLD. Metres; y up, ground y=0; front facade faces +z; x right; a box occupies x±w/2, z±d/2, y to y+h. kind=volume for occupied masses, slab for plates, member for beams, posts and frames (0.08-0.6 m thick). Every elevated element names its true support in "on" — cantilevers included. Touching elements share coordinates exactly. Openings are built open: posts and beams, never a filled box. Use the survey's storey height; respect its envelope; preserve every mustPreserve feature; honour its hypotheses unless the render disproves them.

THE CAGE. Keep the composition editable: few, deliberate solids rather than many slivers. A tower is one cage box per articulation, not thirty.`;

export async function buildWithProtocol(rawTargetURL, io) {
  if (!hasClaude()) return null;

  // stage 0: crop the paper away so every later look is dense with drawing
  const targetURL = await cropReferenceImage(rawTargetURL);
  const survey = await forensics(targetURL, io.aidURL, io);
  io.audit?.(survey);

  const targetPic = await claudeImage(targetURL);
  const messages = [{ role: 'user', content: [
    { type: 'text', text: 'THE SURVEY (locked):\n' + JSON.stringify(survey) + '\n\nThe reference drawing:' },
    targetPic,
    { type: 'text', text: 'Begin the layered build: submit_level for every level, lowest first, in this reply.' },
  ] }];

  let masses = null, camera = survey.camera || null, finished = null;
  let looks = 0, reviews = 0, lastReview = null, staged = [];

  const applyScene = async next => {
    masses = sanitizeMasses(next) || masses;
    if (masses) await io.apply(masses, camera);
    return masses;
  };

  for (let turn = 0; turn < 12 && !finished; turn++) {
    const data = await claudeTurn({ system: BUILD_SYSTEM, messages, tools: BUILD_TOOLS }, 'builder');
    messages.push({ role: 'assistant', content: data.content });
    const calls = (data.content || []).filter(b => b.type === 'tool_use');
    if (!calls.length) break;

    const results = [];
    for (const call of calls) {
      const args = call.input || {};
      const reply = content => results.push({ type: 'tool_result', tool_use_id: call.id, content });

      if (call.name === 'submit_level') {
        staged = staged.filter(m => (m.level ?? 0) !== (args.level ?? 0)).concat(args.elements || []);
        if (args.camera) camera = args.camera;
        await applyScene(staged);
        staged = masses ? masses.slice() : staged;
        io.step?.(`② Level ${args.level} placed — checking the silhouette…`);
        const sil = await silhouetteMetrics(await io.snapshot());
        const audit = geometryAudit(masses, survey.envelope);
        reply(`Level ${args.level} staged (${(args.elements || []).length} elements; scene now ${masses?.length ?? 0}). `
          + (sil ? `Measured silhouette so far: aspect ${sil.aspect}, fill ${sil.fill}. ` : '')
          + audit.summary);
      } else if (call.name === 'replace_scene') {
        if (args.camera) camera = args.camera;
        await applyScene(args.masses);
        staged = masses ? masses.slice() : staged;
        io.step?.('⑤ Scene corrected — re-running the audits…');
        reply('Replaced. ' + geometryAudit(masses, survey.envelope).summary);
      } else if (call.name === 'look') {
        looks++;
        io.step?.(`③ Look ${looks} — geometry and visual audit…`);
        const shot = await io.snapshot();
        const pair = (await pairPicture(targetURL, shot)) || (await claudeImage(shot));
        const geo = geometryAudit(masses, survey.envelope);
        // three verdicts is a review, more is a filibuster — after that the
        // deterministic geometry audit alone decides
        if (reviews < 3) {
          lastReview = await independentReview(pair, survey, io, looks).catch(e => {
            console.warn('reviewer unavailable this round', e);
            return null;
          });
          reviews += lastReview ? 1 : 0;
        }
        const reviewText = lastReview
          ? `Independent reviewer: ${lastReview.verdict}. ` + (lastReview.findings || []).map(x => `[${x.severity}] ${x.where}: ${x.issue}${x.fix ? ' → ' + x.fix : ''}`).join('; ')
          : 'Independent reviewer unavailable this round.';
        reply([
          pair,
          { type: 'text', text: `Look ${looks}. Left the reference, right your model. ${geo.summary} ${reviewText} Fix blockers and majors with replace_scene, then look again.` },
        ]);
      } else if (call.name === 'finish') {
        const geo = geometryAudit(masses, survey.envelope);
        const reviewClean = lastReview && lastReview.verdict === 'pass'
          && !(lastReview.findings || []).some(x => x.severity !== 'minor');
        if (looks < 1) reply('Refused: nothing has been looked at yet.');
        else if (!geo.ok) reply('Refused — the geometry audit still holds blockers or majors. ' + geo.summary);
        else if (!reviewClean && reviews > 0 && reviews < 3 && turn < 8) reply('Refused — the independent reviewer has not passed the model yet. Fix the graded findings and look again.');
        else { finished = args || {}; reply('Converged.'); }
      } else {
        reply('Unknown tool.');
      }
    }
    messages.push({ role: 'user', content: results });
  }

  if (!masses) throw new Error('the protocol produced no volumes');
  masses = fitToEnvelope(masses, survey.envelope);
  return {
    masses, camera,
    reading: (finished && finished.reading) || 'Reconstructed by the survey-and-audit protocol.',
    type: (finished && finished.type) || (survey.buildingType !== 'unknown' ? survey.buildingType : null),
    floorsHint: Number.isFinite(+finished?.floorsHint) ? +finished.floorsHint : (survey.visibleStoreys || null),
    survey,
  };
}
