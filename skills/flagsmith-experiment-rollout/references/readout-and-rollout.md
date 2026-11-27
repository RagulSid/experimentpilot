# Readout and rollout

## The three decisions (plain code: src/readout.js)

| Decision | When | What you say |
|---|---|---|
| `not_ready` | Flagsmith has no results yet, or the stop rule is not met (exposures per variation, or the fixed end time) | "Keep it running." Report the exposures only, never the lift |
| `no_clear_winner` | The stop rule is met, but the 95% credible interval includes zero, the chance to beat control is below the plan's threshold, the direction is wrong, or traffic did not split as configured (SRM p < 0.01) | "No clear winner", plus the Why lines |
| `winner_candidate` | The stop rule is met, the interval excludes zero in the plan's direction, and the chance to beat control is at least the threshold | "Candidate: `<key>`. You decide whether to roll it out" |

The readout reads Flagsmith's own numbers (exposures, conversions, lift, ci_low/ci_high, chance_to_win,
srm_p_value). Flagsmith's results do not separate `sim_` from `web_` visitors, so any run with scripted traffic
says so in its Traffic line. Repeat that line.

Refresh (`--refresh`) is allowed at most once every 5 minutes. When refresh is not allowed, the pilot reads the
current results and tells you.

## Completing the experiment (`--phase stop`)

`--rollout` is part of the approved diff, so the human approves the exact choice:

| Choice | Flagsmith call (`POST .../experiments/<id>/complete/`) | Allowed when |
|---|---|---|
| `control` | `{"rollout_decision":"control"}` | The stop rule is met. Recorded for real on Development (call 86) |
| `disable` | `{"rollout_decision":"disable"}` | The stop rule is met. In the OpenAPI spec, not yet recorded for real |
| `variant:<key>` | `{"rollout_decision":"variant","rollout_variant":<option id>}` | The readout says `winner_candidate` for that key. **Refused on real Flagsmith** until verified: the spec does not say which id `rollout_variant` takes |

So on real Flagsmith a winning variant is not yet rolled out automatically. Say so and offer `control` or
`disable`; the human can set the winning value in the dashboard after the experiment is completed.

Observed after completion (call 86-91): the experiment is `completed`, Flagsmith writes a new flag version
with the decided values, and the experiment rollout is removed. Whether the flag stays locked is **Unknown**:
no response field reports a lock.

Verify with `flagsmith flag get <key> -c ../flagsmith.json --jq '{enabled, value}'`.
