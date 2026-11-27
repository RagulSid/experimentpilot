// `--via-cli` on the pilot's apply and readout commands: every Admin API call goes through the
// real Flagsmith CLI binary (its own login), and FLAGSMITH_API_URL (the CLI's own variable)
// selects the host. Runs against the loopback fake; no admin token in the environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeFlagsmith } from './helpers/fake-flagsmith.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLAN = join(ROOT, 'fixtures', 'plans', 'valid-plan.json');
const APP = join(ROOT, 'fixtures', 'app', 'experiment.mjs');
const ENV_KEY = 'FakeEnvKey000000000001';
const PROJECT = 55988;
const TOKEN = ['testprefix', 'testsecret'].join('.');

function pilot(args, { cwd, baseUrl }) {
  const { hostname, port } = new URL(baseUrl);
  const env = { ...process.env, FLAGSMITH_API_URL: baseUrl.replace(/\/$/, ''), [`FLAGSMITH_API_KEY_${hostname.replaceAll('.', '_')}_${port}`]: TOKEN };
  delete env.FLAGSMITH_ADMIN_TOKEN;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'cli.js'), ...args], { cwd, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

function workdir() {
  const dir = mkdtempSync(join(tmpdir(), 'ep-via-cli-'));
  writeFileSync(join(dir, 'flagsmith.json'), JSON.stringify({ project: PROJECT, environment: ENV_KEY }));
  return dir;
}

test('readout --via-cli reads the experiment through the Flagsmith CLI with no admin token', async () => {
  const fake = await startFakeFlagsmith({
    token: TOKEN, environmentKey: ENV_KEY, projectId: PROJECT,
    existingExperiments: [{ id: 457, name: 'pilot_rehearsal_1', status: 'running', feature: { id: 303389, name: 'pilot_rehearsal_1' } }],
  });
  const dir = workdir();
  try {
    const r = await pilot(['readout', PLAN, '--via-cli', '--config', join(dir, 'flagsmith.json')], { cwd: dir, baseUrl: fake.baseUrl });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Experiment 457 \(pilot_rehearsal_1\), status running/);
    assert.match(r.out, /Decision: no_clear_winner/);
    assert.ok(!r.out.includes(ENV_KEY), 'environment key must not be printed');
    assert.ok(fake.requests.length > 0 && fake.requests.every((q) => q.headers.authorization === `Api-Key ${TOKEN}`));
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply --via-cli --apply without an approval file is refused and sends nothing', async () => {
  const fake = await startFakeFlagsmith({ token: TOKEN, environmentKey: ENV_KEY, projectId: PROJECT });
  const dir = workdir();
  try {
    const r = await pilot(['apply', PLAN, '--app', APP, '--phase', 'create', '--apply', '--via-cli', '--config', join(dir, 'flagsmith.json')], { cwd: dir, baseUrl: fake.baseUrl });
    assert.equal(r.code, 1);
    assert.match(r.out, /REFUSED \(approval\)/);
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the usage line lists --via-cli', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'src', 'cli.js'), 'readout'], { encoding: 'utf8' });
  assert.match(r.stderr, /--via-cli/);
});
