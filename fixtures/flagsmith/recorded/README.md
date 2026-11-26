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

## `2026-11-26-create/`: real CREATE run, Thu Nov 26, 2026, 14:14 IST (inside the hacking window)

ExperimentPilot's first real run against Flagsmith Cloud, Development environment. It was approved by a person (`approvals/pilot_rehearsal_1.create.json`) and run with `npm run pilot -- apply ... --phase create --apply --record ...`. The client redacted every file as it was written: the environment key reads `<env key>`, and the admin token never appears. **The experiment was not started.**

| File | Call | Result |
|---|---|---|
| `01-getEnvironment.json` | 29 `GET api/v1/environments/<env key>/` | 200, name `Development` |
| `02-listFeatures.json` | 30 `GET api/v1/projects/55988/features/?search=` | 200, count 0 |
| `03-listExperiments.json` | 31 `GET .../experiments/?q=` | 200, count 0, plus `status_counts` (not in the OpenAPI schema) |
| `04-listMetrics.json` | 32 `GET .../experiment-metrics/?q=` | 200, count 0 |
| `05-createFeature.json` | 33 `POST api/v1/projects/55988/features/` | 201, flag 305157, MULTIVARIATE, no options |
| `06-createVariation.json` | 34 `POST .../features/305157/mv-options/` | 201, option 37083, key `variant_b` |
| `07-createMetric.json` | 35 `POST .../experiment-metrics/` | 201, metric 577 |
| `08-createExperiment.json` | 36 `POST .../experiments/` | 201, experiment 579, status `created` |
