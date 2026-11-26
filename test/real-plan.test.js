// The real experiment's plan (plans/creatordigest_headline_1.json): Production, real web_ traffic
// only, fixed end. Production needs an explicit allow flag everywhere the guard runs (diff, approve,
// apply). Written before diff/approve accepted --allow-production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePlan } from '../src/plan.js';
import { checkPlan } from '../src/guard.js';

const path = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const PLAN_PATH = path('plans/creatordigest_headline_1.json');
const APP_PATH = path('site/app.js');
const CLI = path('src/cli.js');
const PLAN = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
const APP = readFileSync(APP_PATH, 'utf8');

test('the real plan: Production, web_ only, no scripted traffic, fixed end Sat 22:00 IST', () => {
  assert.deepEqual(validatePlan(PLAN), { ok: true, errors: [] });
  assert.equal(PLAN.environment, 'Production');
  assert.equal(PLAN.flag.key, 'creatordigest_headline');
  assert.deepEqual(PLAN.flag.variants.map((v) => v.key), ['control', 'variant_b']);
  assert.deepEqual(PLAN.split, { control: 50, variant_b: 50 });
  assert.deepEqual(PLAN.metric, { name: 'Early access clicks (creatordigest_headline)', event: 'cta_clicked', direction: 'up' });
  assert.deepEqual(PLAN.traffic, { real: true, scripted: false });
  assert.equal(PLAN.identity.prefixReal, 'web_');
  assert.equal(PLAN.stopRule.type, 'fixedEnd');
  assert.equal(Date.parse(PLAN.stopRule.value), Date.parse('2026-11-28T22:00+05:30'));
  assert.equal(PLAN.decisionRule.winProbabilityAtLeast, 0.95);
  assert.equal(PLAN.decisionRule.intervalExcludesZero, true);
});

test('guard against site/app.js: refused without allowProduction (G9 only), passes with it', () => {
  const without = checkPlan(PLAN, { appSource: APP });
  assert.equal(without.ok, false);
  assert.deepEqual(without.violations.map((v) => v.rule), ['G9']);
  assert.deepEqual(checkPlan(PLAN, { appSource: APP, allowProduction: true }), { ok: true, violations: [] });
});

test('committed site/config.js points at the real flag in Production', async () => {
  const config = await import('../site/config.js');
  assert.equal(config.FLAG_KEY, PLAN.flag.key);
  assert.equal(config.FLAGSMITH_ENVIRONMENT_NAME, PLAN.environment);
});

test('the scripted-traffic runner uses the local (Development) flag key, never the committed one', () => {
  const runner = readFileSync(path('scripts/simulate.mjs'), 'utf8');
  assert.match(runner, /localConfig\.FLAG_KEY/);
  assert.doesNotMatch(runner, /import\s*\{[^}]*FLAG_KEY[^}]*\}\s*from\s*'\.\.\/site\/config\.js'/);
});

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('pilot diff: a Production plan is refused without --allow-production', () => {
  const r = cli('diff', PLAN_PATH, '--app', APP_PATH, '--phase', 'create');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /G9/);
  assert.equal(r.stdout, '');
});

test('pilot diff --allow-production prints the CREATE diff with a Production warning first', () => {
  const r = cli('diff', PLAN_PATH, '--app', APP_PATH, '--phase', 'create', '--allow-production');
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.match(lines[0], /^PRODUCTION: /);
  assert.match(r.stdout, /CREATE flag creatordigest_headline/);
  assert.match(r.stdout, /environment Production/);
  assert.match(r.stdout, /plan sha256: [0-9a-f]{64}/);
  assert.match(r.stdout, /diff sha256: [0-9a-f]{64}/);
});

test('a Development diff has no Production warning (format unchanged)', () => {
  const r = cli('diff', path('plans/pilot_rehearsal_1.json'), '--app', APP_PATH, '--phase', 'start');
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /PRODUCTION/);
  assert.match(r.stdout, /diff sha256: 3144d47db3a35ce0548db04bbde036f34c37cec03ac99fa98c3004dc3ae96ec3/);
});

function session(lines) {
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  let out = '';
  output.on('data', (d) => { out += d; });
  input.end(lines.map((l) => `${l}\n`).join(''));
  return { input, output, text: () => out };
}

test('approve: a Production plan is refused without allowProduction and written with it', async () => {
  const { runApprove, parseArgv } = await import('../src/approve.js');
  const dir = mkdtempSync(join(tmpdir(), 'ep-approve-prod-'));
  const base = { planPath: PLAN_PATH, appPath: APP_PATH, phase: 'create', approvalsDir: dir, now: () => new Date('2026-11-26T12:00:00Z') };

  const no = session(['Ragul', 'yes']);
  assert.equal(await runApprove({ ...base, input: no.input, output: no.output, errorOutput: no.output }), 1);
  assert.match(no.text(), /G9/);
  assert.deepEqual(readdirSync(dir), []);

  const yes = session(['Ragul', 'yes']);
  assert.equal(await runApprove({ ...base, allowProduction: true, input: yes.input, output: yes.output, errorOutput: yes.output }), 0, yes.text());
  assert.match(yes.text(), /PRODUCTION: /);
  assert.deepEqual(readdirSync(dir), ['creatordigest_headline_1.create.json']);

  assert.equal(parseArgv(['p.json', '--app', 'a.js', '--phase', 'create']).allowProduction, false);
  assert.equal(parseArgv(['p.json', '--allow-production', '--app', 'a.js', '--phase', 'create']).allowProduction, true);
  assert.equal(parseArgv(['p.json', '--allow-production', '--app', 'a.js']).planPath, 'p.json');
});
