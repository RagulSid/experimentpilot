// STOP phase: complete (end) a running experiment and choose what the flag serves afterwards.
// Route from the public OpenAPI spec (not yet recorded): POST .../experiments/{id}/complete/
// with {rollout_decision: control|variant|disable, rollout_variant?: integer}. Same pattern as
// START: its own diff, its own approval (which needs a valid START approval), dry run by default.
// The rollout choice is part of the diff, so it is bound to the approval hash.
// Written before the STOP phase existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeFlagsmith } from './helpers/fake-flagsmith.js';
import { createClient } from '../src/flagsmith-client.js';

const path = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const PLAN_PATH = path('fixtures/plans/valid-plan.json');
const APP_PATH = path('fixtures/app/experiment.mjs');
const VALID = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
const APP = readFileSync(APP_PATH, 'utf8');
const RESULTS = JSON.parse(readFileSync(path('fixtures/flagsmith/recorded/results-get.response.json'), 'utf8'));
const TOKEN = 'test-token-0123456789abcdef';
const ENV = 'FakeEnvKey000000000001';
const NOW = new Date('2026-11-26T08:00:00.000Z');
const plan = (over = {}) => ({ ...structuredClone(VALID), ...over });

const loadDiff = () => import('../src/diff.js');
const loadApproval = () => import('../src/approval.js');
const loadApplier = async () => (await import('../src/applier.js')).applyPlan;
const approve = async (p, phase, rollout) => JSON.stringify((await loadApproval()).createApprovalRecord({ plan: p, phase, approver: 'Ragul', now: NOW, rollout }));

// Recorded Nov 25 results with Flagsmith's inference swapped for a decisive one (variant_b wins).
function decisiveResults() {
  const r = structuredClone(RESULTS);
  const m = r.results.payload.metrics[0];
  m.variants.variant_b = { n: 150, sum: 40, sum_squares: 40 };
  m.inference.variant_b = { lift: 1.6667, ci_low: 0.6, ci_high: 2.9, chance_to_win: 0.999 };
  return r;
}

async function running({ p = plan(), resultsBody } = {}) {
  const applyPlan = await loadApplier();
  const fake = await startFakeFlagsmith({ token: TOKEN, environmentKey: ENV, projectId: 55988, resultsBody });
  const logs = [];
  const log = (l) => logs.push(l);
  const client = createClient({ baseUrl: fake.baseUrl, env: { FLAGSMITH_ADMIN_TOKEN: TOKEN }, projectId: 55988, environmentKey: ENV, log });
  try {
    const create = await approve(p, 'create');
    const c = await applyPlan({ plan: p, phase: 'create', approvalText: create, appSource: APP, apply: true, client, log });
    assert.equal(c.status, 'applied', JSON.stringify(c));
    const s = await applyPlan({ plan: p, phase: 'start', approvalText: await approve(p, 'start'), createApprovalText: create, appSource: APP, apply: true, client, log });
    assert.equal(s.status, 'applied', JSON.stringify(s));
  } catch (err) {
    await fake.close();
    throw err;
  }
  fake.requests.length = 0;
  return { applyPlan, fake, client, logs, log, p };
}
const stopArgs = async (p, rollout, over = {}) => ({
  plan: p, phase: 'stop', rollout, appSource: APP,
  approvalText: await approve(p, 'stop', rollout), startApprovalText: await approve(p, 'start'),
  ...over,
});
const writes = (fake) => fake.requests.filter((q) => q.method !== 'GET');

// --- diff ---------------------------------------------------------------------------------------

test('STOP diff: one step, complete the experiment; says what the flag serves afterwards', async () => {
  const { PHASES, buildDiff, formatDiff, diffSha256 } = await loadDiff();
  assert.deepEqual(PHASES, ['create', 'start', 'stop']);
  const d = buildDiff(plan(), 'stop', { rollout: 'control' });
  assert.equal(d.length, 1);
  assert.equal(d[0].action, 'complete_experiment');
  assert.equal(d[0].scope, 'environment Development');
  assert.deepEqual(d[0].rollout, { decision: 'control', variantKey: null, servesAfter: 'the control value "control" to everyone' });
  assert.match(d[0].requires, /stop rule/);
  assert.match(d[0].effect, /no route to undo/);
  const v = buildDiff(plan(), 'stop', { rollout: 'variant:variant_b' });
  assert.deepEqual(v[0].rollout, { decision: 'variant', variantKey: 'variant_b', servesAfter: 'the variant_b value "variant_b" to everyone' });
  const off = buildDiff(plan(), 'stop', { rollout: 'disable' });
  assert.match(off[0].rollout.servesAfter, /disabled.*fallback/);
  assert.notEqual(diffSha256(d), diffSha256(v), 'the rollout choice is part of the hashed diff');
  const text = formatDiff(v, { planSha256: 'p', diffSha256: 'd' });
  assert.match(text, /Phase STOP/);
  assert.match(text, /COMPLETE experiment pilot_rehearsal_1/);
  assert.match(text, /afterwards the flag serves the variant_b value "variant_b" to everyone/);
});

test('STOP diff refuses a missing or unknown rollout; CREATE and START diffs are unchanged', async () => {
  const { buildDiff, diffSha256 } = await loadDiff();
  assert.throws(() => buildDiff(plan(), 'stop'), /rollout/);
  assert.throws(() => buildDiff(plan(), 'stop', { rollout: 'winner' }), /rollout/);
  assert.throws(() => buildDiff(plan(), 'stop', { rollout: 'variant:nope' }), /variant/);
  assert.throws(() => buildDiff(plan(), 'stop', { rollout: 'variant:control' }), /control/);
  // The real Development START approval still matches (diff sha256 3144d47d...).
  const rehearsal = JSON.parse(readFileSync(path('plans/pilot_rehearsal_1.json'), 'utf8'));
  assert.equal(diffSha256(buildDiff(rehearsal, 'start')), '3144d47db3a35ce0548db04bbde036f34c37cec03ac99fa98c3004dc3ae96ec3');
});

// --- approval -------------------------------------------------------------------------------------

test('STOP approval is bound to the rollout choice', async () => {
  const { verifyApproval } = await loadApproval();
  const text = await approve(plan(), 'stop', 'control');
  assert.deepEqual(verifyApproval(plan(), text, 'stop', { rollout: 'control' }), { ok: true });
  const other = verifyApproval(plan(), text, 'stop', { rollout: 'variant:variant_b' });
  assert.equal(other.ok, false);
  assert.match(other.reason, /diff changed since approval/);
  assert.equal(verifyApproval(plan(), text, 'stop').ok, false);
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

test('approve STOP: needs a valid START approval and --rollout; writes <planId>.stop.json bound to that rollout', async () => {
  const { runApprove, parseArgv } = await import('../src/approve.js');
  const { verifyApproval } = await loadApproval();
  const dir = mkdtempSync(join(tmpdir(), 'ep-approve-stop-'));
  const run = (s, over = {}) => runApprove({ planPath: PLAN_PATH, appPath: APP_PATH, approvalsDir: dir, input: s.input, output: s.output, errorOutput: s.output, now: () => NOW, ...over });

  const early = session(['Ragul', 'yes']);
  assert.equal(await run(early, { phase: 'stop', rollout: 'control' }), 1);
  assert.match(early.text(), /start approval/i);

  assert.equal(await run(session(['Ragul', 'yes']), { phase: 'create' }), 0);
  assert.equal(await run(session(['Ragul', 'yes']), { phase: 'start' }), 0);
  const noRollout = session(['Ragul', 'yes']);
  assert.equal(await run(noRollout, { phase: 'stop' }), 1);
  assert.match(noRollout.text(), /--rollout/);

  const s = session(['Ragul', 'yes']);
  assert.equal(await run(s, { phase: 'stop', rollout: 'control' }), 0, s.text());
  assert.match(s.text(), /Phase STOP/);
  assert.match(s.text(), /stop rule/i);
  const written = readFileSync(join(dir, 'pilot_rehearsal_1.stop.json'), 'utf8');
  assert.deepEqual(verifyApproval(plan(), written, 'stop', { rollout: 'control' }), { ok: true });
  assert.deepEqual(readdirSync(dir).sort(), ['pilot_rehearsal_1.create.json', 'pilot_rehearsal_1.start.json', 'pilot_rehearsal_1.stop.json']);

  assert.equal(parseArgv(['p.json', '--app', 'a', '--phase', 'stop', '--rollout', 'variant:variant_b']).rollout, 'variant:variant_b');
});

// --- applier against the fake server ------------------------------------------------------------------

test('STOP (fake server): stop rule met, rollout control: completes and verifies; one write', async () => {
  const { applyPlan, fake, client, log } = await running();
  try {
    const r = await applyPlan({ ...(await stopArgs(plan(), 'control')), apply: true, client, log });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    assert.equal(r.experimentStatus, 'completed');
    assert.equal(r.readout, 'no_clear_winner');
    assert.deepEqual(fake.requests.map((q) => q.route), ['GET environment', 'GET experiments (list)', 'GET experiment', 'GET results', 'POST complete', 'GET experiment']);
    assert.deepEqual(writes(fake).map((q) => q.route), ['POST complete']);
    assert.deepEqual(writes(fake)[0].body, { rollout_decision: 'control' });
    const exp = fake.state.experiments.find((e) => e.name === 'pilot_rehearsal_1');
    assert.equal(exp.status, 'completed');
  } finally { await fake.close(); }
});

test('STOP refuses before its stop rule is met (readout not_ready); nothing is sent', async () => {
  const p = plan({ stopRule: { type: 'minExposuresPerVariant', value: 500 } });
  const { applyPlan, fake, client, log } = await running({ p });
  try {
    const r = await applyPlan({ ...(await stopArgs(p, 'control')), apply: true, client, log });
    assert.equal(r.status, 'refused');
    assert.equal(r.stage, 'stop');
    assert.match(r.reasons.join(' '), /stop rule.*not met/i);
    assert.deepEqual(writes(fake), []);
  } finally { await fake.close(); }
});

test('STOP with a variant rollout: refused unless the readout names that variant as the winner candidate', async () => {
  const unclear = await running();
  try {
    const r = await unclear.applyPlan({ ...(await stopArgs(plan(), 'variant:variant_b')), apply: true, client: unclear.client, log: unclear.log });
    assert.equal(r.status, 'refused');
    assert.match(r.reasons.join(' '), /no_clear_winner/);
    assert.deepEqual(writes(unclear.fake), []);
  } finally { await unclear.fake.close(); }

  const clear = await running({ resultsBody: decisiveResults() });
  try {
    const r = await clear.applyPlan({ ...(await stopArgs(plan(), 'variant:variant_b')), apply: true, client: clear.client, log: clear.log });
    assert.equal(r.status, 'applied', JSON.stringify(r));
    assert.equal(r.readout, 'winner_candidate');
    const option = clear.fake.state.experiments[0];
    assert.deepEqual(writes(clear.fake)[0].body, { rollout_decision: 'variant', rollout_variant: 36697 }, 'the variant\'s multivariate option id');
    assert.equal(option.rollout_decision, 'variant');
  } finally { await clear.fake.close(); }
});

test('STOP with a variant rollout is refused on a real Flagsmith host until rollout_variant is verified', async () => {
  const { applyPlan, fake, client, log } = await running({ resultsBody: decisiveResults() });
  try {
    const remote = { ...client, isLoopback: false };
    const r = await applyPlan({ ...(await stopArgs(plan(), 'variant:variant_b')), apply: true, client: remote, log });
    assert.equal(r.status, 'refused');
    assert.equal(r.stage, 'unverified');
    assert.match(r.reasons.join(' '), /rollout_variant/);
    assert.equal(fake.requests.length, 0);
  } finally { await fake.close(); }
});

test('STOP needs both its own approval and the START approval, bound to the same rollout', async () => {
  const { applyPlan, fake, client, log } = await running();
  try {
    const base = await stopArgs(plan(), 'control');
    const noStart = await applyPlan({ ...base, startApprovalText: null, apply: true, client, log });
    assert.equal(noStart.stage, 'approval');
    assert.match(noStart.reasons[0], /start approval/i);
    const otherRollout = await applyPlan({ ...base, rollout: 'disable', apply: true, client, log });
    assert.equal(otherRollout.stage, 'approval');
    assert.match(otherRollout.reasons[0], /diff changed since approval/);
    assert.equal(fake.requests.length, 0);
  } finally { await fake.close(); }
});

test('STOP refuses an experiment that is not running (created only) and a dry run sends nothing', async () => {
  const applyPlan = await loadApplier();
  const fake = await startFakeFlagsmith({ token: TOKEN, environmentKey: ENV, projectId: 55988 });
  const logs = [];
  const log = (l) => logs.push(l);
  const client = createClient({ baseUrl: fake.baseUrl, env: { FLAGSMITH_ADMIN_TOKEN: TOKEN }, projectId: 55988, environmentKey: ENV, log });
  try {
    const create = await approve(plan(), 'create');
    await applyPlan({ plan: plan(), phase: 'create', approvalText: create, appSource: APP, apply: true, client, log });
    fake.requests.length = 0;
    const dry = await applyPlan({ ...(await stopArgs(plan(), 'control')), client, log });
    assert.equal(dry.status, 'dry_run');
    assert.equal(fake.requests.length, 0);
    assert.match(logs.join('\n'), /Phase STOP/);
    const r = await applyPlan({ ...(await stopArgs(plan(), 'control')), apply: true, client, log });
    assert.equal(r.status, 'refused');
    assert.match(r.reasons[0], /status "created"/);
    assert.deepEqual(writes(fake), []);
  } finally { await fake.close(); }
});

test('pilot diff --phase stop needs --rollout and prints the STOP diff', () => {
  const cli = (...a) => spawnSync(process.execPath, [path('src/cli.js'), 'diff', PLAN_PATH, '--app', APP_PATH, '--phase', 'stop', ...a], { encoding: 'utf8' });
  const none = cli();
  assert.equal(none.status, 1);
  assert.match(none.stderr, /--rollout/);
  const ok = cli('--rollout', 'control');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /COMPLETE experiment pilot_rehearsal_1/);
  assert.match(ok.stdout, /diff sha256: [0-9a-f]{64}/);
});
