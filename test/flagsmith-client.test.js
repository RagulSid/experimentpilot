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
  // Recorded 2026-11-26 (call 46): before the first refresh Flagsmith returns {"results": null}.
  const never = recorded('2026-11-26-start-results/04-getResults.json').response;
  assert.deepEqual(never, { results: null });
  assert.deepEqual(canRefresh(never, new Date()), { ok: true, waitMs: 0 });
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

test('every route has been seen working for real: source recorded, with its call number', async () => {
  const { ROUTES } = await load();
  for (const name of ['getEnvironment', 'listFeatures', 'createFeature', 'createVariation', 'listExperiments', 'listMetrics']) {
    assert.ok(name in ROUTES, `${name} exists`);
  }
  for (const [name, r] of Object.entries(ROUTES)) {
    assert.equal(r.source, 'recorded', `${name} has source ${r.source}`);
    assert.ok(Number.isInteger(r.call), `${name} names its recorded call number`);
  }
  // Calls 29-34 are the routes first seen in the real CREATE run on Nov 26.
  assert.deepEqual(
    ['getEnvironment', 'listFeatures', 'listExperiments', 'listMetrics', 'createFeature', 'createVariation'].map((n) => ROUTES[n].call),
    [29, 30, 31, 32, 33, 34],
  );
});

test('the fake answers the Nov 26 routes with the same fields as the real responses', async () => {
  const { client, fake } = await setup();
  const real = (f) => JSON.parse(readFileSync(new URL(`../fixtures/flagsmith/recorded/2026-11-26-create/${f}`, import.meta.url), 'utf8')).response;
  const keys = (o) => Object.keys(o).sort();
  try {
    const raw = async (path) => (await fetch(new URL(path, fake.baseUrl), { headers: { Authorization: `Api-Key ${TOKEN}` } })).json();
    assert.deepEqual(keys(await client.getEnvironment()), keys(real('01-getEnvironment.json')));
    assert.deepEqual(keys(await raw(`api/v1/projects/${PROJECT_ID}/features/?search=x`)), keys(real('02-listFeatures.json')));
    assert.deepEqual(keys(await raw(`api/v1/environments/${ENV_KEY}/experiments/?q=x`)), keys(real('03-listExperiments.json')));
    assert.deepEqual(keys(await raw(`api/v1/environments/${ENV_KEY}/experiment-metrics/?q=x`)), keys(real('04-listMetrics.json')));
    const feature = await client.createFeature({ name: 'pilot_rehearsal_1', type: 'MULTIVARIATE', initial_value: 'control', default_enabled: true });
    assert.deepEqual(keys(feature), keys(real('05-createFeature.json')));
    const option = await client.createVariation(feature.id, { type: 'unicode', string_value: 'variant_b', default_percentage_allocation: 0, key: 'variant_b', feature: feature.id });
    assert.deepEqual(keys(option), keys(real('06-createVariation.json')));
  } finally { await fake.close(); }
});

test('the routes from Swagger work against the fake: environment, feature search, create, keyed variation, experiment search', async () => {
  const { client, fake } = await setup({ existingFeatures: [{ id: 5, name: 'other_flag' }] });
  try {
    const env = await client.getEnvironment();
    assert.equal(env.name, 'Development');
    assert.deepEqual(await client.listFeatures('pilot_rehearsal_1'), []);
    const feature = await client.createFeature({ name: 'pilot_rehearsal_1', type: 'MULTIVARIATE', initial_value: 'control', default_enabled: true });
    assert.equal(feature.id, 303389);
    const option = await client.createVariation(feature.id, { type: 'unicode', string_value: 'variant_b', default_percentage_allocation: 0, key: 'variant_b', feature: feature.id });
    assert.equal(option.key, 'variant_b');
    assert.deepEqual(await client.listExperiments('pilot_rehearsal_1'), []);
    assert.deepEqual(fake.requests.map((r) => [r.method, r.path.replace(ENV_KEY, '<env>'), r.query]), [
      ['GET', '/api/v1/environments/<env>/', {}],
      ['GET', '/api/v1/projects/55988/features/', { search: 'pilot_rehearsal_1' }],
      ['POST', '/api/v1/projects/55988/features/', {}],
      ['POST', '/api/v1/projects/55988/features/303389/mv-options/', {}],
      ['GET', '/api/v1/environments/<env>/experiments/', { q: 'pilot_rehearsal_1' }],
    ]);
  } finally { await fake.close(); }
});

test('record hook gets every call with method, path, status, request and response, all redacted', async () => {
  const { createClient } = await load();
  const fake = await startFakeFlagsmith({ token: TOKEN, environmentKey: ENV_KEY, projectId: PROJECT_ID, failures: { 'POST experiments': 400 }, echoAuthorizationInErrors: true });
  const entries = [];
  const client = createClient({ baseUrl: fake.baseUrl, env: { FLAGSMITH_ADMIN_TOKEN: TOKEN }, projectId: PROJECT_ID, environmentKey: ENV_KEY, record: (e) => entries.push(e) });
  try {
    await client.getEnvironment();
    await client.createMetric(recorded('metric-create.request.json'));
    await assert.rejects(client.createExperiment({ name: 'x' }));
    assert.deepEqual(entries.map((e) => [e.route, e.method, e.status]), [
      ['getEnvironment', 'GET', 200], ['createMetric', 'POST', 201], ['createExperiment', 'POST', 400],
    ]);
    assert.equal(entries[0].path, 'api/v1/environments/<env key>/');
    assert.equal(JSON.parse(entries[0].response).api_key, '<env key>', 'the environment key in a response body is redacted');
    assert.deepEqual(entries[1].request, recorded('metric-create.request.json'));
    for (const e of entries) noSecrets(JSON.stringify(e));
  } finally { await fake.close(); }
});
