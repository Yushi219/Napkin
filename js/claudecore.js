// The Claude door. The reconstruction protocol runs on Claude again; the
// OpenAI path stays wired as a quiet fallback, so a device with either key
// still works. Two calling styles live here:
//   aiVisionCompat(body, tag)  — text/vision one-shots (chat edits, brief
//                                writer, decompose): Claude first, GPT second.
//   claudeToolCall(...)        — a single forced tool call whose input comes
//                                back schema-shaped: the audit, the reviewer.
import { gptVisionCompat, hasGPT } from './gptcore.js';

const clean = v => String(v ?? '').replace(/[^\x21-\x7E]/g, '');

export function claudeConfig() {
  return {
    key: clean(localStorage.getItem('napkin_claude_key') || window.NAPKIN_CONFIG?.anthropicKey || ''),
    model: clean(localStorage.getItem('napkin_claude_model') || window.NAPKIN_CONFIG?.anthropicModel || 'claude-opus-5'),
    // grading a pair image is a quick judgement, not deep spatial construction
    reviewerModel: clean(localStorage.getItem('napkin_claude_reviewer_model') || window.NAPKIN_CONFIG?.anthropicReviewerModel || 'claude-sonnet-5'),
  };
}
export function hasClaude() { return !!claudeConfig().key; }

export async function claudeError(res, tag) {
  let detail = '';
  try { const b = await res.json(); detail = b?.error?.message || b?.message || ''; } catch { /* not JSON */ }
  return new Error(`${tag} ${res.status}${detail ? ': ' + detail : ''}`);
}

const HEADERS = key => ({
  'content-type': 'application/json',
  'x-api-key': key,
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
});

// body: { max_tokens, system?, messages } in Anthropic block format already.
export async function claudeVisionCompat(body, tag = 'claude') {
  const { key, model } = claudeConfig();
  if (!key) throw new Error(tag + ': no Anthropic key');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: HEADERS(key),
    body: JSON.stringify({ model, max_tokens: body.max_tokens || 2000, system: body.system, messages: body.messages }),
  });
  if (!res.ok) throw await claudeError(res, tag);
  const data = await res.json();
  return {
    text: (data.content || []).map(b => b.text || '').join(''),
    stopReason: data.stop_reason || null,
  };
}

// Claude when there is a Claude key, ChatGPT when there is not.
export async function aiVisionCompat(body, tag = 'ai') {
  if (hasClaude()) return claudeVisionCompat(body, tag);
  if (hasGPT()) return gptVisionCompat(body, tag);
  throw new Error(tag + ': no AI key — add one in ⚙');
}
export function hasAnyAI() { return hasClaude() || hasGPT(); }

// One forced tool call: Claude MUST answer through the named tool, so the
// input comes back already shaped by the schema — the audit checklist and
// the reviewer report both ride this.
export async function claudeToolCall({ system, content, tool, maxTokens = 6000, model: modelOverride }, tag) {
  const { key, model } = claudeConfig();
  if (!key) throw new Error(tag + ': no Anthropic key');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: HEADERS(key),
    body: JSON.stringify({
      model: modelOverride || model, max_tokens: maxTokens, system,
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) throw await claudeError(res, tag);
  const data = await res.json();
  const use = (data.content || []).find(b => b.type === 'tool_use' && b.name === tool.name);
  if (!use) throw new Error(tag + ': the model did not answer through the tool');
  return use.input;
}

// An open multi-turn tool conversation for the builder itself.
export async function claudeTurn({ system, messages, tools, maxTokens = 7000 }, tag) {
  const { key, model } = claudeConfig();
  if (!key) throw new Error(tag + ': no Anthropic key');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: HEADERS(key),
    body: JSON.stringify({ model, max_tokens: maxTokens, system, tools, messages }),
  });
  if (!res.ok) throw await claudeError(res, tag);
  return res.json();
}
