// Size budget and command checks for skills/flagsmith-experiment-rollout.
// Token counts here are an Estimate (characters / 4), not a tokenizer count; the measured token
// count of a real run is in the README (from the claude -p JSON usage).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { splitSkill } from './helpers/skill-spec.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'skills', 'flagsmith-experiment-rollout');
const read = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const estimateTokens = (text) => Math.ceil(text.length / 4);
const docs = () => {
  const refs = existsSync(join(DIR, 'references')) ? readdirSync(join(DIR, 'references')).map((f) => join('references', f)) : [];
  return ['SKILL.md', ...refs].map((rel) => ({ rel, text: read(join(DIR, rel)) }));
};

// Read-only subcommands seen in `flagsmith --help` (v2.0.0, 2026-11-27) AND run for real on
// Development (notes/flagsmith-calls.md). The skill may tell the agent to run only these.
const VERIFIED_READS = ['api', 'config', 'environment list', 'feature list', 'feature get', 'flag get', 'evaluate', 'auth status'];
const NO_JSON_NEEDED = ['login', '--help', '--version'];
// Writes or secret-printing commands: allowed in the text only as a prohibition.
const FORBIDDEN = /^flagsmith (auth token|logout|feature (create|update|delete|variant)|flag (update|enable|disable|delete|reorder)|segment|environment (create|update|delete|clone|key)|project|organisation|init)\b|^flagsmith api\b.*-X\s*(POST|PUT|PATCH|DELETE)/;
const PROHIBITION = /\b(never|not|no|don't|forbidden)\b/i;

// Every `...` span and every line of a ``` block, with the line it sits on.
function commands(text) {
  const out = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('```')) { inBlock = !inBlock; continue; }
    if (inBlock) { out.push({ cmd: line.trim(), line }); continue; }
    for (const m of line.matchAll(/`([^`]+)`/g)) out.push({ cmd: m[1].trim(), line });
  }
  return out;
}

test('SKILL.md is at most 120 lines and its body is at most ~2,000 tokens (spec: under 500 lines, under 5,000 tokens)', () => {
  const text = read(join(DIR, 'SKILL.md'));
  const lines = text.trimEnd().split('\n').length;
  assert.ok(lines <= 120, `SKILL.md has ${lines} lines`);
  const body = splitSkill(text).body;
  assert.ok(estimateTokens(body) <= 2000, `body is about ${estimateTokens(body)} tokens`);
});

test('the name and description stay small (they are loaded for every session; spec: ~100 tokens)', () => {
  const fm = splitSkill(read(join(DIR, 'SKILL.md'))).frontmatter;
  const description = fm.match(/^description: (.*)$/m)?.[1] ?? '';
  assert.ok(description.length <= 600, `description is ${description.length} characters`);
});

test('each reference file is focused: under ~2,500 tokens, and links only one level deep', () => {
  for (const { rel, text } of docs().filter((d) => d.rel !== 'SKILL.md')) {
    assert.ok(estimateTokens(text) <= 2500, `${rel} is about ${estimateTokens(text)} tokens`);
    for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
      assert.ok(/^https?:/.test(m[1]) || !m[1].includes('/'), `${rel} links ${m[1]}: keep references one level deep`);
    }
  }
});

test('every file SKILL.md points to exists (references/ and scripts/)', () => {
  const text = read(join(DIR, 'SKILL.md'));
  const paths = new Set([...text.matchAll(/\b((?:references|scripts)\/[\w.-]+)/g)].map((m) => m[1]));
  assert.ok(paths.size >= 3, 'SKILL.md uses progressive disclosure (points to references and scripts)');
  for (const p of paths) assert.ok(existsSync(join(DIR, p)) && statSync(join(DIR, p)).isFile(), `${p} is missing`);
  for (const f of readdirSync(join(DIR, 'references'))) assert.ok(text.includes(`references/${f}`), `references/${f} is never pointed to from SKILL.md`);
});

test('every flagsmith command the skill tells the agent to run is a verified read and uses --json or --jq', () => {
  let seen = 0;
  for (const { rel, text } of docs()) {
    for (const { cmd, line } of commands(text)) {
      if (!/^flagsmith\s/.test(cmd)) continue; // a bare `flagsmith` is the program's name, not a command
      if (FORBIDDEN.test(cmd)) {
        assert.match(line, PROHIBITION, `${rel}: ${cmd} appears outside a prohibition`);
        continue;
      }
      if (/\btransport\b/i.test(line)) continue; // describes what the pilot's code runs, not a command for the agent
      if (PROHIBITION.test(line) && !/--jq\b|--json\b/.test(cmd)) continue; // named in a "do not" line, not an instruction to run it
      const sub = cmd.replace(/^flagsmith\s+/, '');
      if (NO_JSON_NEEDED.some((s) => sub === s || sub.startsWith(`${s} `))) continue;
      assert.ok(VERIFIED_READS.some((s) => sub === s || sub.startsWith(`${s} `)), `${rel}: "${cmd}" is not a verified read command`);
      assert.match(cmd, /--jq\b|--json\b/, `${rel}: "${cmd}" must use --jq (or --json)`);
      seen += 1;
    }
  }
  assert.ok(seen >= 5, `only ${seen} flagsmith commands found`);
});

test('every pilot command and option in the skill exists in src/cli.js', () => {
  const cli = read(join(ROOT, 'src', 'cli.js'));
  const usage = Object.fromEntries([...cli.matchAll(/usage: npm run pilot -- (\w+) ([^']*)'/g)].map((m) => [m[1], m[2]]));
  assert.ok(Object.keys(usage).length >= 4);
  let seen = 0;
  for (const { rel, text } of docs()) {
    for (const { cmd } of commands(text)) {
      const m = cmd.match(/^node src\/cli\.js (\w+)(.*)$/);
      if (!m) continue;
      assert.ok(usage[m[1]], `${rel}: pilot command ${m[1]} does not exist`);
      for (const opt of m[2].match(/--[a-z-]+/g) ?? []) assert.ok(usage[m[1]].includes(opt), `${rel}: ${m[1]} has no option ${opt}`);
      seen += 1;
    }
  }
  assert.ok(seen >= 4, `only ${seen} pilot commands found`);
});

test('approve.js appears only as something the human runs in their own terminal, never piped', () => {
  let seen = 0;
  for (const { rel, text } of docs()) {
    for (const line of text.split('\n').filter((l) => l.includes('approve.js'))) {
      seen += 1;
      assert.match(line, /\b(human|person|you)\b.*terminal|terminal.*\b(human|person|you)\b|never/i, `${rel}: ${line}`);
      assert.doesNotMatch(line, /\|\s*node src\/approve\.js|echo .*approve|yes \|/, `${rel}: ${line}`);
    }
  }
  assert.ok(seen >= 1);
});

test('the status helper prints a usage line and exits non-zero without arguments', () => {
  const r = spawnSync(process.execPath, [join(DIR, 'scripts', 'status.mjs')], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage: node skills\/flagsmith-experiment-rollout\/scripts\/status\.mjs <plan/);
});
