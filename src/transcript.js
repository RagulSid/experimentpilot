// Recording a headless Claude Code run of the skill (`claude -p --output-format stream-json`).
// Each line is one JSON event. Before a line is saved, every known secret (environment keys from
// the bindings, the admin token) is replaced, and the account's sign-in expiry is blanked (as in
// src/planner.js). Usage comes from each turn's final `result` event.
import { readFileSync } from 'node:fs';

const ACCOUNT_FIELDS = ['credential_expires_at'];
const MIN_SECRET_LENGTH = 12;

export function loadSecrets({ bindings = [], tokenFiles = [] } = {}) {
  const out = new Set();
  const add = (v) => { if (typeof v === 'string' && v.trim().length >= MIN_SECRET_LENGTH) out.add(v.trim()); };
  for (const file of bindings) {
    try { add(JSON.parse(readFileSync(file, 'utf8')).environment); } catch { /* missing or unreadable: nothing to redact */ }
  }
  for (const file of tokenFiles) {
    try { add(readFileSync(file, 'utf8')); } catch { /* missing */ }
  }
  return [...out];
}

export function redactLine(line, secrets) {
  let out = line;
  for (const s of secrets) out = out.split(s).join('<secret>');
  const account = ACCOUNT_FIELDS.some((k) => out.includes(`"${k}"`));
  const thinking = out.includes('"signature"') || out.includes('"redacted_thinking"');
  if (account || thinking) {
    try {
      const o = JSON.parse(out);
      for (const k of ACCOUNT_FIELDS) if (k in o) o[k] = '<redacted>';
      // Thinking-block signatures are opaque base64 that only the model API reads; inside them, runs
      // of 22 letters and digits look like environment keys to the secret scan. The text is kept.
      for (const c of Array.isArray(o.message?.content) ? o.message.content : []) {
        if (c?.type === 'thinking' && typeof c.signature === 'string') c.signature = '<signature>';
        if (c?.type === 'redacted_thinking' && typeof c.data === 'string') c.data = '<redacted_thinking>';
      }
      out = JSON.stringify(o);
    } catch { /* not a single JSON object: leave it */ }
  }
  return out;
}

const FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];

export function sumUsage(results) {
  const total = { turns: results.length, apiRequests: 0, ...Object.fromEntries(FIELDS.map((f) => [f, 0])), total_tokens: 0, total_cost_usd: 0 };
  for (const r of results) {
    total.apiRequests += r.num_turns ?? 0;
    for (const f of FIELDS) total[f] += r.usage?.[f] ?? 0;
    total.total_cost_usd += r.total_cost_usd ?? 0;
  }
  total.total_tokens = FIELDS.reduce((n, f) => n + total[f], 0);
  total.total_cost_usd = Math.round(total.total_cost_usd * 1e6) / 1e6;
  return total;
}
