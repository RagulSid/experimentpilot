// Flagsmith Admin API client: built-in fetch, no dependencies.
// Auth (docs.flagsmith.com, Management API > Authentication): "Authorization: Api-Key <token>".
// The token is read only from the FLAGSMITH_ADMIN_TOKEN environment variable, sent only in that
// header, and redacted from every log line, error message and recording, as is the
// environment key.
//
// Each route says where its shape comes from:
//   "recorded" = a real call in notes/flagsmith-calls.md (call number given)
//   "swagger"  = the public OpenAPI spec, api.flagsmith.com/api/v1/swagger.json (operationId given),
//                not yet seen working for real. Calls 29-34 (real CREATE run, Nov 26) moved
//                every such route to "recorded"; their operationIds are kept for reference
//   "guessed"  = neither; the applier refuses to send these to a real Flagsmith host

import { createCliFetch } from './flagsmith-cli-transport.js';

export const ADMIN_API_BASE_URL = 'https://api.flagsmith.com/';
export const TOKEN_ENV = 'FLAGSMITH_ADMIN_TOKEN';
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export const ROUTES = {
  getEnvironment: { method: 'GET', path: 'api/v1/environments/{env}/', source: 'recorded', call: 29, operationId: 'api_v1_environments_retrieve' },
  listFeatures: { method: 'GET', path: 'api/v1/projects/{project}/features/', source: 'recorded', call: 30, operationId: 'list_project_features', note: '?search=, paginated' },
  createFeature: { method: 'POST', path: 'api/v1/projects/{project}/features/', source: 'recorded', call: 33, operationId: 'create_feature', note: 'nested option keys are read-only, so variations are added separately' },
  createVariation: { method: 'POST', path: 'api/v1/projects/{project}/features/{feature}/mv-options/', source: 'recorded', call: 34, operationId: 'create_feature_multivariate_option', note: 'key writable, feature required' },
  listExperiments: { method: 'GET', path: 'api/v1/environments/{env}/experiments/', source: 'recorded', call: 31, operationId: 'list_experiments', note: '?q= searches experiment or feature name, paginated' },
  listMetrics: { method: 'GET', path: 'api/v1/environments/{env}/experiment-metrics/', source: 'recorded', call: 32, operationId: 'list_metrics', note: '?q=, paginated' },
  createMetric: { method: 'POST', path: 'api/v1/environments/{env}/experiment-metrics/', source: 'recorded', call: 19 },
  createExperiment: { method: 'POST', path: 'api/v1/environments/{env}/experiments/', source: 'recorded', call: 21 },
  startExperiment: { method: 'POST', path: 'api/v1/environments/{env}/experiments/{id}/start/', source: 'recorded', call: 23 },
  getExperiment: { method: 'GET', path: 'api/v1/environments/{env}/experiments/{id}/', source: 'recorded', call: 24 },
  refreshResults: { method: 'POST', path: 'api/v1/environments/{env}/experiments/{id}/results/refresh/', source: 'recorded', call: 25, note: 'empty body; status code not recorded' },
  getResults: { method: 'GET', path: 'api/v1/environments/{env}/experiments/{id}/results/', source: 'recorded', call: 26 },
  getWarehouseConnections: { method: 'GET', path: 'api/v1/environments/{env}/warehouse-connections/', source: 'recorded', call: 27 },
  completeExperiment: { method: 'POST', path: 'api/v1/environments/{env}/experiments/{id}/complete/', source: 'recorded', call: 86, operationId: 'api_v1_environments_experiments_complete_create', note: 'body {rollout_decision: control|variant|disable, rollout_variant?: integer}; 200 with the experiment (status completed, ended_at, rollout_decision). Only rollout_decision control has been recorded' },
};

export class FlagsmithApiError extends Error {
  constructor(message, { status = null, route = null, rateLimited = false } = {}) {
    super(message);
    this.name = 'FlagsmithApiError';
    this.status = status;
    this.route = route;
    this.rateLimited = rateLimited;
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function createClient({
  baseUrl = ADMIN_API_BASE_URL,
  env = process.env,
  transport = 'fetch',       // 'fetch' (admin token) or 'cli' (the Flagsmith CLI's own login; src/flagsmith-cli-transport.js)
  fetchImpl = transport === 'cli' ? createCliFetch({ env }) : globalThis.fetch,
  log = () => {},
  record = null,            // optional: receives { route, method, path, status, request, response }, redacted
  projectId,
  environmentKey,
} = {}) {
  if (!['fetch', 'cli'].includes(transport)) throw new Error(`unknown transport ${JSON.stringify(transport)}`);
  const viaCli = transport === 'cli';
  const token = viaCli ? undefined : env[TOKEN_ENV];
  const base = new URL(baseUrl);

  const redact = (text) => {
    let out = String(text);
    if (token) out = out.split(token).join('<redacted>');
    if (environmentKey) out = out.split(environmentKey).join('<env key>');
    return out;
  };

  async function request(routeName, { id, feature, query, body } = {}) {
    const route = ROUTES[routeName];
    const fill = (template, envValue) => template
      .replace('{project}', encodeURIComponent(String(projectId)))
      .replace('{env}', envValue)
      .replace('{feature}', encodeURIComponent(String(feature)))
      .replace('{id}', encodeURIComponent(String(id)));
    const path = fill(route.path, encodeURIComponent(String(environmentKey)));
    const shownPath = fill(route.path, '<env key>');
    const shown = `${route.method} ${shownPath}`;

    if (!token && !viaCli) throw new FlagsmithApiError(`${shown}: ${TOKEN_ENV} is not set; nothing was sent`, { route: routeName });

    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

    const headers = viaCli ? { Accept: 'application/json' } : { Authorization: `Api-Key ${token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    log(`-> ${shown}${url.search ? redact(url.search) : ''}`);
    let res;
    try {
      res = await fetchImpl(url, { method: route.method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      const why = viaCli ? err.message : `Flagsmith could not be reached (${err.cause?.code ?? err.message})`;
      throw new FlagsmithApiError(redact(`${shown}: ${why}`), { route: routeName });
    }
    const text = await res.text();
    log(`<- ${res.status} ${shown}`);
    if (record) {
      record({
        route: routeName,
        method: route.method,
        path: shownPath,
        query: query ? JSON.parse(redact(JSON.stringify(query))) : null,
        status: res.status,
        request: body === undefined ? null : JSON.parse(redact(JSON.stringify(body))),
        response: redact(text),
      });
    }

    if (!res.ok) {
      const rateLimited = res.status === 429;
      const hint = rateLimited ? ' (rate limited: results refresh is allowed at most once every 5 minutes)' : '';
      throw new FlagsmithApiError(redact(`${shown} failed with ${res.status}${hint}: ${text.slice(0, 300)}`), { status: res.status, route: routeName, rateLimited });
    }
    if (text === '') return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new FlagsmithApiError(redact(`${shown} returned a body that is not JSON: ${text.slice(0, 120)}`), { status: res.status, route: routeName });
    }
  }

  const listOf = (body) => (Array.isArray(body) ? body : body?.results ?? []);

  return {
    baseUrl: base.href,
    transport,
    isLoopback: LOOPBACK_HOSTS.has(base.hostname),
    redact,
    getEnvironment: () => request('getEnvironment'),
    listFeatures: async (search) => listOf(await request('listFeatures', { query: { search } })),
    createFeature: (body) => request('createFeature', { body }),
    createVariation: (featureId, body) => request('createVariation', { feature: featureId, body }),
    listExperiments: async (q) => listOf(await request('listExperiments', { query: q === undefined ? undefined : { q } })),
    listMetrics: async (q) => listOf(await request('listMetrics', { query: q === undefined ? undefined : { q } })),
    createMetric: (body) => request('createMetric', { body }),
    createExperiment: (body) => request('createExperiment', { body }),
    startExperiment: (id) => request('startExperiment', { id }),
    getExperiment: (id) => request('getExperiment', { id }),
    refreshResults: (id) => request('refreshResults', { id }),
    getResults: (id) => request('getResults', { id }),
    getWarehouseConnections: () => request('getWarehouseConnections'),
    completeExperiment: (id, body) => request('completeExperiment', { id, body }),
  };
}

// Whether a results refresh is allowed now, from the results body's refresh_requested_at
// (recorded field, call 26) and the documented limit of once every 5 minutes.
export function canRefresh(resultsBody, now = new Date()) {
  const requestedAt = resultsBody?.results?.refresh_requested_at;
  if (!requestedAt) return { ok: true, waitMs: 0 };
  const waitMs = Math.max(0, Date.parse(requestedAt) + REFRESH_INTERVAL_MS - now.getTime());
  return { ok: waitMs === 0, waitMs };
}
