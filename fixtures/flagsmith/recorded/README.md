# Recorded Flagsmith responses

Real Admin API request and response bodies from the rehearsal on **Wed Nov 25, 2026** (Flagsmith Cloud, Development environment, before the hacking window). They were printed by `flagsmith api` with the environment key redacted, then re-indented here. No values were changed. The fake Flagsmith server in `test/helpers/fake-flagsmith.js` replays them.

| File | Call | Method and path |
|---|---|---|
| `metric-create.request.json`, `metric-create.response.json` | 19 | `POST api/v1/environments/<env key>/experiment-metrics/` |
| `experiment-create.request.json`, `experiment-create.response.json` | 21 | `POST api/v1/environments/<env key>/experiments/` |
| `experiment-start.response.json` | 23 | `POST api/v1/environments/<env key>/experiments/457/start/` |
| `experiment-get.response.json` | 24 | `GET api/v1/environments/<env key>/experiments/457/` |
| `results-get.response.json` | 26 | `GET api/v1/environments/<env key>/experiments/457/results/` |
| `warehouse-connections-get.response.json` | 27 | `GET api/v1/environments/<env key>/warehouse-connections/` |

Call 25, `POST .../experiments/457/results/refresh/`, returned an empty body. Its HTTP status code was not recorded.

The results numbers come from **scripted** traffic (300 users with `sim_` ids and made-up conversion rates). They are test data, not results.
