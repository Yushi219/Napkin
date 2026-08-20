// ChatGPT as the builder engine. The loop is identical to the Claude builder —
// place, look, correct against the live scene — only the wire format differs:
// OpenAI's chat API takes function tools, returns tool_calls with stringified
// arguments, and cannot carry an image inside a tool result, so each look's
// comparison picture follows as the next user message instead.
import {
  BUILDER_BRIEF, BUILDER_TOOLS, sanitizeMasses, fitToEnvelope,
  pairPicture, massExtents,
} from './interpret.js';

const clean = v => String(v ?? '').replace(/[^\x21-\x7E]/g, '');

export function openaiConfig() {
  return {
    key: clean(localStorage.getItem('napkin_openai_key') || window.NAPKIN_CONFIG?.openaiKey || ''),
    model: clean(localStorage.getItem('napkin_openai_model') || window.NAPKIN_CONFIG?.openaiModel || 'gpt-5.1'),
  };
}
export function hasGPT() { return !!openaiConfig().key; }

async function gptError(res) {
  let detail = '';
  try { const b = await res.json(); detail = b?.error?.message || ''; } catch { /* not JSON */ }
  return new Error(`gpt builder ${res.status}${detail ? ': ' + detail : ''}`);
}

const TOOLS = BUILDER_TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

export async function gptBuildMasses(dataURL, io) {
  const { key, model } = openaiConfig();
  if (!key) return null;

  const hint = io.hints?.inkAspect
    ? `\n\nMEASURED FROM THE DRAWING (by code, trust it): the ink silhouette is ${io.hints.inkAspect.toFixed(2)} times as wide as it is tall. From your declared camera the finished composition must fill that same proportion - check it on every look.`
    : '';
  const messages = [
    { role: 'system', content: BUILDER_BRIEF + hint },
    { role: 'user', content: [
      { type: 'text', text: 'Here is the sketch. Begin with set_scene.' },
      { type: 'image_url', image_url: { url: dataURL } },
    ] },
  ];

  let masses = null, camera = null, finished = null, looks = 0;

  for (let turn = 0; turn < 9 && !finished; turn++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: 'auto', max_completion_tokens: 5000 }),
    });
    if (!res.ok) throw await gptError(res);
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
        reply(masses
          ? 'Scene set: ' + masses.length + ' volumes. ' + massExtents(masses) + ' Audit the boxes against your own prose - every storey count and dimension you stated must actually appear - then look.'
          : 'No usable boxes in that input.');
      } else if (name === 'update_scene') {
        if (masses) {
          const byId = new Map(masses.map(m => [m.id, m]));
          for (const e of args.edit || []) { const m = byId.get(e.id); if (m && e.set) Object.assign(m, e.set); }
          for (const id of args.remove || []) { const i = masses.findIndex(m => m.id === id); if (i >= 0) masses.splice(i, 1); }
          for (const a of args.add || []) masses.push(a);
          masses = sanitizeMasses(masses) || masses;
          if (args.camera) camera = args.camera;
          io.step?.('ChatGPT corrected the composition…');
          await io.apply(masses, camera);
        }
        reply(masses ? 'Applied. ' + massExtents(masses) + ' look to see the result.' : 'There is no scene yet - set_scene first.');
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
            : shot } },
        ] });
      } else if (name === 'finish') {
        finished = args || {};
        reply('Done.');
      } else {
        reply('Unknown tool.');
      }
    }
    messages.push(...followUps);
  }

  if (!masses) throw new Error('the gpt builder produced no volumes');
  masses = fitToEnvelope(masses, finished && finished.envelope);
  return {
    masses, camera,
    reading: (finished && finished.reading) || 'Built by the ChatGPT builder loop.',
    type: (finished && finished.type) || null,
    floorsHint: finished && Number.isFinite(+finished.floorsHint) ? +finished.floorsHint : null,
  };
}
