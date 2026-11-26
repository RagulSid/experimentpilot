// Applier: guard -> verifyApproval -> apply, against the fake Flagsmith only.
// Written before src/applier.js existed. Nothing here talks to the real Flagsmith.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeFlagsmith } from './helpers/fake-flagsmith.js';
import { createApprovalRecord } from '../src/approval.js';
import { createClient } from '../src/flagsmith-client.js';

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
const approve = (p) => JSON.stringify(createApprovalRecord({ plan: p, approver: 'Ragul', now: NOW }));
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

test('refuses a plan with the wrong shape before anything else', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient();
  try {
    const p = plan();
    delete p.metric;
    const r = await applyPlan({ plan: p, approvalText: null, appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.status, 'refused');
    assert.equal(r.stage, 'plan');
    assert.equal(fake.requests.length, 0);
  } finally { await fake.close(); }
});

test('runs the guard first: a guard failure is reported even without an approval', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient();
  try {
    const p = plan();
    p.split = { control: 60, variant_b: 50 };
    const r = await applyPlan({ plan: p, approvalText: null, appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.status, 'refused');
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
    const r = await applyPlan({ plan: p, approvalText: approve(p), appSource: APP_SOURCE, apply: true, client, log, skipGuard: true });
    assert.equal(r.stage, 'guard');
    assert.ok(r.reasons.some((x) => x.startsWith('G9')));
    assert.equal(fake.requests.length, 0);
  } finally { await fake.close(); }
});

test('refuses without an approval, and when the plan changed after approval', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient();
  try {
    const none = await applyPlan({ plan: plan(), approvalText: null, appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(none.stage, 'approval');
    const text = approve(plan());
    const edited = plan();
    edited.hypothesis += ' Edited.';
    const changed = await applyPlan({ plan: edited, approvalText: text, appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(changed.stage, 'approval');
    assert.match(changed.reasons[0], /plan changed after approval/);
    assert.equal(fake.requests.length, 0);
  } finally { await fake.close(); }
});

test('dry run by default: makes no HTTP call and prints the diff', async () => {
  const applyPlan = await load();
  const { fake, client, logs, log } = await fakeAndClient();
  try {
    for (const apply of [undefined, false, 'true', 1]) {
      const r = await applyPlan({ plan: plan(), approvalText: approve(plan()), appSource: APP_SOURCE, apply, client, log });
      assert.equal(r.status, 'dry_run', `apply=${JSON.stringify(apply)} must not apply`);
      assert.equal(r.diff.length, 4);
    }
    assert.equal(fake.requests.length, 0);
    const text = logs.join('\n');
    assert.match(text, /DRY RUN/);
    assert.match(text, /--apply/);
    assert.match(text, /CREATE flag pilot_rehearsal_1/);
  } finally { await fake.close(); }
});

test('apply happy path (fake server): checks, creates in order, starts, verifies running', async () => {
  const applyPlan = await load();
  const { fake, client, logs, log } = await fakeAndClient();
  try {
    const r = await applyPlan({ plan: plan(), approvalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    assert.deepEqual(fake.requests.map((q) => q.route), [
      'GET features (search)', 'GET experiments (list)',
      'POST features', 'POST experiment-metrics', 'POST experiments', 'POST start', 'GET experiment',
    ]);
    assert.deepEqual(r.created.map((c) => [c.what, c.id]), [['flag', 303389], ['metric', 422], ['experiment', 457]]);
    assert.equal(r.experimentStatus, 'running');

    const body = (route) => fake.requests.find((q) => q.route === route).body;
    assert.deepEqual(body('POST features'), {
      name: 'pilot_rehearsal_1', type: 'MULTIVARIATE', initial_value: 'control', default_enabled: true,
      multivariate_options: [{ type: 'unicode', string_value: 'variant_b', default_percentage_allocation: 0, key: 'variant_b' }],
    });
    // Same shape as the recorded metric request (call 19).
    const recordedMetric = JSON.parse(readFileSync(new URL('../fixtures/flagsmith/recorded/metric-create.request.json', import.meta.url), 'utf8'));
    assert.deepEqual(body('POST experiment-metrics'), recordedMetric);
    // Same shape as the recorded experiment request (call 21), with this plan's values.
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

test('refuses if the flag already exists, and changes nothing', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient({ existingFeatures: [{ id: 1, name: 'pilot_rehearsal_1', type: 'MULTIVARIATE' }] });
  try {
    const r = await applyPlan({ plan: plan(), approvalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.status, 'refused');
    assert.equal(r.stage, 'exists');
    assert.match(r.reasons[0], /flag "pilot_rehearsal_1" already exists/);
    assert.deepEqual(fake.requests.filter((q) => q.method !== 'GET'), []);
  } finally { await fake.close(); }
});

test('a similar but different existing flag name does not block (exact match only)', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient({ existingFeatures: [{ id: 1, name: 'pilot_rehearsal_10', type: 'MULTIVARIATE' }] });
  try {
    const r = await applyPlan({ plan: plan(), approvalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.status, 'applied');
  } finally { await fake.close(); }
});

test('refuses if an experiment with the same name already exists, and changes nothing', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient({ existingExperiments: [{ id: 9, name: 'pilot_rehearsal_1', status: 'created' }] });
  try {
    const r = await applyPlan({ plan: plan(), approvalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.stage, 'exists');
    assert.match(r.reasons[0], /experiment "pilot_rehearsal_1" already exists/);
    assert.deepEqual(fake.requests.filter((q) => q.method !== 'GET'), []);
  } finally { await fake.close(); }
});

test('refuses to send guessed routes to a real Flagsmith host', async () => {
  const applyPlan = await load();
  const calls = [];
  const client = createClient({
    baseUrl: 'https://api.flagsmith.com/', env: { FLAGSMITH_ADMIN_TOKEN: TOKEN }, projectId: PROJECT_ID, environmentKey: ENV_KEY,
    fetchImpl: async (...args) => { calls.push(args); throw new Error('must not be called'); },
  });
  const r = await applyPlan({ plan: plan(), approvalText: approve(plan()), appSource: APP_SOURCE, apply: true, client });
  assert.equal(r.status, 'refused');
  assert.equal(r.stage, 'unverified');
  for (const route of ['createFeature', 'listExperiments', 'listFeatures']) assert.ok(r.reasons.join(' ').includes(route), route);
  assert.equal(calls.length, 0);
});

test('a 5xx in the middle stops at once: no further calls, nothing deleted, created items listed', async () => {
  const applyPlan = await load();
  const { fake, client, logs, log } = await fakeAndClient({ failures: { 'POST experiment-metrics': 500 }, echoAuthorizationInErrors: true });
  try {
    const r = await applyPlan({ plan: plan(), approvalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.status, 'failed');
    assert.deepEqual(r.created.map((c) => [c.what, c.id]), [['flag', 303389]]);
    assert.match(r.reasons[0], /failed with 500/);
    assert.match(r.note, /nothing was rolled back or deleted/i);
    assert.deepEqual(fake.requests.map((q) => q.route), ['GET features (search)', 'GET experiments (list)', 'POST features', 'POST experiment-metrics']);
    for (const text of [...logs, ...r.reasons, r.note]) noSecrets(text);
  } finally { await fake.close(); }
});

test('a 4xx on create experiment stops before start', async () => {
  const applyPlan = await load();
  const { fake, client, log } = await fakeAndClient({ failures: { 'POST experiments': 400 } });
  try {
    const r = await applyPlan({ plan: plan(), approvalText: approve(plan()), appSource: APP_SOURCE, apply: true, client, log });
    assert.equal(r.status, 'failed');
    assert.deepEqual(r.created.map((c) => c.what), ['flag', 'metric']);
    assert.ok(!fake.requests.some((q) => q.route === 'POST start'));
  } finally { await fake.close(); }
});

// --- the command line ---------------------------------------------------------

test('CLI: `pilot apply` without an approval refuses and sends nothing', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ep-cli-'));
  const r = spawnSync(process.execPath, [CLI_PATH, 'apply', PLAN_PATH, '--app', APP_PATH], { cwd, encoding: 'utf8', env: { ...process.env, FLAGSMITH_ADMIN_TOKEN: '' } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /no approval file/);
});

test('CLI: `pilot apply` with an approval and no --apply is a dry run (exit 0)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ep-cli-'));
  mkdirSync(join(cwd, 'approvals'));
  writeFileSync(join(cwd, 'approvals', 'pilot_rehearsal_1.json'), approve(plan()));
  const r = spawnSync(process.execPath, [CLI_PATH, 'apply', PLAN_PATH, '--app', APP_PATH], { cwd, encoding: 'utf8', env: { ...process.env, FLAGSMITH_ADMIN_TOKEN: '' } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /DRY RUN/);
});
