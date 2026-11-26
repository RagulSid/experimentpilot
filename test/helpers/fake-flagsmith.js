// A fake Flagsmith Admin API for tests (node:http, loopback only).
// Responses come from the real bodies recorded on Nov 25 (fixtures/flagsmith/recorded/).
// Routes never called for real yet follow the public OpenAPI spec
// (api.flagsmith.com/api/v1/swagger.json, read Nov 26) and are marked SWAGGER below.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const recorded = (name) => JSON.parse(readFileSync(new URL(`../../fixtures/flagsmith/recorded/${name}`, import.meta.url), 'utf8'));

export const PROVENANCE = {
  'GET warehouse-connections': 'recorded (call 27): body',
  'POST experiment-metrics': 'recorded (call 19): response shape and values; name/event echo the request',
  'POST experiments': 'recorded (call 21): response shape and values; name/hypothesis/feature echo the request',
  'POST start': 'recorded (call 23): response body; feature object reflects the created flag',
  'GET experiment': 'recorded (call 24): response body; status reflects fake state',
  'POST results/refresh': 'recorded (call 25): empty body. GUESSED: status 202 (code not recorded; Swagger says 200)',
  'GET results': 'recorded (call 26): body',
  'refresh rate limit': 'DOCUMENTED: at most once every 5 minutes. GUESSED: status 429 and its body',
  'GET environment': 'SWAGGER api_v1_environments_retrieve: fields id, uuid, name, api_key, project',
  'GET features (search)': 'SWAGGER list_project_features: ?search=, paginated {count, next, previous, results}',
  'POST features': 'SWAGGER create_feature (ListFeature); nested option keys are read-only, so no options here',
  'POST mv-options': 'SWAGGER MultivariateFeatureOption: key writable, feature required; values from call 23',
  'GET experiments (list)': 'SWAGGER list_experiments: ?q= searches experiment or feature name, paginated',
  'errors (401, 404, 4xx, 5xx bodies)': 'GUESSED: {"detail": ...} bodies',
};

export async function startFakeFlagsmith({
  token,
  environmentKey,
  environmentName = 'Development',
  projectId,
  existingFeatures = [],
  existingExperiments = [],
  failures = {},              // e.g. { 'POST experiments': 400, 'POST experiment-metrics': 503 }
  echoAuthorizationInErrors = false,
  refreshIntervalMs = 5 * 60 * 1000,
} = {}) {
  const requests = [];
  const state = {
    features: existingFeatures.map((f) => ({ ...f })),
    experiments: existingExperiments.map((e) => ({ ...e })),
    feature: null,
    lastRefreshAt: null,
  };

  const send = (res, status, body) => {
    if (body === undefined) { res.writeHead(status).end(); return; }
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  };

  const route = (method, path) => {
    const env = `/api/v1/environments/${environmentKey}`;
    const project = `/api/v1/projects/${projectId}`;
    if (method === 'GET' && path === `${env}/`) return ['GET environment'];
    if (method === 'GET' && path === `${env}/warehouse-connections/`) return ['GET warehouse-connections'];
    if (method === 'POST' && path === `${env}/experiment-metrics/`) return ['POST experiment-metrics'];
    if (method === 'GET' && path === `${env}/experiments/`) return ['GET experiments (list)'];
    if (method === 'POST' && path === `${env}/experiments/`) return ['POST experiments'];
    let m = path.match(new RegExp(`^${env}/experiments/(\\d+)/start/$`));
    if (method === 'POST' && m) return ['POST start', Number(m[1])];
    m = path.match(new RegExp(`^${env}/experiments/(\\d+)/results/refresh/$`));
    if (method === 'POST' && m) return ['POST results/refresh', Number(m[1])];
    m = path.match(new RegExp(`^${env}/experiments/(\\d+)/results/$`));
    if (method === 'GET' && m) return ['GET results', Number(m[1])];
    m = path.match(new RegExp(`^${env}/experiments/(\\d+)/$`));
    if (method === 'GET' && m) return ['GET experiment', Number(m[1])];
    if (method === 'GET' && path === `${project}/features/`) return ['GET features (search)'];
    if (method === 'POST' && path === `${project}/features/`) return ['POST features'];
    m = path.match(new RegExp(`^${project}/features/(\\d+)/mv-options/$`));
    if (method === 'POST' && m) return ['POST mv-options', Number(m[1])];
    return [null];
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const [name, id] = route(req.method, url.pathname);
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body, raw, route: name });

    if (req.headers.authorization !== `Api-Key ${token}`) {
      return send(res, 401, { detail: 'Authentication credentials were not provided.' });
    }
    if (!name) return send(res, 404, { detail: 'Not found.' });
    if (failures[name]) {
      const detail = failures[name] >= 500 ? 'Internal server error' : 'Invalid request';
      return send(res, failures[name], echoAuthorizationInErrors ? { detail, received_authorization: req.headers.authorization } : { detail });
    }

    switch (name) {
      case 'GET environment':
        return send(res, 200, { id: 119869, uuid: '00000000-0000-4000-8000-000000119869', name: environmentName, api_key: environmentKey, description: null, project: projectId });
      case 'GET warehouse-connections':
        return send(res, 200, recorded('warehouse-connections-get.response.json'));
      case 'POST experiment-metrics':
        return send(res, 201, { ...recorded('metric-create.response.json'), name: body.name, direction: body.direction, definition: body.definition });
      case 'GET features (search)': {
        const search = url.searchParams.get('search') ?? '';
        const results = state.features.filter((f) => f.name.includes(search));
        return send(res, 200, { count: results.length, next: null, previous: null, results });
      }
      case 'POST features': {
        state.feature = {
          id: 303389, name: body.name, type: body.type ?? 'STANDARD', default_enabled: body.default_enabled ?? false,
          initial_value: body.initial_value ?? null, description: body.description ?? null, multivariate_options: [], project: projectId,
        };
        state.features.push(state.feature);
        return send(res, 201, state.feature);
      }
      case 'POST mv-options': {
        if (!state.feature || state.feature.id !== id || body.feature !== id) return send(res, 400, { detail: 'Invalid feature.' });
        const n = state.feature.multivariate_options.length;
        const option = {
          id: 36697 + n, uuid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, type: body.type,
          integer_value: null, string_value: body.string_value, boolean_value: null,
          default_percentage_allocation: body.default_percentage_allocation ?? 0, key: body.key ?? null, feature: id,
        };
        state.feature.multivariate_options.push(option);
        state.feature.type = 'MULTIVARIATE';
        return send(res, 201, option);
      }
      case 'GET experiments (list)': {
        const q = url.searchParams.get('q') ?? '';
        const results = state.experiments.filter((e) => e.name.includes(q) || (e.feature?.name ?? '').includes(q));
        return send(res, 200, { count: results.length, next: null, previous: null, results });
      }
      case 'POST experiments': {
        const created = { ...recorded('experiment-create.response.json'), feature: body.feature, name: body.name, hypothesis: body.hypothesis, status: 'created' };
        state.experiments.push({ ...created, feature: { id: body.feature, name: state.feature?.name } });
        return send(res, 201, created);
      }
      case 'POST start': {
        const exp = state.experiments.find((e) => e.id === id);
        if (!exp) return send(res, 404, { detail: 'Not found.' });
        exp.status = 'running';
        return send(res, 200, { ...recorded('experiment-start.response.json'), name: exp.name, hypothesis: exp.hypothesis });
      }
      case 'GET experiment': {
        const exp = state.experiments.find((e) => e.id === id);
        if (!exp) return send(res, 404, { detail: 'Not found.' });
        return send(res, 200, { ...recorded('experiment-get.response.json'), name: exp.name, status: exp.status });
      }
      case 'POST results/refresh': {
        const now = Date.now();
        if (state.lastRefreshAt !== null && now - state.lastRefreshAt < refreshIntervalMs) {
          return send(res, 429, { detail: 'Request was throttled. Expected available in 300 seconds.' });
        }
        state.lastRefreshAt = now;
        return send(res, 202);
      }
      case 'GET results':
        return send(res, 200, recorded('results-get.response.json'));
      default:
        return send(res, 404, { detail: 'Not found.' });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    requests,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
