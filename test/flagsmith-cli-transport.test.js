// The CLI transport: the pilot's Admin API calls travel through the real Flagsmith CLI
// (`flagsmith api <path> -X <method> --input - -i`), so the CLI's own login is used and no
// admin token is needed. Output formats below were captured from flagsmith v2.0.0 on
// 2026-11-27 (real binary against a loopback server; and one real GET on Development).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeFlagsmith } from './helpers/fake-flagsmith.js';

const ENV_KEY = 'FakeEnvKey000000000001';
const PROJECT = 55988;
// Shaped like a Master API key ({prefix}.{secret}), which the CLI requires; built at run time.
const TOKEN = ['testprefix', 'testsecret'].join('.');

const cliEnv = (baseUrl) => {
  const { hostname, port } = new URL(baseUrl);
  return { ...process.env, [`FLAGSMITH_API_KEY_${hostname.replaceAll('.', '_')}_${port}`]: TOKEN };
};

test('parseIncluded reads status and body from `-i` output (HTTP/1.1, mixed line endings)', async () => {
  const { parseIncluded } = await import('../src/flagsmith-cli-transport.js');
  const out = 'HTTP/1.1 201 Created\nConnection: keep-alive\r\nContent-Type: application/json\r\nDate: Fri, 27 Nov 2026 04:39:32 GMT\r\nKeep-Alive: timeout=5\r\n\n{"id":7,"name":"x"}';
  assert.deepEqual(parseIncluded(out), { status: 201, body: '{"id":7,"name":"x"}' });
});

test('parseIncluded handles an empty 202 body and HTTP/2.0 status lines', async () => {
  const { parseIncluded } = await import('../src/flagsmith-cli-transport.js');
  assert.deepEqual(parseIncluded('HTTP/1.1 202 Accepted\nConnection: keep-alive\r\nDate: x\r\nKeep-Alive: timeout=5\r\n\n'), { status: 202, body: '' });
  assert.deepEqual(parseIncluded('HTTP/2.0 200 OK\r\nAllow: GET\r\nContent-Type: application/json\r\n\r\n{"name":"Development"}'), { status: 200, body: '{"name":"Development"}' });
  assert.throws(() => parseIncluded('{"no":"status line"}'), /status line/);
});

test('parseFailure reads the HTTP status and body from stderr, and keeps non-HTTP failures as errors', async () => {
  const { parseFailure } = await import('../src/flagsmith-cli-transport.js');
  const stderr = '{"detail":"bad thing"}\nError: GET http://127.0.0.1:50812/api/v1/x/404/ returned 400 Bad Request\nThink this shouldn\'t happen? Tell us: https://github.com/Flagsmith/flagsmith-cli/issues/new\n';
  assert.deepEqual(parseFailure(stderr), { status: 400, body: '{"detail":"bad thing"}' });
  assert.equal(parseFailure('Error: not logged in\nRun `flagsmith login`, or set FLAGSMITH_API_KEY_X for non-interactive use.\n'), null);
});

test('cliArgs builds `flagsmith api` arguments; the default host is left to the CLI (its stored login)', async () => {
  const { cliArgs } = await import('../src/flagsmith-cli-transport.js');
  assert.deepEqual(
    cliArgs(new URL('https://api.flagsmith.com/api/v1/environments/k/experiments/?q=a+b'), { method: 'GET' }),
    ['api', 'api/v1/environments/k/experiments/?q=a+b', '-X', 'GET', '-i', '--no-input'],
  );
  assert.deepEqual(
    cliArgs(new URL('http://127.0.0.1:9/api/v1/x/'), { method: 'POST', body: '{}' }),
    ['api', 'api/v1/x/', '-X', 'POST', '-i', '--no-input', '--api-url', 'http://127.0.0.1:9', '--input', '-'],
  );
});

test('resolveFlagsmithBin finds the native binary (the npm wrapper hides exit codes), or FLAGSMITH_BIN', async () => {
  const { resolveFlagsmithBin } = await import('../src/flagsmith-cli-transport.js');
  assert.equal(resolveFlagsmithBin({ FLAGSMITH_BIN: '/opt/flagsmith' }), '/opt/flagsmith');
  const bin = resolveFlagsmithBin({});
  assert.ok(bin, 'native binary from the @flagsmith/cli devDependency');
  assert.match(bin, /cli_(windows|linux|darwin)_(amd64|arm64)[\\/]flagsmith(\.exe)?$/);
});

test('real CLI binary: the client reads, writes with the exact JSON body, and needs no admin token', async () => {
  const { createClient } = await import('../src/flagsmith-client.js');
  const fake = await startFakeFlagsmith({ token: TOKEN, environmentKey: ENV_KEY, projectId: PROJECT });
  try {
    const env = cliEnv(fake.baseUrl);
    delete env.FLAGSMITH_ADMIN_TOKEN;
    const client = createClient({ baseUrl: fake.baseUrl, env, transport: 'cli', projectId: PROJECT, environmentKey: ENV_KEY });
    assert.equal((await client.getEnvironment()).name, 'Development');
    const body = { name: 'skill_flag', type: 'MULTIVARIATE', initial_value: 'control', default_enabled: true };
    const created = await client.createFeature(body);
    assert.equal(created.name, 'skill_flag');
    const post = fake.requests.find((r) => r.route === 'POST features');
    assert.deepEqual(post.body, body);
    assert.equal(post.headers['content-type'], 'application/json');
    assert.deepEqual((await client.listFeatures('skill_flag')).map((f) => f.name), ['skill_flag']);
  } finally {
    await fake.close();
  }
});

test('real CLI binary: an HTTP error becomes a FlagsmithApiError with its status, and the env key is redacted', async () => {
  const { createClient, FlagsmithApiError } = await import('../src/flagsmith-client.js');
  const fake = await startFakeFlagsmith({ token: TOKEN, environmentKey: ENV_KEY, projectId: PROJECT, failures: { 'POST experiments': 400 } });
  try {
    const client = createClient({ baseUrl: fake.baseUrl, env: cliEnv(fake.baseUrl), transport: 'cli', projectId: PROJECT, environmentKey: ENV_KEY });
    await assert.rejects(client.createExperiment({ name: 'x' }), (err) => {
      assert.ok(err instanceof FlagsmithApiError);
      assert.equal(err.status, 400);
      assert.match(err.message, /Invalid request/);
      assert.ok(!err.message.includes(ENV_KEY), 'environment key must not appear');
      return true;
    });
  } finally {
    await fake.close();
  }
});

test('real CLI binary: a 202 with an empty body (results refresh) returns null', async () => {
  const { createClient } = await import('../src/flagsmith-client.js');
  const fake = await startFakeFlagsmith({ token: TOKEN, environmentKey: ENV_KEY, projectId: PROJECT });
  try {
    const client = createClient({ baseUrl: fake.baseUrl, env: cliEnv(fake.baseUrl), transport: 'cli', projectId: PROJECT, environmentKey: ENV_KEY });
    assert.equal(await client.refreshResults(1), null);
  } finally {
    await fake.close();
  }
});

test('real CLI binary: not logged in is a clear failure that names the fix, without the env key', async () => {
  const { createClient } = await import('../src/flagsmith-client.js');
  const fake = await startFakeFlagsmith({ token: TOKEN, environmentKey: ENV_KEY, projectId: PROJECT });
  try {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith('FLAGSMITH_')) delete env[k];
    const client = createClient({ baseUrl: fake.baseUrl, env, transport: 'cli', projectId: PROJECT, environmentKey: ENV_KEY });
    await assert.rejects(client.getEnvironment(), (err) => {
      assert.match(err.message, /not logged in/);
      assert.ok(!err.message.includes(ENV_KEY));
      return true;
    });
    assert.equal(fake.requests.length, 0, 'nothing reached the server');
  } finally {
    await fake.close();
  }
});
