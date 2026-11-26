// Step 7: `npm run demo` (offline, no keys, under 60 s) and `npm run check` (tests, guard on every
// plan, secret scan of tree and history, README headings). Written before scripts/demo.mjs,
// scripts/check.mjs and src/check.js existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApprovalRecord } from '../src/approval.js';

const path = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const loadCheck = () => import('../src/check.js');

// --- demo ---------------------------------------------------------------------------

test('npm run demo: one command, exit 0 in under 60 s, no keys in its environment', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/FLAGSMITH|TOKEN|KEY|SECRET/i.test(k)));
  const started = Date.now();
  const r = spawnSync(process.execPath, [path('scripts/demo.mjs')], { encoding: 'utf8', env, cwd: path('.'), timeout: 60_000 });
  const ms = Date.now() - started;
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(ms < 60_000, `took ${ms} ms`);
  const out = r.stdout;
  // Every section says where its data comes from.
  assert.match(out, /RECORDED-REAL/);
  assert.match(out, /SCRIPTED/);
  // 1. planner output (recorded) accepted by the guard
  assert.match(out, /creatordigest_headline_dev_1/);
  assert.match(out, /guard: ACCEPTED/);
  // 2. scripted bad plans refused with the rule number
  for (const rule of ['G2', 'G6', 'G7', 'G9']) assert.match(out, new RegExp(`REFUSED.*${rule}`), rule);
  // 3. tampered approvals refused
  assert.match(out, /tampered.*REFUSED/i);
  // 4. apply to the fake server, CREATE then START
  assert.match(out, /experiment \d+ created, not started/);
  assert.match(out, /is running/);
  // 5. readouts: scripted sim_ traffic gives no winner; the real experiment is not ready yet
  assert.match(out, /no_clear_winner/);
  assert.match(out, /not_ready/);
  // network: loopback only
  assert.match(out, /network: \d+ requests?, all to 127\.0\.0\.1/);
  assert.doesNotMatch(out, /api\.flagsmith\.com/);
});

test('the demo never reads keys or local config', () => {
  const src = readFileSync(path('scripts/demo.mjs'), 'utf8');
  for (const forbidden of ['config.local', 'flagsmith.json', 'flagsmith.production.json', '.flagsmith-admin-token', 'process.env.FLAGSMITH']) {
    assert.ok(!src.includes(forbidden), forbidden);
  }
});

// --- README check ----------------------------------------------------------------------

test('checkReadme: needs a setup heading, a Flagsmith heading, the disclosures, and no placeholders', async () => {
  const { checkReadme } = await loadCheck();
  const good = '# X\n\n## Try it in 60 seconds\n\n## How Flagsmith is used\n\n## How this was built: AI-assisted\n\n## Before the start\n';
  assert.deepEqual(checkReadme(good), []);
  assert.match(checkReadme(good.replace('## Try it in 60 seconds', '## Overview')).join(' '), /setup/);
  assert.match(checkReadme(good.replace('## How Flagsmith is used', '## Usage')).join(' '), /Flagsmith/);
  assert.match(checkReadme(good.replace('## Before the start', '## History')).join(' '), /Before the start/);
  assert.match(checkReadme(good.replace('## How this was built: AI-assisted', '## Notes')).join(' '), /AI/);
  assert.match(checkReadme(`${good}\nTODO: link coming soon\n`).join(' '), /placeholder/);
});

test('the real README passes checkReadme', async () => {
  const { checkReadme } = await loadCheck();
  assert.deepEqual(checkReadme(readFileSync(path('README.md'), 'utf8')), []);
});

// --- guard on every plan ---------------------------------------------------------------------

test('checkPlans: every plan must pass; Production only with a valid committed CREATE approval', async () => {
  const { checkPlans } = await loadCheck();
  const root = mkdtempSync(join(tmpdir(), 'ep-check-plans-'));
  mkdirSync(join(root, 'plans', 'proposed'), { recursive: true });
  mkdirSync(join(root, 'approvals'));
  const valid = JSON.parse(readFileSync(path('fixtures/plans/valid-plan.json'), 'utf8'));
  const app = readFileSync(path('fixtures/app/experiment.mjs'), 'utf8');
  writeFileSync(join(root, 'plans', 'a.json'), JSON.stringify(valid));
  assert.deepEqual(checkPlans({ root, appSource: app }).problems, []);

  const prod = { ...structuredClone(valid), id: 'prod_one', environment: 'Production' };
  writeFileSync(join(root, 'plans', 'proposed', 'prod.json'), JSON.stringify(prod));
  assert.match(checkPlans({ root, appSource: app }).problems.join(' '), /prod_one.*G9/);

  writeFileSync(join(root, 'approvals', 'prod_one.create.json'), JSON.stringify(createApprovalRecord({ plan: prod, phase: 'create', approver: 'Ragul', now: new Date() })));
  assert.deepEqual(checkPlans({ root, appSource: app }).problems, []);

  const bad = { ...structuredClone(valid), id: 'bad_one', hypothesis: 'We will peek and stop early.' };
  writeFileSync(join(root, 'plans', 'bad.json'), JSON.stringify(bad));
  assert.match(checkPlans({ root, appSource: app }).problems.join(' '), /bad_one.*G7/);
  rmSync(root, { recursive: true, force: true });
});

// --- secret scan ---------------------------------------------------------------------------------

function gitRepo(files, { removeAfter = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ep-check-git-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  for (const name of removeAfter) {
    git('rm', '-q', name);
  }
  if (removeAfter.length) git('commit', '-q', '-m', 'two');
  return dir;
}

const PROD = 'ProdClientKey000000001';
// Secret-shaped test values are assembled at run time so this file never contains one literally
// (the real scan reads this file too).
const TOKEN_SHAPED = ['abcdEFGH', '0123456789abcdefABCDEF0123456789'].join('.');
const KEY_SHAPED = ['DevEnvKey', '4hT9qLm2Xw7Rz'].join('');

test('scanRepo: a clean repo passes; the committed production client key is allowed', async () => {
  const { scanRepo } = await loadCheck();
  const dir = gitRepo({ 'a.txt': 'hello', 'site/config.js': `export const FLAGSMITH_ENVIRONMENT_KEY = '${PROD}';` });
  assert.deepEqual(scanRepo({ dir, allowedKeys: [PROD] }).problems, []);
});

test('scanRepo: an admin-token-shaped string found even when it only lives in history', async () => {
  const { scanRepo } = await loadCheck();
  const dir = gitRepo({ 'a.txt': 'hello', 'old.txt': `token ${TOKEN_SHAPED}` }, { removeAfter: ['old.txt'] });
  const r = scanRepo({ dir, allowedKeys: [PROD] });
  assert.match(r.problems.join(' '), /admin-token shape.*old\.txt/);
  assert.ok(!r.problems.join(' ').includes(TOKEN_SHAPED), 'the value is never printed');
});

test('scanRepo: forbidden files in history, unknown 22-char keys, and exact known secrets', async () => {
  const { scanRepo } = await loadCheck();
  const secret = 'S3cretValueThatIsLong-xyz';
  const dir = gitRepo({ '.env': 'X=1', 'site/config.local.js': "export const K = 'abc';", 'b.js': `const k = '${KEY_SHAPED}';`, 'c.txt': `x ${secret} y` });
  const r = scanRepo({ dir, allowedKeys: [PROD], knownSecrets: { adminToken: secret } });
  const text = r.problems.join('\n');
  assert.match(text, /forbidden file.*\.env/);
  assert.match(text, /forbidden file.*config\.local\.js/);
  assert.match(text, /22-character key.*b\.js/);
  assert.match(text, /adminToken.*c\.txt/);
  assert.ok(!text.includes(secret) && !text.includes(KEY_SHAPED), 'values are never printed');
});

test('npm run check is wired to the real checker, not a stub', () => {
  const pkg = JSON.parse(readFileSync(path('package.json'), 'utf8'));
  assert.equal(pkg.scripts.check, 'node scripts/check.mjs');
  assert.equal(pkg.scripts.demo, 'node scripts/demo.mjs');
  const src = readFileSync(path('scripts/check.mjs'), 'utf8');
  for (const part of ['checkReadme', 'checkPlans', 'scanRepo', '--test']) assert.ok(src.includes(part), part);
  assert.match(src, /process\.exit(Code)?\s*=?\s*\(?.*1/);
});
