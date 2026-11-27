#!/usr/bin/env node
// One turn of a recorded headless Claude Code run with the Track 04 skill loaded.
//   node scripts/skill-turn.mjs <run-name> "<message>"      (first call starts the session, later calls resume it)
//   node scripts/skill-turn.mjs <run-name> --totals          (prints the token totals so far)
// The person runs approvals (node src/approve.js ...) in their own terminal between turns; this
// script never approves anything, and the agent it starts is denied approve.js.
// Saves transcripts/<run-name>/turn-NN.jsonl (stream-json, redacted line by line), session.json
// and usage.json (summed from each turn's result event).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSecrets, redactLine, sumUsage } from '../src/transcript.js';

const [run, ...rest] = process.argv.slice(2);
if (!run || !/^[\w.-]+$/.test(run) || rest.length === 0) {
  console.error('usage: node scripts/skill-turn.mjs <run-name> "<message>" | --totals');
  process.exit(2);
}
const dir = join('transcripts', run);
mkdirSync(dir, { recursive: true });

function totals() {
  const results = readdirSync(dir).filter((f) => /^turn-\d+\.jsonl$/.test(f)).sort().flatMap((f) => readFileSync(join(dir, f), 'utf8')
    .split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.type === 'result'));
  const sum = sumUsage(results);
  writeFileSync(join(dir, 'usage.json'), `${JSON.stringify({ perTurn: results.map((r) => ({ num_turns: r.num_turns, total_cost_usd: r.total_cost_usd, usage: r.usage })), total: sum }, null, 2)}\n`);
  return sum;
}
if (rest[0] === '--totals') { console.log(JSON.stringify(totals(), null, 2)); process.exit(0); }

const message = rest.join(' ');
const statePath = join(dir, 'session.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { sessionId: randomUUID(), turns: 0 };
const turn = state.turns + 1;

// The agent may read and plan, run the pilot (every write is gated by the human's approval file),
// the status helper and read-only CLI commands. It may never approve, print a credential, call the
// API directly, create a flag outside the pilot, or read files that hold keys.
const ALLOWED = [
  // Write is allowed in the working directory, and Edit deny rules (which also govern Write) block every
  // path but plans/. Tested 2026-11-27: a path-scoped Edit(/plans/**) allow did not let Write create a
  // new file in dontAsk mode, while Edit(approvals/**) as a deny did block Write.
  'Skill', 'Read', 'Glob', 'Grep', 'Write', 'Edit(/plans/**)',
  'Bash(node src/cli.js *)',
  'Bash(node skills/flagsmith-experiment-rollout/scripts/status.mjs *)',
  'Bash(flagsmith feature list *)', 'Bash(flagsmith feature get *)', 'Bash(flagsmith flag get *)',
  'Bash(flagsmith evaluate *)', 'Bash(flagsmith config *)', 'Bash(flagsmith auth status *)',
];
const DENIED = [
  'Bash(node src/approve.js *)', 'Bash(npm run approve *)', 'Bash(npm *)',
  'Bash(flagsmith auth token *)', 'Bash(flagsmith auth token)', 'Bash(flagsmith api *)', 'Bash(flagsmith login *)',
  'Bash(flagsmith feature create *)', 'Bash(flagsmith feature update *)', 'Bash(flagsmith feature delete *)',
  'Bash(flagsmith feature variant *)', 'Bash(flagsmith flag update *)', 'Bash(flagsmith environment *)',
  'Read(site/config.local.js)', 'Read(**/*.local.js)', 'Read(../flagsmith.json)', 'Read(../flagsmith.production.json)',
  'Read(../.flagsmith-admin-token)', 'Edit(approvals/**)', 'WebFetch', 'WebSearch',
  ...['src', 'skills', 'scripts', 'test', 'fixtures', 'site', 'transcripts', '.github', '.claude-plugin', '.claude', 'node_modules']
    .map((d) => `Edit(/${d}/**)`),
  'Edit(/*.json)', 'Edit(/*.md)', 'Edit(/.gitignore)', 'Edit(/.gitattributes)', 'Edit(/LICENSE)', 'Edit(**/*.local.js)', 'Edit(//**/flagsmith*.json)',
];

const args = [
  '-p', message,
  '--plugin-dir', '.',
  '--output-format', 'stream-json', '--verbose',
  // acceptEdits: file edits in the working directory run (the Edit deny rules above still win, so only
  // plans/ is writable). Anything else that would prompt is denied, because nobody answers prompts.
  // (dontAsk was tried first: it refused every Write, even with a Write allow rule.)
  '--permission-mode', 'acceptEdits',
  '--permission-prompts', 'none',
  '--max-budget-usd', '5',
  // Only the tools the skill needs, and no MCP servers: less fixed context per request.
  '--tools', 'Skill,Read,Glob,Grep,Write,Edit,Bash',
  '--strict-mcp-config',
  ...(state.turns === 0 ? ['--session-id', state.sessionId] : ['--resume', state.sessionId]),
  '--allowedTools', ...ALLOWED,
  '--disallowedTools', ...DENIED,
];

const localKeys = (() => {
  try { return [...readFileSync('site/config.local.js', 'utf8').matchAll(/['"]([A-Za-z0-9]{20,})['"]/g)].map((m) => m[1]); } catch { return []; }
})();
const secrets = [...loadSecrets({ bindings: ['../flagsmith.json', '../flagsmith.production.json'], tokenFiles: ['../.flagsmith-admin-token'] }), ...localKeys];

const file = join(dir, `turn-${String(turn).padStart(2, '0')}.jsonl`);
writeFileSync(file, '');
writeFileSync(join(dir, `turn-${String(turn).padStart(2, '0')}.message.txt`), `${message}\n`);
console.log(`turn ${turn} of session ${state.sessionId} -> ${file}`);

// Subscription login only, never an API key: key variables are left out of the child's
// environment, and the run stops if Claude Code still reports an API key source at init.
const KEY_VARS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !KEY_VARS.has(k)));
const child = spawn(process.env.CLAUDE_BIN || 'claude', args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
let stoppedForKey = false;
let buffer = '';
let result = null;
const show = (event) => {
  if (event.type === 'assistant') {
    for (const c of event.message?.content ?? []) {
      if (c.type === 'text' && c.text.trim()) console.log(`\n[agent] ${c.text.trim()}`);
      if (c.type === 'tool_use') console.log(`  · ${c.name}: ${String(c.input?.command ?? c.input?.file_path ?? c.input?.skill ?? JSON.stringify(c.input)).slice(0, 200)}`);
    }
  }
  if (event.type === 'system' && event.subtype === 'init' && event.apiKeySource !== 'none') {
    stoppedForKey = true;
    console.error(`STOPPED: Claude Code reports apiKeySource ${JSON.stringify(event.apiKeySource)}; this run must use the subscription login only.`);
    child.kill();
  }
  if (event.type === 'result') result = event;
};
child.stdout.on('data', (d) => {
  buffer += d;
  let i;
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = redactLine(buffer.slice(0, i).replace(/\r$/, ''), secrets);
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    appendFileSync(file, `${line}\n`);
    try { show(JSON.parse(line)); } catch { /* not JSON */ }
  }
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });
child.on('close', (code) => {
  if (buffer.trim()) appendFileSync(file, `${redactLine(buffer.trim(), secrets)}\n`);
  if (stderr.trim()) writeFileSync(join(dir, `turn-${String(turn).padStart(2, '0')}.stderr.txt`), `${redactLine(stderr, secrets)}\n`);
  writeFileSync(statePath, `${JSON.stringify({ ...state, turns: turn }, null, 2)}\n`);
  const t = totals();
  if (result) {
    const u = result.usage ?? {};
    console.log(`\nturn ${turn}: exit ${code}, ${result.num_turns} model requests, input ${u.input_tokens} + cache write ${u.cache_creation_input_tokens} + cache read ${u.cache_read_input_tokens} + output ${u.output_tokens} tokens (subscription login; Claude Code's notional cost $${result.total_cost_usd} is an estimate, not a charge)`);
    if (result.permission_denials?.length) console.log(`permission denials: ${result.permission_denials.map((p) => `${p.tool_name}: ${String(p.tool_input?.command ?? p.tool_input?.file_path ?? '').slice(0, 120)}`).join('; ')}`);
  } else {
    console.log(`\nturn ${turn}: exit ${code}, no result event${stderr ? `: ${redactLine(stderr, secrets).slice(0, 300)}` : ''}`);
  }
  console.log(`run so far: ${t.turns} turns, ${t.total_tokens} tokens`);
  process.exitCode = stoppedForKey ? 1 : code ?? 1;
});
