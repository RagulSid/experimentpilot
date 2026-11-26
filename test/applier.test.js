// Applier, two phases: guard -> verifyApproval(phase) -> dry run, or apply.
// CREATE makes flag, variation(s), metric, experiment and never starts it.
// START only starts an existing, not-yet-started experiment of this plan.
// Both confirm the environment name through the API before any write.
// Nothing here talks to the real Flagsmith.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeFlagsmith } from './helpers/fake-flagsmith.js';
import { createApprovalRecord } from '../src/approval.js';
import { createClient, ROUTES } from '../src/flagsmith-client.js';

const PLAN_PATH = fileURLToPath(new URL('../fixtures/plans/valid-plan.json', import.meta.url));
const APP_PATH = fileURLToPath(new URL('../fixtures/app/experiment.mjs', import.meta.url));
const CLI_PATH = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const VALID_PLAN = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
const APP_SOURCE = readFileSync(APP_PATH, 'utf8');
const TOKEN = 'test-token-DO-NOT-LEAK-0123456789abcdef';
const ENV_KEY = 'FakeEnvKey000000000001';
const PROJECT_ID = 55988;
const NOW = new Date('2026-11-26T08:00:00.000Z');

const plan = () => structuredClone(VALID_PLAN);
const approve = (p, phase = 'create') => JSON.stringify(createApprovalRecord({ plan: p, phase, approver: 'Ragul', now: NOW }));
const load = async () => (await import('../src/applier.js')).applyPlan;

async function fakeAndClient(fakeOptions = {}) {
  const fake = await startFakeFlagsmith({ token: TOKEN, environmentKey: ENV_KEY, projectId: PROJECT_ID, ...fakeOptions });
  const logs = [];
  const log = (line) => logs.push(line);
  const client = createClient({ baseUrl: fake.baseUrl, env: { FLAGSMITH_ADMIN_TOKEN: TOKEN }, projectId: PROJECT_ID, environmentKey: ENV_KEY, log });
  return { fake, client, logs, log };
}

const noSecrets = (text) => {
  assert.ok(!String(text).includes(TOKEN), `token leaked: ${text}`);
  assert.ok(!String(text).includes(ENV_KEY), `environment key leaked: ${text}`);
};
const writes = (fake) => fake.requests.filter((q) => q.method !== 'GET');

const CREATE_ROUTES = ['GET environment', 'GET features (search)', 'GET experiments (list)', 'GET metrics (list)', 'POST features', 'POST mv-options', 'POST experiment-metrics', 'POST experiments'];

// --- order and refusals before any network -------------------------------------

test('refuses a plan with the wrong shape before anything else', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient();
  try {
    const p = plan();
    delete p.metric;
    const r = await applyPlan({ plan: p, phase: 'create', approvalText: null, appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.status, 'refused');
    assert.equal(r.stage, 'plan');
    assert.equal(fake.requests.length, 0);
  } finally { await fake.close(); }
});

test('refuses an unknown phase', async () => {
  const applyPlan = await load();
  for (const phase of [undefined, 'all', 'CREATE']) {
    const r = await applyPlan({ plan: plan(), phase, approvalText: approve(plan()), appSource: APP_SOURCE });
    assert.equal(r.status, 'refused');
    assert.equal(r.stage, 'phase');
  }
});

test('runs the guard first: a guard failure is reported even without an approval', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient();
  try {
    const p = plan();
    p.split = { control: 60, variant_b: 50 };
    const r = await applyPlan({ plan: p, phase: 'create', approvalText: null, appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.stage, 'guard');
    assert.ok(r.reasons.some((x) => x.startsWith('G3')), JSON.stringify(r.reasons));
    assert.equal(fake.requests.length, 0);
  } finally { await fake.close(); }
});

test('re-runs the guard itself: an approved plan that breaks a rule is still refused', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient();
  try {
    const p = plan();
    p.environment = 'Production';
    const r = await applyPlan({ plan: p, phase: 'create', approvalText: approve(p), appSource: APP_SOURCE, apply: true, client, log, skipGuard: true });
    assert.equal(r.stage, 'guard');
    assert.ok(r.reasons.some((x) => x.startsWith('G9')));
    assert.equal(fake.requests.length, 0);
  } finally { await fake.close(); }
});

test('refuses without the approval for this phase, and when the plan changed after approval', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient();
  try {
    const none = await applyPlan({ plan: plan(), phase: 'create', approvalText: null, appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(none.stage, 'approval');
    const wrongPhase = await applyPlan({ plan: plan(), phase: 'start', approvalText: approve(plan(), 'create'), createApprovalText: approve(plan(), 'create'), appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(wrongPhase.stage, 'approval');
    const edited = plan();
    edited.hypothesis += ' Edited.';
    const changed = await applyPlan({ plan: edited, phase: 'create', approvalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(changed.stage, 'approval');
    assert.match(changed.reasons[0], /plan changed after approval/);
    assert.equal(fake.requests.length, 0);
  } finally { await fake.close(); }
});

test('START also needs a still-valid CREATE approval', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient();
  try {
    const r = await applyPlan({ plan: plan(), phase: 'start', approvalText: approve(plan(), 'start'), createApprovalText: null, appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.stage, 'approval');
    assert.match(r.reasons[0], /create/i);
    assert.equal(fake.requests.length, 0);
  } finally { await fake.close(); }
});

test('dry run by default for both phases: no HTTP call, prints that phase\'s diff', async () => {
  const applyPlan = await load();
  const { fake, client, logs, log } = await fakeAndClient();
  try {
    for (const apply of [undefined, false, 'true', 1]) {
      const r = await applyPlan({ plan: plan(), phase: 'create', approvalText: approve(plan()), appSource: APP_SOURCE, apply, client, log });
      assert.equal(r.status, 'dry_run', `apply=${JSON.stringify(apply)} must not apply`);
      assert.equal(r.diff.length, 3);
    }
    const s = await applyPlan({ plan: plan(), phase: 'start', approvalText: approve(plan(), 'start'), createApprovalText: approve(plan()), appSource: APP_SOURCE, client, log });
    assert.equal(s.status, 'dry_run');
    assert.equal(fake.requests.length, 0);
    const text = logs.join('\n');
    assert.match(text, /DRY RUN/);
    assert.match(text, /--apply/);
    assert.match(text, /Phase CREATE/);
    assert.match(text, /Phase START/);
  } finally { await fake.close(); }
});

// --- CREATE ----------------------------------------------------------------------

test('CREATE (fake server): env check, existence checks, flag, keyed variation, metric, experiment; never starts', async () => {
  const applyPlan = await load();
  const { fake, client, logs, log } = await fakeAndClient();
  try {
    const r = await applyPlan({ plan: plan(), phase: 'create', approvalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    assert.equal(r.phase, 'create');
    assert.deepEqual(fake.requests.map((q) => q.route), CREATE_ROUTES);
    assert.ok(!fake.requests.some((q) => q.route === 'POST start'), 'CREATE never starts');
    assert.deepEqual(r.created.map((c) => [c.what, c.id]), [['flag', 303389], ['variation', 36697], ['metric', 422], ['experiment', 457]]);
    assert.equal(r.experimentStatus, 'created');

    const body = (route) => fake.requests.find((q) => q.route === route).body;
    assert.deepEqual(fake.requests.find((q) => q.route === 'GET features (search)').query, { search: 'pilot_rehearsal_1' });
    assert.deepEqual(fake.requests.find((q) => q.route === 'GET experiments (list)').query, { q: 'pilot_rehearsal_1' });
    assert.deepEqual(body('POST features'), { name: 'pilot_rehearsal_1', type: 'MULTIVARIATE', initial_value: 'control', default_enabled: true });
    assert.deepEqual(body('POST mv-options'), { type: 'unicode', string_value: 'variant_b', default_percentage_allocation: 0, key: 'variant_b', feature: 303389 });
    const recordedMetric = JSON.parse(readFileSync(new URL('../fixtures/flagsmith/recorded/metric-create.request.json', import.meta.url), 'utf8'));
    assert.deepEqual(body('POST experiment-metrics'), recordedMetric);
    assert.deepEqual(body('POST experiments'), {
      feature: 303389,
      name: 'pilot_rehearsal_1',
      hypothesis: VALID_PLAN.hypothesis,
      metrics: [{ metric: 422, expected_direction: 'increase' }],
      experiment_rollout: {
        enabled: true, rollout_percentage: 100,
        feature_state_value: { type: 'string', value: 'control' },
        multivariate_feature_state_values: [{ multivariate_feature_option: 36697, percentage_allocation: 50 }],
      },
    });
    for (const line of logs) noSecrets(line);
  } finally { await fake.close(); }
});

test('refuses before any write when the environment name does not match the plan', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient({ environmentName: 'Production' });
  try {
    for (const phase of ['create', 'start']) {
      const r = await applyPlan({ plan: plan(), phase, approvalText: approve(plan(), phase), createApprovalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, log });
      assert.equal(r.status, 'refused');
      assert.equal(r.stage, 'environment');
      assert.match(r.reasons[0], /"Production".*"Development"|Development.*Production/);
    }
    assert.deepEqual(fake.requests.map((q) => q.route), ['GET environment', 'GET environment']);
  } finally { await fake.close(); }
});

test('refuses if the flag already exists (exact name), and changes nothing', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient({ existingFeatures: [{ id: 1, name: 'pilot_rehearsal_1', type: 'MULTIVARIATE' }] });
  try {
    const r = await applyPlan({ plan: plan(), phase: 'create', approvalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.stage, 'exists');
    assert.match(r.reasons[0], /flag "pilot_rehearsal_1" already exists/);
    assert.deepEqual(writes(fake), []);
  } finally { await fake.close(); }
});

test('a similar but different existing flag name does not block (exact match only)', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient({ existingFeatures: [{ id: 1, name: 'pilot_rehearsal_10', type: 'MULTIVARIATE' }] });
  try {
    const r = await applyPlan({ plan: plan(), phase: 'create', approvalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.status, 'applied');
  } finally { await fake.close(); }
});

test('refuses if an experiment with the same name already exists, and changes nothing', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient({ existingExperiments: [{ id: 9, name: 'pilot_rehearsal_1', status: 'created', feature: { id: 2, name: 'x' } }] });
  try {
    const r = await applyPlan({ plan: plan(), phase: 'create', approvalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.stage, 'exists');
    assert.match(r.reasons[0], /experiment "pilot_rehearsal_1" already exists/);
    assert.deepEqual(writes(fake), []);
  } finally { await fake.close(); }
});

test('refuses if a metric with the same name already exists, and changes nothing', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient({ existingMetrics: [{ id: 422, name: 'Get started clicks', definition: { version: 1, event: 'cta_clicked' } }] });
  try {
    const r = await applyPlan({ plan: plan(), phase: 'create', approvalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.stage, 'exists');
    assert.match(r.reasons[0], /metric "Get started clicks" already exists/);
    assert.deepEqual(fake.requests.find((q) => q.route === 'GET metrics (list)').query, { q: 'Get started clicks' });
    assert.deepEqual(writes(fake), []);
  } finally { await fake.close(); }
});

test('refuses on a real Flagsmith host if any route it needs is still guessed', async () => {
  const applyPlan = await load();
  const calls = [];
  const client = createClient({
    baseUrl: 'https://api.flagsmith.com/', env: { FLAGSMITH_ADMIN_TOKEN: TOKEN }, projectId: PROJECT_ID, environmentKey: ENV_KEY,
    fetchImpl: async (...args) => { calls.push(args); throw new Error('must not be called'); },
  });
  const routes = { ...ROUTES, createFeature: { ...ROUTES.createFeature, source: 'guessed' } };
  const r = await applyPlan({ plan: plan(), phase: 'create', approvalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, routes });
  assert.equal(r.stage, 'unverified');
  assert.match(r.reasons[0], /createFeature/);
  assert.equal(calls.length, 0);
});

test('a 5xx in the middle stops at once: no further calls, nothing deleted, created items listed', async () => {
  const applyPlan = await load();
  const { fake, client, logs, log } = await fakeAndClient({ failures: { 'POST experiment-metrics': 500 }, echoAuthorizationInErrors: true });
  try {
    const r = await applyPlan({ plan: plan(), phase: 'create', approvalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.status, 'failed');
    assert.deepEqual(r.created.map((c) => [c.what, c.id]), [['flag', 303389], ['variation', 36697]]);
    assert.match(r.reasons[0], /failed with 500/);
    assert.match(r.note, /nothing was rolled back or deleted/i);
    assert.deepEqual(fake.requests.map((q) => q.route), CREATE_ROUTES.slice(0, CREATE_ROUTES.indexOf('POST experiment-metrics') + 1));
    for (const text of [...logs, ...r.reasons, r.note]) noSecrets(text);
  } finally { await fake.close(); }
});

test('a 4xx on create experiment stops there', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient({ failures: { 'POST experiments': 400 } });
  try {
    const r = await applyPlan({ plan: plan(), phase: 'create', approvalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.status, 'failed');
    assert.deepEqual(r.created.map((c) => c.what), ['flag', 'variation', 'metric']);
  } finally { await fake.close(); }
});

// --- START -----------------------------------------------------------------------

async function createdOnFake(fakeOptions = {}) {
  const applyPlan = await load();
  const ctx = await fakeAndClient(fakeOptions);
  try {
    const r = await applyPlan({ plan: plan(), phase: 'create', approvalText: approve(plan()), appSource: APP_SOURCE, apply: true, client: ctx.client, log: ctx.log });
    assert.equal(r.status, 'applied');
  } catch (err) {
    await ctx.fake.close();
    throw err;
  }
  ctx.fake.requests.length = 0;
  return ctx;
}

test('START (fake server): env check, finds the created experiment, starts it, verifies running', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await createdOnFake();
  try {
    const r = await applyPlan({ plan: plan(), phase: 'start', approvalText: approve(plan(), 'start'), createApprovalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    assert.equal(r.experimentStatus, 'running');
    assert.deepEqual(fake.requests.map((q) => q.route), ['GET environment', 'GET experiments (list)', 'POST start', 'GET experiment']);
    assert.deepEqual(writes(fake).map((q) => q.route), ['POST start']);
  } finally { await fake.close(); }
});

test('START refuses when the experiment is missing, already running, or on another flag', async () => {
  const applyPlan = await load();
  const cases = [
    [[], /no experiment named "pilot_rehearsal_1"/],
    [[{ id: 457, name: 'pilot_rehearsal_1', status: 'running', feature: { id: 303389, name: 'pilot_rehearsal_1' } }], /status "running", expected "created"/],
    [[{ id: 457, name: 'pilot_rehearsal_1', status: 'created', feature: { id: 1, name: 'other_flag' } }], /flag "other_flag"/],
  ];
  for (const [existingExperiments, reason] of cases) {
    const { fake, client, log } = await fakeAndClient({ existingExperiments });
    try {
      const r = await applyPlan({ plan: plan(), phase: 'start', approvalText: approve(plan(), 'start'), createApprovalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, log });
      assert.equal(r.status, 'refused', JSON.stringify(r));
      assert.match(r.reasons[0], reason);
      assert.deepEqual(writes(fake), []);
    } finally { await fake.close(); }
  }
});

// --- recording -------------------------------------------------------------------

test('recorder writes one numbered JSON file per call into a folder', async () => {
  const { createRecorder } = await import('../src/recorder.js');
  const dir = join(mkdtempSync(join(tmpdir(), 'ep-rec-')), 'calls');
  const record = createRecorder(dir);
  record({ route: 'getEnvironment', method: 'GET', path: 'api/v1/environments/<env key>/', status: 200, request: null, response: '{"name":"Development"}' });
  record({ route: 'createMetric', method: 'POST', path: 'x', status: 201, request: { a: 1 }, response: '' });
  assert.deepEqual(readdirSync(dir), ['01-getEnvironment.json', '02-createMetric.json']);
  const first = JSON.parse(readFileSync(join(dir, '01-getEnvironment.json'), 'utf8'));
  assert.deepEqual(first.response, { name: 'Development' }, 'JSON responses are stored parsed');
  assert.equal(JSON.parse(readFileSync(join(dir, '02-createMetric.json'), 'utf8')).response, '', 'an empty body stays empty');
});

// --- the command line ---------------------------------------------------------

const cli = (args, cwd) => spawnSync(process.execPath, [CLI_PATH, ...args], { cwd, encoding: 'utf8', env: { ...process.env, FLAGSMITH_ADMIN_TOKEN: '' } });

test('CLI: `pilot diff` prints the phase diff and hashes after the guard passes', () => {
  const r = cli(['diff', PLAN_PATH, '--app', APP_PATH, '--phase', 'create'], mkdtempSync(join(tmpdir(), 'ep-cli-')));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Phase CREATE/);
  assert.match(r.stdout, /plan sha256: [0-9a-f]{64}/);
  assert.match(r.stdout, /diff sha256: [0-9a-f]{64}/);
});

test('CLI: `pilot apply` needs --phase, and without an approval refuses and sends nothing', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ep-cli-'));
  assert.equal(cli(['apply', PLAN_PATH, '--app', APP_PATH], cwd).status, 1);
  const r = cli(['apply', PLAN_PATH, '--app', APP_PATH, '--phase', 'create'], cwd);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /no create approval/);
});

test('CLI: `pilot apply --phase create` with its approval and no --apply is a dry run (exit 0)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ep-cli-'));
  mkdirSync(join(cwd, 'approvals'));
  writeFileSync(join(cwd, 'approvals', 'pilot_rehearsal_1.create.json'), approve(plan()));
  const r = cli(['apply', PLAN_PATH, '--app', APP_PATH, '--phase', 'create'], cwd);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /DRY RUN/);
});
