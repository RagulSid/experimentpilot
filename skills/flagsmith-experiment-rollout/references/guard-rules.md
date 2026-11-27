# Guard rules G1-G10 in plain words

The guard is plain code (`src/guard.js`, no AI). It runs inside `diff`, `approve` and `apply`, and it lists
every broken rule at once. Fix the plan or the app code. Never edit the guard to get a pass.

| Rule | What it means | Typical fix |
|---|---|---|
| G1 | The flag is multivariate | `"flag": { "type": "multivariate" }` |
| G2 | At least 2 variations, each with a unique non-empty key; exactly one is `control`, and no other variation reuses that key. A variation without a key records no exposures | Give each variation a key; keep exactly one `control` |
| G3 | The split has one share per variation, each above 0, summing to 100 | `{"control": 50, "variant_b": 50}` |
| G4 | Exactly one primary metric with `name`, `event` and `direction`, fixed before the start, with no extra metrics | Remove `metrics` lists and extra fields; set `decisionRule.primaryMetric` to `metric.name` |
| G5 | One stable visitor id is used for both the flag and the events. Real ids start `web_`, scripted ids start `sim_`, and the two are reported separately | `identity.usedFor: ["flag","events"]`, the prefixes as given, and an honest `traffic` |
| G6 | A pre-registered stop rule, never "stop when significant" | `minExposuresPerVariant` or `fixedEnd` |
| G7 | No "peek", "decide early" or "stop once significant" wording anywhere in the plan | Reword the text |
| G8 | The metric's event equals the app's event constant exactly (case-sensitive). A mismatch is silently never counted | Use the constant's exact value, for example `cta_clicked` |
| G9 | The environment is allowed (Development; Production only with `--allow-production` after an explicit human instruction), and the flag key is not used by a started experiment | Use Development and a new flag key |
| G10 | The app has a fallback constant equal to the control value, so it still works when Flagsmith is unreachable | `const FALLBACK_VALUE = 'control'` in the app |

Limits: G8 and G10 read the app as text and look for `const NAME = '...'`. A name built at run time is not
found and the plan is rejected (fails closed).

The pilot also refuses these outside the guard: an existing flag, experiment or metric name; a binding whose
environment name differs from the plan; a missing or stale approval; a `down` metric or a variant rollout on
real Flagsmith (not yet verified); and completing before the stop rule is met.
