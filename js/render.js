import { aiVisionCompat as gptVisionCompat } from './claudecore.js';
import { hasGPT } from './gptcore.js';
// Nano Banana Pro (Gemini image) — img2img, following the proven promptitect
// call pattern: x-goog-api-key header, role-labelled image parts (INPUT IMAGE
// preserves geometry/camera; references are style-only), responseModalities
// ['Image'], retry on 429/503. Local stylization remains the no-key fallback.

export const STYLES = [
  { id: 'photo', label: 'Golden hour', prompt: 'photorealistic architectural photograph at golden hour, warm low sun, long soft shadows, people on the plaza, shallow depth of field, editorial quality' },
  { id: 'water', label: 'Watercolor', prompt: 'loose architectural watercolor concept sketch, warm paper, ink linework with soft washes, generous white space' },
  { id: 'clay', label: 'Clay model', prompt: 'physical white museum-board architecture model photographed in a studio, soft daylight, matte board texture, minimal context figures' },
  { id: 'night', label: 'Night', prompt: 'cinematic night photograph, interior floors glowing warmly, deep blue sky, wet street reflections, city bokeh' },
  { id: 'winter', label: 'Winter', prompt: 'photorealistic snowy morning, low pale sun, snow on setbacks and roofs, breath in the air, quiet streets' },
];

function cfg() {
  return {
    key: String(localStorage.getItem('napkin_gemini_key') || window.NAPKIN_CONFIG?.geminiKey || '').replace(/[^!-~]/g, ''),
    model: localStorage.getItem('napkin_gemini_model') || window.NAPKIN_CONFIG?.geminiModel || 'gemini-3-pro-image-preview',
  };
}
export function hasGemini() { return !!cfg().key; }

const strip64 = d => d.split(',')[1];
const mimeOf = d => d.slice(5, d.indexOf(';'));

async function fetchWithRetry(url, init, attempts = 2, timeoutMs = 200000) {
  let last = null;
  for (let a = 0; a < attempts; a++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try { res = await fetch(url, { ...init, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
    if (res.status !== 429 && res.status !== 503) return res;
    last = res;
    if (a < attempts - 1) await new Promise(r => setTimeout(r, 1400 * (a + 1)));
  }
  return last;
}

async function callGemini(model, key, parts) {
  const res = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { responseModalities: ['Image'] },
      }),
    });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text.replace(/^\)\]\}'\s*/, '')); } catch { data = { error: { message: text.slice(0, 300) } }; }
  if (!res.ok) throw new Error(`${res.status}: ${data?.error?.message || 'gemini request failed'}`);
  const rparts = (data.candidates || []).flatMap(c => c.content?.parts || []);
  for (const p of rparts) {
    const d = p.inlineData?.data || p.inline_data?.data;
    if (d) return `data:image/png;base64,${d}`;
  }
  const said = rparts.map(p => p.text).filter(Boolean).join(' ');
  throw new Error(said ? `text instead of image: ${said.slice(0, 160)}` : 'no image in response');
}

// ---- Step 1 of the pipeline: sketch -> clean 3D massing image ----
// A rough napkin sketch is hard for a vision model to measure. Nano Banana
// first redraws it as a clean grey study model photographed straight on;
// reading THAT is far more reliable than reading the raw scribble.
export async function conceptModelImage({ sketchDataURL, typeLabel }) {
  const { key, model } = cfg();
  if (!key) return null;
  const brief = `Rebuild the INPUT sketch as a clean white 3D ARCHITECTURAL MODEL of a ${typeLabel.toLowerCase()} — an exact Rhino replica screenshotted, not a loose study.

Requirements:
- REPLICATE, do not redesign and do not simplify. Same composition, same viewpoint and camera angle as the sketch, same proportions, same number of volumes in the same arrangement. Nothing added, nothing dropped.
- KEEP THE DETAILS: every window band, mullion rhythm, loggia, recessed void, roofless frame, canopy, plinth and setback the sketch shows must appear in the model, in place, at the same size. If the sketch shows daylight through an opening, the model shows daylight through it.
- Render as a matte white/light-grey museum-board model with crisp edges, soft studio daylight, subtle contact shadows, plain neutral background. No entourage, trees, people, sky, colour, materials or text.
- Every volume boundary unambiguous — a reader must be able to count the boxes, the storeys, and see which volume sits on or cantilevers past which.
- Keep the sketch's own viewpoint; the whole building inside the frame with a small margin.`;
  const parts = [
    { text: brief },
    { text: 'INPUT SKETCH: preserve its composition and viewpoint exactly.' },
    { inline_data: { mime_type: mimeOf(sketchDataURL), data: strip64(sketchDataURL) } },
  ];
  return await callGemini(model, key, parts);
}

// ---- Auto prompt writer (promptitect's 10-category taxonomy) ----
// The user types one sentence; Claude expands it into a full architectural
// visualization brief. Weak prompts are exactly why img2img "just copies".
const PROMPT_CATEGORIES = [
  'archDescription — view type, drawing type, building typology',
  'preservation — what geometry/camera/massing must be kept identical',
  'materiality — facade materials, finishes, textures, cladding',
  'lighting — time of day, sun angle, shadows, interior glow',
  'atmosphere — sky, weather, season, mood',
  'context — surrounding buildings, urban fabric, ground plane',
  'entourage — people, vehicles, street furniture (scale-giving)',
  'landscape — trees, planting, paving',
  'qualityControl — realism, lens, resolution, what to avoid',
];

export async function writeRenderPrompt(userLine, ctx) {
  if (!hasGPT()) return null;
  const { text: written } = await gptVisionCompat({
      max_tokens: 900,
      messages: [{
        role: 'user',
        content: `You write the instruction for a MATERIAL AND LIGHT PASS over an existing 3D render. This is image EDITING, not image generation: another image (the render) supplies the building and the camera, and your text supplies only surfaces, light and atmosphere.

The building: a ${ctx.typeLabel.toLowerCase()}, ${ctx.floors} storeys, ${ctx.heightM} m tall, ${ctx.structure} structure, GFA ${ctx.gfa} m².
The designer said: "${userLine || 'make it look real'}"
Requested style: ${ctx.styleHint || 'photorealistic'}
Weather to match: ${ctx.weather || 'clear'}. Setting: ${ctx.setting || 'city'}.

Write ONE flowing paragraph of 90-140 words covering only: materials and finishes, lighting quality, atmosphere and sky character, ground-plane and planting treatment, entourage, and quality control.

ABSOLUTE PROHIBITIONS — breaking any of these ruins the render:
- Never describe the viewpoint, camera height, angle, lens, framing or composition. Do not write "eye-level", "street view", "aerial", "wide-angle", "looking up", "from across the plaza", or any similar phrase. The camera is already fixed by the image.
- Never describe the building's shape, height in storeys, silhouette, massing, setbacks, or how many volumes it has. The form is already fixed by the image.
- Never say the building is centred, fully visible, or how much of it is in frame. If the image shows part of it, the result shows exactly that same part.
- Do not invent surrounding buildings that are not in the image; you may only describe how the ones already there are finished.

Write instead about: what the surfaces are made of, how the light falls, what the sky and air look like, what is on the ground, and the technical quality (sharp focus, realistic reflections, no text or watermarks).
Return ONLY the paragraph, no preamble, no quotes, no headings.`,
      }],
  }, 'prompt writer');
  return (written || '').trim();
}

export async function renderImage({ snapshot, styleId, userPrompt, refDataURL, typeLabel }) {
  const style = STYLES.find(s => s.id === styleId) || STYLES[0];
  // A fully-written brief (from writeRenderPrompt) replaces the canned style
  // line entirely — that is what stops the model from just echoing the input.
  const core = userPrompt && userPrompt.length > 140
    ? userPrompt
    : `Re-render the INPUT IMAGE as: ${style.prompt}. The building is a ${typeLabel.toLowerCase()}.${userPrompt ? ` Art direction: ${userPrompt}.` : ''}`;
  const brief = [
    'TASK: repaint IMAGE 1. This is an edit of that exact picture, not a new picture.',
    'Keep every edge where it is: same silhouette, same storey lines, same setbacks, same surrounding buildings, same horizon, same crop, same camera. If the building is cut off by the frame in IMAGE 1, it stays cut off in the same place.',
    'Change ONLY the surface treatment, materials, lighting, sky and small entourage. Adding, removing, re-centring, re-framing or re-proportioning anything is a failure.',
    'If the text below and IMAGE 1 ever disagree about form, viewpoint or framing, IMAGE 1 wins.',
    '',
    core,
    '',
    'Image role rules:',
    '- Image 1: INPUT IMAGE / STRUCTURE SOURCE. Preserve its geometry, camera view, massing, proportions and spatial organization exactly.',
    '- The input is an untextured grey/clay STUDY MODEL, not a finished building. Its flat placeholder surfaces MUST be replaced with real architectural materials, glazing with reflections, visible floor levels and mullions.',
    '- The input has no context: ADD a believable site — ground plane, neighbouring buildings, sky, planting, and a few people for scale — unless the prompt says otherwise.',
    '- Do NOT return the input image unchanged, and do not return a grey clay model. The result must read as a finished architectural visualization.',
    refDataURL ? '- Image 2: STYLE REFERENCE ONLY — it is NOT the building. Take only its palette, materials, light and photographic mood. Copying its shape, height, window grid, camera or composition is a failure.' : '',
    '- Keep the final image the same aspect ratio as the INPUT IMAGE.',
  ].filter(Boolean).join('\n');

  const { key, model } = cfg();
  if (key) {
    const parts = [
      { text: brief },
      { text: 'IMAGE 1 — THE BUILDING TO RENDER. Its geometry, storey count, proportions and camera are the ground truth and must be preserved exactly.' },
      { inline_data: { mime_type: 'image/png', data: strip64(snapshot) } },
    ];
    if (refDataURL) {
      parts.push({ text: 'IMAGE 2 — STYLE REFERENCE ONLY. Not the building. Palette, materials, light and mood only; never its shape, height or camera.' });
      parts.push({ inline_data: { mime_type: mimeOf(refDataURL), data: strip64(refDataURL) } });
    }
    try {
      return { url: await callGemini(model, key, parts), engine: model };
    } catch (e) {
      console.warn('primary gemini model failed:', e.message);
      if (model !== 'gemini-2.5-flash-image') {
        try { return { url: await callGemini('gemini-2.5-flash-image', key, parts), engine: 'gemini-2.5-flash-image' }; }
        catch (e2) { console.warn('fallback gemini failed:', e2.message); }
      }
      return { url: await stylizeLocal(snapshot, style.id), engine: `local (Gemini: ${e.message.slice(0, 90)})` };
    }
  }
  return { url: await stylizeLocal(snapshot, style.id), engine: 'local stylization' };
}

// ---- local fallback: tone + grain + vignette over the snapshot ----

async function stylizeLocal(snapshot, styleId) {
  const img = new Image();
  await new Promise(r => { img.onload = r; img.src = snapshot; });
  const w = 900, h = Math.round(900 * img.height / img.width);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');

  const filters = {
    photo: 'saturate(1.15) contrast(1.06) brightness(1.02) sepia(0.14)',
    water: 'saturate(0.85) contrast(0.92) brightness(1.08) blur(0.6px)',
    clay: 'saturate(0.35) contrast(1.02) brightness(1.05)',
    night: 'saturate(1.2) contrast(1.25) brightness(0.55) hue-rotate(-18deg)',
    winter: 'saturate(0.7) contrast(1.02) brightness(1.12) hue-rotate(8deg)',
  };
  c.filter = filters[styleId] || filters.photo;
  c.drawImage(img, 0, 0, w, h);
  c.filter = 'none';

  const tones = {
    photo: ['#ffd9a055', '#7a512f22'], water: ['#fdf6e855', '#b8a67a22'],
    clay: ['#ffffff33', '#9a938222'], night: ['#0d1b3355', '#f2b04833'], winter: ['#dfe9f244', '#9db3c422'],
  };
  const [t1, t2] = tones[styleId] || tones.photo;
  const grad = c.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, t1); grad.addColorStop(1, t2);
  c.fillStyle = grad;
  c.fillRect(0, 0, w, h);

  const vg = c.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.85);
  vg.addColorStop(0, '#00000000'); vg.addColorStop(1, '#26231e3d');
  c.fillStyle = vg;
  c.fillRect(0, 0, w, h);

  const noise = c.createImageData(w, h);
  for (let i = 0; i < noise.data.length; i += 4) {
    const v = 118 + Math.random() * 20;
    noise.data[i] = noise.data[i + 1] = noise.data[i + 2] = v;
    noise.data[i + 3] = 10;
  }
  const ncv = document.createElement('canvas');
  ncv.width = w; ncv.height = h;
  ncv.getContext('2d').putImageData(noise, 0, 0);
  c.drawImage(ncv, 0, 0);

  return cv.toDataURL('image/jpeg', 0.9);
}
