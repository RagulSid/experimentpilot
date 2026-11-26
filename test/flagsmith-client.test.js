// Flagsmith Admin API client against the fake server. Written before src/flagsmith-client.js.
// No test here talks to the real Flagsmith.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startFakeFlagsmith } from './helpers/fake-flagsmith.js';

const TOKEN = 'test-token-DO-NOT-LEAK-0123456789abcdef';
const ENV_KEY = 'FakeEnvKey000000000001';
const PROJECT_ID = 55988;
const recorded = (name) => JSON.parse(readFileSync(new URL(`../fixtures/flagsmith/recorded/${name}`, import.meta.url), 'utf8'));
const load = () => import('../src/flagsmith-client.js');

async function setup(fakeOptions = {}, { env = { FLAGSMITH_ADMIN_TOKEN: TOKEN } } = {}) {
  const { createClient } = await load();
  const fake = await startFakeFlagsmith({ token: TOKEN, environmentKey: ENV_KEY, projectId: PROJECT_ID, ...fakeOptions });
  const logs = [];
  const client = createClient({ baseUrl: fake.baseUrl, env, projectId: PROJECT_ID, environmentKey: ENV_KEY, log: (line) => logs.push(line) });
  return { client, fake, logs };
}

const noSecrets = (text) => {
  assert.ok(!String(text).includes(TOKEN), `token leaked in: ${text}`);
  assert.ok(!String(text).includes(ENV_KEY), `environment key leaked in: ${text}`);
};

test('happy path: recorded routes return the recorded bodies', async () => {
  const { client, fake, logs } = await setup();
  try {
    assert.deepEqual(await client.getWarehouseConnections(), recorded('warehouse-connections-get.response.json'));
    assert.deepEqual(await client.getResults(457), recorded('results-get.response.json'));
    const metric = await client.createMetric(recorded('metric-create.request.json'));
    assert.equal(metric.id, 422);
    assert.deepEqual(metric.definition, { version: 1, event: 'cta_clicked' });
    const experiment = await client.createExperiment(recorded('experiment-create.request.json'));
    assert.equal(experiment.status, 'created');
    const started = await client.startExperiment(experiment.id);
    assert.equal(started.status, 'running');
    assert.equal((await client.getExperiment(experiment.id)).status, 'running');
    assert.equal(await client.refreshResults(experiment.id), null, 'refresh returns an empty body');
    for (const line of logs) noSecrets(line);
  } finally { await fake.close(); }
});

test('the token is sent only as "Authorization: Api-Key <token>"', async () => {
  const { client, fake } = await setup();
  try {
    await client.getWarehouseConnections();
    await client.createMetric(recorded('metric-create.request.json'));
    for (const r of fake.requests) {
      assert.equal(r.headers.authorization, `Api-Key ${TOKEN}`);
      assert.ok(!r.path.includes(TOKEN) && !JSON.stringify(r.query).includes(TOKEN) && !r.raw.includes(TOKEN), 'token only in the header');
    }
    assert.equal(fake.requests[1].headers['content-type'], 'application/json');
    assert.deepEqual(fake.requests[1].body, recorded('metric-create.request.json'));
  } finally { await fake.close(); }
});

test('a 4xx response becomes a FlagsmithApiError with status and a redacted path', async () => {
  const { FlagsmithApiError } = await load();
  const { client, fake } = await setup({ failures: { 'POST experiments': 400 } });
  try {
    await assert.rejects(client.createExperiment(recorded('experiment-create.request.json')), (err) => {
      assert.ok(err instanceof FlagsmithApiError);
      assert.equal(err.status, 400);
      assert.match(err.message, /POST api\/v1\/environments\/<env key>\/experiments\/ failed with 400/);
      assert.match(err.message, /Invalid request/);
      noSecrets(err.message);
      return true;
    });
  } finally { await fake.close(); }
});

test('a 5xx response becomes a FlagsmithApiError and is not retried', async () => {
  const { client, fake } = await setup({ failures: { 'POST experiment-metrics': 503 } });
  try {
    await assert.rejects(client.createMetric(recorded('metric-create.request.json')), (err) => {
      assert.equal(err.status, 503);
      noSecrets(err.message);
      return true;
    });
    assert.equal(fake.requests.length, 1, 'a write is never retried automatically');
  } finally { await fake.close(); }
});

test('results refresh: a second refresh within 5 minutes is rate limited (429)', async () => {
  const { client, fake } = await setup();
  try {
    assert.equal(await client.refreshResults(457), null);
    await assert.rejects(client.refreshResults(457), (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.rateLimited, true);
      assert.match(err.message, /5 minutes/);
      return true;
    });
  } finally { await fake.close(); }
});

test('canRefresh uses the recorded refresh_requested_at and the 5-minute limit', async () => {
  const { canRefresh } = await load();
  const results = recorded('results-get.response.json');
  const requested = Date.parse(results.results.refresh_requested_at);
  assert.deepEqual(canRefresh(results, new Date(requested + 4 * 60 * 1000)), { ok: false, waitMs: 60 * 1000 });
  assert.deepEqual(canRefresh(results, new Date(requested + 5 * 60 * 1000)), { ok: true, waitMs: 0 });
  assert.deepEqual(canRefresh({ results: { refresh_requested_at: null } }, new Date()), { ok: true, waitMs: 0 });
});

test('the token never appears in a log line or error message, even if the server echoes it', async () => {
  const { client, fake, logs } = await setup({ failures: { 'POST experiments': 400, 'GET results': 500 }, echoAuthorizationInErrors: true });
  try {
    for (const call of [() => client.createExperiment({}), () => client.getResults(457)]) {
      await assert.rejects(call(), (err) => {
        noSecrets(err.message);
        noSecrets(err.stack);
        assert.match(err.message, /<redacted>/, 'the echoed token was replaced');
        return true;
      });
    }
    assert.ok(logs.length > 0);
    for (const line of logs) noSecrets(line);
  } finally { await fake.close(); }

  // Flagsmith unreachable: the connection error must not leak either.
  const { createClient } = await load();
  const unreachableLogs = [];
  const client2 = createClient({ baseUrl: fake.baseUrl, env: { FLAGSMITH_ADMIN_TOKEN: TOKEN }, projectId: PROJECT_ID, environmentKey: ENV_KEY, log: (l) => unreachableLogs.push(l) });
  await assert.rejects(client2.getWarehouseConnections(), (err) => {
    assert.match(err.message, /could not be reached/);
    noSecrets(err.message);
    return true;
  });
  for (const line of unreachableLogs) noSecrets(line);
});

test('no token in FLAGSMITH_ADMIN_TOKEN: refuses before sending anything', async () => {
  const { client, fake } = await setup({}, { env: {} });
  try {
    await assert.rejects(client.getWarehouseConnections(), /FLAGSMITH_ADMIN_TOKEN/);
    assert.equal(fake.requests.length, 0);
  } finally { await fake.close(); }
});

test('a wrong token gets the server 401 back as an error', async () => {
  const { client, fake } = await setup({}, { env: { FLAGSMITH_ADMIN_TOKEN: 'wrong-token-value-1234567890' } });
  try {
    await assert.rejects(client.getWarehouseConnections(), (err) => err.status === 401 && !err.message.includes('wrong-token-value-1234567890'));
  } finally { await fake.close(); }
});

test('every route states whether it was recorded or guessed', async () => {
  const { ROUTES } = await load();
  const recordedRoutes = Object.entries(ROUTES).filter(([, r]) => r.source === 'recorded').map(([n]) => n).sort();
  const guessedRoutes = Object.entries(ROUTES).filter(([, r]) => r.source === 'guessed').map(([n]) => n).sort();
  assert.deepEqual(recordedRoutes, ['createExperiment', 'createMetric', 'getExperiment', 'getResults', 'getWarehouseConnections', 'refreshResults', 'startExperiment']);
  assert.deepEqual(guessedRoutes, ['createFeature', 'listExperiments', 'listFeatures']);
  for (const [name, r] of Object.entries(ROUTES)) {
    if (r.source === 'recorded') assert.ok(Number.isInteger(r.call), `${name} names its recorded call number`);
  }
});
