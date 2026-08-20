// The one door to OpenAI. Every feature that used to speak to Claude speaks
// through here now — same prompts, same parsing, different wire format. It
// deliberately accepts the Anthropic-style body those callers already build
// (content blocks, a separate system field) and translates, so the calling
// code keeps its shape while the engine underneath is ChatGPT.

const clean = v => String(v ?? '').replace(/[^\x21-\x7E]/g, '');

export function gptConfig() {
  return {
    key: clean(localStorage.getItem('napkin_openai_key') || window.NAPKIN_CONFIG?.openaiKey || ''),
    model: clean(localStorage.getItem('napkin_openai_model') || window.NAPKIN_CONFIG?.openaiModel || 'gpt-5.1'),
  };
}
export function hasGPT() { return !!gptConfig().key; }

export async function gptError(res, tag) {
  let detail = '';
  try { const b = await res.json(); detail = b?.error?.message || ''; } catch { /* not JSON */ }
  return new Error(`${tag} ${res.status}${detail ? ': ' + detail : ''}`);
}

// Anthropic content block -> OpenAI content part
const toPart = c => c.type === 'image'
  ? { type: 'image_url', image_url: { url: `data:${c.source.media_type};base64,${c.source.data}` } }
  : { type: 'text', text: c.text ?? String(c) };

// body: { model?, max_tokens, system?, messages: [{role, content: string|blocks[]}] }
// returns { text, stopReason } — the shape the old parsing code expects.
export async function gptVisionCompat(body, tag = 'gpt') {
  const { key, model } = gptConfig();
  if (!key) throw new Error(tag + ': no OpenAI key — add one in the settings');
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: body.system });
  for (const m of body.messages || []) {
    messages.push({
      role: m.role,
      content: Array.isArray(m.content) ? m.content.map(toPart) : m.content,
    });
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model, messages, max_completion_tokens: body.max_tokens || 2000 }),
  });
  if (!res.ok) throw await gptError(res, tag);
  const data = await res.json();
  const choice = data.choices?.[0];
  return { text: choice?.message?.content || '', stopReason: choice?.finish_reason || null };
}
