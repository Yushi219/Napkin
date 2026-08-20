// ChatGPT as the builder engine. The loop is identical to the Claude builder —
// place, look, correct against the live scene — only the wire format differs:
// OpenAI's chat API takes function tools, returns tool_calls with stringified
// arguments, and cannot carry an image inside a tool result, so each look's
// comparison picture follows as the next user message instead.
import {
  BUILDER_BRIEF, BUILDER_TOOLS, sanitizeMasses, fitToEnvelope,
  pairPicture, massExtents, sceneDiagnostics,
} from './interpret.js';

import { gptConfig as openaiConfig, hasGPT, gptError, reasoningArgs } from './gptcore.js';
export { openaiConfig, hasGPT };

const TOOLS = BUILDER_TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema, strict: t.name !== 'finish' },
}));

const AUDIT_SCHEMA = {
  name: 'architectural_reference_audit', strict: true,
  schema: {
    type: 'object', additionalProperties: false,
    properties: {
      projection: { type: 'string', enum: ['perspective', 'axonometric', 'elevation', 'plan', 'uncertain'] },
      buildingType: { type: 'string', enum: ['house', 'residential', 'office', 'laboratory', 'hotel', 'school', 'gallery', 'unknown'] },
      storeyHeightM: { type: 'number', minimum: 2.4, maximum: 5.5 },
      visibleStoreys: { type: 'integer', minimum: 1, maximum: 40 },
      envelope: {
        type: 'object', additionalProperties: false,
        properties: { w: { type: 'number' }, d: { type: 'number' }, h: { type: 'number' } },
        required: ['w', 'd', 'h'],
      },
      camera: {
        type: 'object', additionalProperties: false,
        properties: { yawDeg: { type: 'number' }, pitchDeg: { type: 'number' }, fovDeg: { type: 'number' } },
        required: ['yawDeg', 'pitchDeg', 'fovDeg'],
      },
      levels: {
        type: 'array', minItems: 1, maxItems: 16,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            index: { type: 'integer' }, elevationM: { type: 'number' }, heightM: { type: 'number' },
            description: { type: 'string' }, supportBelow: { type: 'string' },
          }, required: ['index', 'elevationM', 'heightM', 'description', 'supportBelow'],
        },
      },
      elements: {
        type: 'array', minItems: 1, maxItems: 32,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string' }, level: { type: 'integer' },
            role: { type: 'string', enum: ['volume', 'podium', 'bar', 'wing', 'core', 'slab', 'canopy', 'roof', 'balcony', 'frame', 'beam', 'column', 'post', 'screen', 'railing'] },
            support: { type: 'string' }, description: { type: 'string' },
          }, required: ['id', 'level', 'role', 'support', 'description'],
        },
      },
      mustPreserve: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string' } },
      uncertainties: { type: 'array', maxItems: 8, items: { type: 'string' } },
    },
    required: ['projection', 'buildingType', 'storeyHeightM', 'visibleStoreys', 'envelope', 'camera', 'levels', 'elements', 'mustPreserve', 'uncertainties'],
  },
};

async function auditReference(dataURL, aidURL, io) {
  const { key, model, reasoning } = openaiConfig();
  io.step?.('Pass 2 — auditing levels, supports and openings…');
  const content = [
    { type: 'text', text: `Act as the survey pass before a Rhino modeller begins. Read the authoritative architectural reference level-by-level, bottom to top. Inventory every occupied mass, slab, cantilever, open frame, beam and post that materially changes the silhouette or negative space. Separate what you can see from what you are estimating. Do not design, simplify, or invent. Use countable floor lines and repeated elements as the ruler. The output becomes a locked checklist for a second model, so omissions here cannot be recovered later.` },
    { type: 'image_url', image_url: { url: dataURL, detail: 'high' } },
  ];
  if (aidURL && aidURL !== dataURL) content.push(
    { type: 'text', text: 'Secondary cleaned study image follows. It can clarify depth, but the first image remains authoritative.' },
    { type: 'image_url', image_url: { url: aidURL, detail: 'high' } },
  );
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model, messages: [{ role: 'user', content }],
      response_format: { type: 'json_schema', json_schema: AUDIT_SCHEMA },
      max_completion_tokens: 6000,
      ...reasoningArgs(model, reasoning),
    }),
  });
  if (!res.ok) throw await gptError(res, 'reference audit');
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('reference audit returned no checklist');
  return JSON.parse(text);
}

export async function gptBuildMasses(dataURL, io) {
  const { key, model, reasoning } = openaiConfig();
  if (!key) return null;

  const audit = await auditReference(dataURL, io.aidURL, io);
  io.audit?.(audit);

  const hint = io.hints?.inkAspect
    ? `\n\nMEASURED FROM THE DRAWING (by code, trust it): the ink silhouette is ${io.hints.inkAspect.toFixed(2)} times as wide as it is tall. From your declared camera the finished composition must fill that same proportion - check it on every look.`
    : '';
  // The napkin drawing is the authority; the cleaned concept render, when
  // there is one, rides along as an aid. Chasing the aid instead of the
  // drawing is how detail quietly went missing.
  const firstContent = [
    { type: 'text', text: `Here is the authoritative reference and its LOCKED VISUAL AUDIT. Build every listed level and must-preserve feature. If the audit contains uncertainty, choose the least inventive geometry consistent with the image.\n\nLOCKED VISUAL AUDIT:\n${JSON.stringify(audit)}` },
    { type: 'image_url', image_url: { url: dataURL, detail: 'high' } },
  ];
  if (io.aidURL && io.aidURL !== dataURL) {
    firstContent.push(
      { type: 'text', text: 'And a cleaned massing render derived from that sketch, as an aid for reading the volumes. Wherever the two disagree, THE SKETCH WINS.' },
      { type: 'image_url', image_url: { url: io.aidURL, detail: 'high' } });
  }
  const messages = [
    { role: 'system', content: BUILDER_BRIEF + hint },
    { role: 'user', content: firstContent },
  ];

  let masses = null, camera = null, finished = null, looks = 0;

  for (let turn = 0; turn < 14 && !finished; turn++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model, messages, tools: TOOLS, tool_choice: 'auto', parallel_tool_calls: false,
        max_completion_tokens: 7000, ...reasoningArgs(model, reasoning),
      }),
    });
    if (!res.ok) throw await gptError(res, 'gpt builder');
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) break;
    messages.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) break;                    // it stopped talking - take what stands

    const followUps = [];                        // images ride behind the tool replies
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* malformed - treated as empty */ }
      const name = call.function.name;
      const reply = text => messages.push({ role: 'tool', tool_call_id: call.id, content: text });

      if (name === 'set_scene') {
        masses = sanitizeMasses(args.masses) || masses;
        if (args.camera) camera = args.camera;
        io.step?.('ChatGPT placed ' + (masses?.length || 0) + ' volumes…');
        if (masses) await io.apply(masses, camera);
        const diagnostic = sceneDiagnostics(masses);
        reply(masses
          ? 'Scene set: ' + masses.length + ' elements. ' + diagnostic.summary + ' Compare this inventory with the locked audit, correct constraint errors, then look.'
          : 'No usable boxes in that input.');
      } else if (name === 'replace_scene') {
        if (args.masses) {
          masses = sanitizeMasses(args.masses) || masses;
          if (args.camera) camera = args.camera;
          io.step?.('ChatGPT corrected the composition…');
          await io.apply(masses, camera);
        }
        const diagnostic = sceneDiagnostics(masses);
        reply(masses ? 'Full scene replaced. ' + diagnostic.summary + ' Look again.' : 'There is no scene yet - set_scene first.');
      } else if (name === 'look') {
        looks++;
        io.step?.('Rendering for ChatGPT — look ' + looks + '…');
        const shot = await io.snapshot();
        const pair = await pairPicture(dataURL, shot);
        reply('Rendered. The comparison picture follows in the next message.');
        followUps.push({ role: 'user', content: [
          { type: 'text', text: 'Look ' + looks + ': the target drawing on the left, your model on the right, from your declared camera. '
            + massExtents(masses)
            + (looks >= 4
              ? ' That was your last look - correct anything left and finish.'
              : ' Compare pane against pane: relations, storey counts, openings, silhouette proportion, camera.') },
          { type: 'image_url', image_url: { url: pair
            ? 'data:' + pair.source.media_type + ';base64,' + pair.source.data
            : shot, detail: 'high' } },
        ] });
      } else if (name === 'finish') {
        const diagnostic = sceneDiagnostics(masses);
        if (looks < 2) reply('Finish rejected: you must inspect at least two rendered comparisons. Look, correct, and look again.');
        else if (!diagnostic.ok) reply('Finish rejected: resolve these deterministic constraint errors first. ' + diagnostic.summary);
        else { finished = args || {}; reply('Done.'); }
      } else {
        reply('Unknown tool.');
      }
    }
    messages.push(...followUps);
  }

  if (!masses) throw new Error('the gpt builder produced no volumes');
  masses = fitToEnvelope(masses, finished && finished.envelope);
  masses = sanitizeMasses(masses);
  return {
    masses, camera,
    reading: (finished && finished.reading) || 'Built by the ChatGPT builder loop.',
    type: (finished && finished.type) || null,
    floorsHint: finished && Number.isFinite(+finished.floorsHint) ? +finished.floorsHint : null,
  };
}
