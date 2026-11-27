# Plan file: plans/<id>.json

One JSON file per experiment. The guard (G1-G10) and the approval hashes are computed from it, so do not edit
it after CREATE is approved: any change invalidates the approval and the pilot refuses.

```json
{
  "id": "skill_demo_1",
  "sentence": "Test whether a headline that offers a sample digest gets more Get started clicks.",
  "hypothesis": "Showing \"See today's digest\" instead of \"Your creator digest\" increases Get started clicks.",
  "environment": "Development",
  "flag": {
    "key": "skill_demo_1",
    "type": "multivariate",
    "variants": [
      { "key": "control", "value": "control" },
      { "key": "variant_b", "value": "variant_b" }
    ]
  },
  "metric": { "name": "Get started clicks (skill_demo_1)", "event": "cta_clicked", "direction": "up" },
  "split": { "control": 50, "variant_b": 50 },
  "identity": {
    "source": "visitor id generated on first visit and kept in localStorage",
    "usedFor": ["flag", "events"],
    "prefixReal": "web_",
    "prefixScripted": "sim_"
  },
  "stopRule": { "type": "minExposuresPerVariant", "value": 150 },
  "decisionRule": { "primaryMetric": "Get started clicks (skill_demo_1)", "winProbabilityAtLeast": 0.95, "intervalExcludesZero": true },
  "traffic": { "real": false, "scripted": true }
}
```

| Field | Rule |
|---|---|
| `id` | Also the experiment's name in Flagsmith. New and unique |
| `environment` | `Development`, unless the human explicitly asked for `Production` |
| `flag.key` | A new key: the pilot never touches an existing flag |
| `flag.variants` | Exactly one `control`; every other variation has its own key |
| `metric.name` | New in this environment: the pilot refuses an existing metric name. Add the plan id to keep it unique |
| `metric.event` | Byte for byte equal to the app's event constant (case-sensitive) |
| `metric.direction` | `up` (only `up` has been verified against the real API; `down` is refused there) |
| `split` | One share per variation, each above 0, summing to 100 |
| `stopRule` | `minExposuresPerVariant` (a whole number) or `fixedEnd` (ISO date-time with offset) |
| `decisionRule.primaryMetric` | Equal to `metric.name` |
| `traffic` | Say honestly whether real (`web_`) and/or scripted (`sim_`) visitors will be counted |

No `metrics` list, no extra metric fields, and no words like "peek" or "stop early" anywhere: the guard rejects them.
