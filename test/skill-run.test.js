// Offline scripted run of skills/flagsmith-experiment-rollout: the exact commands SKILL.md tells
// the agent to run, in order, through the real Flagsmith CLI binary (v2.0.0 devDependency) against
// the loopback fake built from recorded responses. It proves the refusals and the happy path.
// The human's approvals are written by the test with the pilot's own createApprovalRecord: that
// stands in for the person typing "yes" in their terminal, which the agent can never do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeFlagsmith } from './helpers/fake-flagsmith.js';
import { createApprovalRecord } from '../src/approval.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATUS = join(ROOT, 'skills', 'flagsmith-experiment-rollout', 'scripts', 'status.mjs');
const ENV_KEY = 'FakeEnvKey000000000001';
const PROJECT = 55988;
const TOKEN = ['testprefix', 'testsecret'].join('.');
const ID = 'skill_offline_1';
const RECORDED = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'flagsmith', 'recorded', 'results-get.response.json'), 'utf8'));
const WRITES = ['POST features', 'POST mv-options', 'POST experiment-metrics', 'POST experiments', 'POST start', 'POST complete'];

function planFor(environment = 'Development') {
  const plan = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'plans', 'valid-plan.json'), 'utf8'));
  plan.id = ID;
  plan.flag.key = ID;
  plan.environment = environment;
  plan.metric.name = `Get started clicks (${ID})`;
  plan.decisionRule.primaryMetric = plan.metric.name;
  return plan;
}

function resultsWith({ n, inference } = {}) {
  const body = structuredClone(RECORDED);
  const m = body.results.payload.metrics[0];
  if (n !== undefined) {
    for (const k of ['control', 'variant_b']) m.variants[k].n = n;
    body.results.payload.exposures_timeseries.points[0].new_identities = { control: n, variant_b: n };
  }
  if (inference) m.inference.variant_b = inference;
  return body;
}

async function setup(fakeOptions = {}) {
  const fake = await startFakeFlagsmith({ token: TOKEN, environmentKey: ENV_KEY, projectId: PROJECT, ...fakeOptions });
  const dir = mkdtempSync(join(tmpdir(), 'skill-run-'));
  mkdirSync(join(dir, 'plans'));
  writeFileSync(join(dir, 'plans', `${ID}.json`), JSON.stringify(planFor(), null, 2));
  writeFileSync(join(dir, 'plans', 'prod.json'), JSON.stringify(planFor('Production'), null, 2));
  copyFileSync(join(ROOT, 'fixtures', 'app', 'experiment.mjs'), join(dir, 'app.mjs'));
  writeFileSync(join(dir, 'flagsmith.json'), JSON.stringify({ project: PROJECT, environment: ENV_KEY }));
  const { hostname, port } = new URL(fake.baseUrl);
  const env = { ...process.env, FLAGSMITH_API_URL: fake.baseUrl.replace(/\/$/, ''), [`FLAGSMITH_API_KEY_${hostname.replaceAll('.', '_')}_${port}`]: TOKEN };
  delete env.FLAGSMITH_ADMIN_TOKEN;
  const exec = (file, args, input) => new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...args], { cwd: dir, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      assert.ok(!out.includes(ENV_KEY), `environment key printed by ${args.join(' ')}`);
      assert.ok(!out.includes(TOKEN), 'API key printed');
      resolve({ code, out });
    });
    child.stdin.end(input ?? '');
  });
  const plan = `plans/${ID}.json`;
  const common = ['--app', 'app.mjs'];
  const cfg = ['--via-cli', '--config', 'flagsmith.json'];
  return {
    fake, dir,
    status: () => exec(STATUS, [plan, '--config', 'flagsmith.json', '--app', 'app.mjs']),
    pilot: (...args) => exec(join(ROOT, 'src', 'cli.js'), args),
    approveViaPipe: (phase) => exec(join(ROOT, 'src', 'approve.js'), [plan, ...common, '--phase', phase], 'agent\nyes\n'),
    humanApproves: (phase, rollout) => {
      mkdirSync(join(dir, 'approvals'), { recursive: true });
      const record = createApprovalRecord({ plan: planFor(), phase, approver: 'test-human', now: new Date(), rollout });
      writeFileSync(join(dir, 'approvals', `${ID}.${phase}.json`), `${JSON.stringify(record, null, 2)}\n`);
    },
    plan, common, cfg,
    writes: () => fake.requests.filter((r) => WRITES.includes(r.route)).map((r) => r.route),
    close: async () => { await fake.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('skill run, happy path with every refusal on the way: plan -> guard -> approval -> create -> start -> readout -> complete', async () => {
  const s = await setup();
  const { plan, common, cfg } = s;
  try {
    // 0. Orient: nothing exists yet; the helper says the next step is a STOP for human approval.
    let r = await s.status();
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /binding env Development/);
    assert.match(r.out, /flag absent \| experiment none/);
    assert.match(r.out, /approvals: create no, start no, stop no/);
    assert.match(r.out, /next: STOP/);
    assert.ok(r.out.trim().split('\n').length <= 6, 'status is compact');

    // 1-2. Guard and exact diff. Production is refused without an explicit human instruction.
    r = await s.pilot('diff', 'plans/prod.json', ...common, '--phase', 'create');
    assert.equal(r.code, 1);
    assert.match(r.out, /REFUSED \(guard\): G9 environment is Production/);
    r = await s.pilot('diff', plan, ...common, '--phase', 'create');
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /diffSha256|diff sha256/i);

    // 3. The agent cannot approve: approve.js refuses piped input and writes nothing.
    r = await s.approveViaPipe('create');
    assert.notEqual(r.code, 0);
    assert.ok(!existsSync(join(s.dir, 'approvals')) || readdirSync(join(s.dir, 'approvals')).length === 0, 'no approval file written');
    r = await s.pilot('apply', plan, ...common, '--phase', 'create', '--apply', ...cfg);
    assert.equal(r.code, 1);
    assert.match(r.out, /REFUSED \(approval\)/);
    assert.deepEqual(s.writes(), [], 'nothing written before approval');

    // 4. The human approves CREATE in their own terminal; create runs through the CLI.
    s.humanApproves('create');
    r = await s.pilot('apply', plan, ...common, '--phase', 'create', '--apply', ...cfg);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(s.writes(), ['POST features', 'POST mv-options', 'POST experiment-metrics', 'POST experiments']);
    r = await s.status();
    assert.match(r.out, /experiment \d+ created/);
    assert.match(r.out, /next: STOP: ask the human whether the app .* is deployed/);

    // 5. START is refused until the human approves it (after saying the app is deployed).
    r = await s.pilot('apply', plan, ...common, '--phase', 'start', '--apply', ...cfg);
    assert.equal(r.code, 1);
    assert.match(r.out, /REFUSED \(approval\)/);
    s.humanApproves('start');
    r = await s.pilot('apply', plan, ...common, '--phase', 'start', '--apply', ...cfg);
    assert.equal(r.code, 0, r.out);
    assert.equal(s.writes().at(-1), 'POST start');
    r = await s.status();
    assert.match(r.out, /experiment \d+ running/);
    assert.match(r.out, /next: readout/);

    // 6. Readout before the stop rule: not_ready, and no lift or interval is shown.
    s.fake.setResultsBody(resultsWith({ n: 40 }));
    r = await s.pilot('readout', plan, '--refresh', ...cfg);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Decision: not_ready/);
    assert.match(r.out, /Stop rule not met: needs 150 exposures per variation/);
    assert.doesNotMatch(r.out, /lift|credible interval|chance to beat/i);

    // 7. Completing early is refused even with a STOP approval: no peeking decisions.
    s.humanApproves('stop', 'control');
    r = await s.pilot('apply', plan, ...common, '--phase', 'stop', '--rollout', 'control', '--apply', ...cfg);
    assert.equal(r.code, 1);
    assert.match(r.out, /REFUSED \(stop\): the pre-registered stop rule is not met yet/);
    assert.ok(!s.writes().includes('POST complete'));

    // 8. Stop rule met, interval includes zero: no_clear_winner; then a clear result: winner_candidate.
    s.fake.setResultsBody(resultsWith({ n: 150 }));
    r = await s.pilot('readout', plan, ...cfg);
    assert.match(r.out, /Decision: no_clear_winner/);
    assert.match(r.out, /includes zero/);
    s.fake.setResultsBody(resultsWith({ n: 150, inference: { lift: 1.6667, ci_low: 0.6, ci_high: 2.9, chance_to_win: 0.999 } }));
    r = await s.pilot('readout', plan, ...cfg);
    assert.match(r.out, /Decision: winner_candidate \(candidate: variant_b\)/);
    assert.match(r.out, /A person decides whether to roll it out/);

    // 9. Complete with the human's approved rollout (control), through the CLI.
    r = await s.pilot('apply', plan, ...common, '--phase', 'stop', '--rollout', 'control', '--apply', ...cfg);
    assert.equal(r.code, 0, r.out);
    const complete = s.fake.requests.find((q) => q.route === 'POST complete');
    assert.deepEqual(complete.body, { rollout_decision: 'control' });
    r = await s.status();
    assert.match(r.out, /experiment \d+ completed \(rollout control\)/);
    assert.match(r.out, /next: done/);

    // Every request carried the CLI's credential: the pilot held no admin token.
    assert.ok(s.fake.requests.every((q) => q.headers.authorization === `Api-Key ${TOKEN}`));
  } finally {
    await s.close();
  }
});

test('skill run: an existing flag is never edited (status says STOP, create is refused, nothing is written)', async () => {
  const s = await setup({ existingFeatures: [{ id: 999, name: ID, type: 'STANDARD' }] });
  try {
    let r = await s.status();
    assert.match(r.out, /flag present \(id 999, standard\)/i);
    assert.match(r.out, /next: STOP: flag skill_offline_1 already exists/);
    s.humanApproves('create');
    r = await s.pilot('apply', s.plan, ...s.common, '--phase', 'create', '--apply', ...s.cfg);
    assert.equal(r.code, 1);
    assert.match(r.out, /REFUSED \(exists\)/);
    assert.deepEqual(s.writes(), []);
  } finally {
    await s.close();
  }
});

test('skill run: a binding that points at another environment stops the helper and the pilot', async () => {
  const s = await setup({ environmentName: 'Production' });
  try {
    let r = await s.status();
    assert.match(r.out, /binding env Production/);
    assert.match(r.out, /next: STOP: the binding points at Production but the plan says Development/);
    s.humanApproves('create');
    r = await s.pilot('apply', s.plan, ...s.common, '--phase', 'create', '--apply', ...s.cfg);
    assert.equal(r.code, 1);
    assert.match(r.out, /REFUSED \(environment\)/);
    assert.deepEqual(s.writes(), []);
  } finally {
    await s.close();
  }
});
