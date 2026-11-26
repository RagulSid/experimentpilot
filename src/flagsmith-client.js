// Flagsmith Admin API client: built-in fetch, no dependencies.
// Auth (docs.flagsmith.com, Management API > Authentication): "Authorization: Api-Key <token>".
// The token is read only from the FLAGSMITH_ADMIN_TOKEN environment variable, sent only in that
// header, and redacted from every log line and error message, as is the environment key.
//
// Each route says where its shape comes from: "recorded" = a real call in
// notes/flagsmith-calls.md (call number given); "guessed" = not yet seen for real.

export const ADMIN_API_BASE_URL = 'https://api.flagsmith.com/';
export const TOKEN_ENV = 'FLAGSMITH_ADMIN_TOKEN';
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export const ROUTES = {
  listFeatures: { method: 'GET', path: 'api/v1/projects/{project}/features/', source: 'guessed', note: 'search by name with ?search=' },
  createFeature: { method: 'POST', path: 'api/v1/projects/{project}/features/', source: 'guessed', note: 'rehearsal used the CLI (calls 15-17), not this route' },
  createMetric: { method: 'POST', path: 'api/v1/environments/{env}/experiment-metrics/', source: 'recorded', call: 19 },
  listExperiments: { method: 'GET', path: 'api/v1/environments/{env}/experiments/', source: 'guessed', note: 'only POST to this path was recorded' },
  createExperiment: { method: 'POST', path: 'api/v1/environments/{env}/experiments/', source: 'recorded', call: 21 },
  startExperiment: { method: 'POST', path: 'api/v1/environments/{env}/experiments/{id}/start/', source: 'recorded', call: 23 },
  getExperiment: { method: 'GET', path: 'api/v1/environments/{env}/experiments/{id}/', source: 'recorded', call: 24 },
  refreshResults: { method: 'POST', path: 'api/v1/environments/{env}/experiments/{id}/results/refresh/', source: 'recorded', call: 25, note: 'empty body; status code not recorded' },
  getResults: { method: 'GET', path: 'api/v1/environments/{env}/experiments/{id}/results/', source: 'recorded', call: 26 },
  getWarehouseConnections: { method: 'GET', path: 'api/v1/environments/{env}/warehouse-connections/', source: 'recorded', call: 27 },
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
  fetchImpl = globalThis.fetch,
  log = () => {},
  projectId,
  environmentKey,
} = {}) {
  const token = env[TOKEN_ENV];
  const base = new URL(baseUrl);

  const redact = (text) => {
    let out = String(text);
    if (token) out = out.split(token).join('<redacted>');
    if (environmentKey) out = out.split(environmentKey).join('<env key>');
    return out;
  };

  async function request(routeName, { id, query, body } = {}) {
    const route = ROUTES[routeName];
    const fill = (template, envValue) => template
      .replace('{project}', encodeURIComponent(String(projectId)))
      .replace('{env}', envValue)
      .replace('{id}', encodeURIComponent(String(id)));
    const path = fill(route.path, encodeURIComponent(String(environmentKey)));
    const shown = `${route.method} ${fill(route.path, '<env key>')}`;

    if (!token) throw new FlagsmithApiError(`${shown}: ${TOKEN_ENV} is not set; nothing was sent`, { route: routeName });

    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);

    const headers = { Authorization: `Api-Key ${token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    log(`-> ${shown}`);
    let res;
    try {
      res = await fetchImpl(url, { method: route.method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      throw new FlagsmithApiError(redact(`${shown}: Flagsmith could not be reached (${err.cause?.code ?? err.message})`), { route: routeName });
    }
    const text = await res.text();
    log(`<- ${res.status} ${shown}`);

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
    isLoopback: LOOPBACK_HOSTS.has(base.hostname),
    redact,
    listFeatures: async (name) => listOf(await request('listFeatures', { query: { search: name } })),
    createFeature: (body) => request('createFeature', { body }),
    createMetric: (body) => request('createMetric', { body }),
    listExperiments: async () => listOf(await request('listExperiments')),
    createExperiment: (body) => request('createExperiment', { body }),
    startExperiment: (id) => request('startExperiment', { id }),
    getExperiment: (id) => request('getExperiment', { id }),
    refreshResults: (id) => request('refreshResults', { id }),
    getResults: (id) => request('getResults', { id }),
    getWarehouseConnections: () => request('getWarehouseConnections'),
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
