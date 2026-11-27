// Recording a headless `claude -p --output-format stream-json` run of the skill: every line is
// redacted (environment keys, the admin token, the account's credential expiry) before it is
// saved, and the token usage of each turn's result event is summed for the README.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KEY = ['abcDEF', 'ghi123', 'jklMNO', 'pqr4'].join('');      // 22 chars, like a client key
const TOKEN = ['tok', 'en', '.', 'secretvalue123456'].join('');

test('redactLine removes every secret, including JSON-escaped copies, and blanks credential_expires_at', async () => {
  const { redactLine } = await import('../src/transcript.js');
  const line = JSON.stringify({ type: 'user', text: `GET api/v1/environments/${KEY}/ with ${TOKEN}`, nested: JSON.stringify({ k: KEY }) });
  const out = redactLine(line, [KEY, TOKEN]);
  assert.ok(!out.includes(KEY) && !out.includes(TOKEN));
  assert.match(out, /<secret>/);
  const result = JSON.stringify({ type: 'result', credential_expires_at: '2026-12-01T00:00:00Z', usage: { output_tokens: 5 } });
  assert.equal(JSON.parse(redactLine(result, [])).credential_expires_at, '<redacted>');
});

test('redactLine leaves a line without secrets byte for byte', async () => {
  const { redactLine } = await import('../src/transcript.js');
  const line = '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}';
  assert.equal(redactLine(line, [KEY]), line);
});

test('loadSecrets reads environment keys from bindings and the token file, skipping missing files and short values', async () => {
  const { loadSecrets } = await import('../src/transcript.js');
  const dir = mkdtempSync(join(tmpdir(), 'secrets-'));
  try {
    writeFileSync(join(dir, 'flagsmith.json'), JSON.stringify({ project: 1, environment: KEY }));
    writeFileSync(join(dir, 'token'), `${TOKEN}\n`);
    const secrets = loadSecrets({ bindings: [join(dir, 'flagsmith.json'), join(dir, 'missing.json')], tokenFiles: [join(dir, 'token')] });
    assert.deepEqual(secrets.sort(), [KEY, TOKEN].sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sumUsage adds the usage and cost of each turn\'s result event', async () => {
  const { sumUsage } = await import('../src/transcript.js');
  const r = (i, cc, cr, o, cost) => ({ type: 'result', total_cost_usd: cost, num_turns: 2, usage: { input_tokens: i, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: o } });
  const total = sumUsage([r(10, 100, 1000, 50, 0.5), r(5, 20, 2000, 30, 0.25)]);
  assert.deepEqual(total, {
    turns: 2, apiRequests: 4, input_tokens: 15, cache_creation_input_tokens: 120, cache_read_input_tokens: 3000, output_tokens: 80,
    total_tokens: 3215, total_cost_usd: 0.75,
  });
});

// Found by `npm run check` on the real Development run: thinking-block signatures are long opaque
// base64, and runs of 22 letters and digits inside them look like environment keys to the scanner.
// They carry nothing a reader needs, so the recorder drops them (the thinking text is kept).
test('redactLine replaces thinking-block signatures and redacted-thinking data with placeholders', async () => {
  const { redactLine } = await import('../src/transcript.js');
  const blob = `${['A1b2C3d4E5f6', 'G7h8I9j0Kl'].join('')}/+${'x'.repeat(40)}`;   // built at run time: no key-like literal
  const line = JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'plan the next step', signature: blob },
    { type: 'redacted_thinking', data: blob },
    { type: 'text', text: 'done' },
  ] } });
  const out = redactLine(line, []);
  assert.ok(!out.includes(blob));
  const content = JSON.parse(out).message.content;
  assert.equal(content[0].signature, '<signature>');
  assert.equal(content[0].thinking, 'plan the next step');
  assert.equal(content[1].data, '<redacted_thinking>');
  assert.equal(content[2].text, 'done');
});
