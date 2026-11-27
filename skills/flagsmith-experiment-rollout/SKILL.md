---
name: flagsmith-experiment-rollout
description: Runs a Flagsmith A/B experiment end to end and rolls out the result safely - plan, G1-G10 guard, a human-approved exact diff, create, start after deploy, an honest readout (not_ready / no_clear_winner / winner_candidate), then complete with control, variant or disable. Uses the Flagsmith CLI with --jq and the ExperimentPilot repo. Use when asked to A/B test or experiment on a Flagsmith flag, read an experiment's result, or roll out or end an experiment.
license: MIT
compatibility: Run from the ExperimentPilot repo root. Needs Node 22+, bash, and Flagsmith CLI v2 logged in (flagsmith login). Development environment by default.
metadata:
  version: "0.1.0"
  verified-with: "flagsmith CLI v2.0.0, Flagsmith Cloud, 2026-11-27"
---

# Flagsmith experiment rollout

You take one sentence ("test whether X increases Y") through the whole job. The person approves every
change in their own terminal; plain code (the guard, the approval hash, the readout) makes the decisions.

## Hard rules

- **Never approve.** Only the human runs `node src/approve.js` in their own terminal. Never pipe or type into it, never write `approvals/`.
- **Development by default.** Production only if the human explicitly says so in this conversation; then add `--allow-production` and a Production binding.
- **Never print keys.** Never run `flagsmith auth token`; never cat `flagsmith*.json`, `.env` or `*.local.js`; never put an environment key on a command line. The status helper and the pilot read it from the binding file.
- **Never edit an existing flag.** Do not run `flagsmith feature update`, `flagsmith feature delete`, `flagsmith feature variant add`, `flagsmith flag update` or `flagsmith flag disable`. If the flag key exists, pick a new key.
- **Every write goes through the pilot** (`node src/cli.js apply ... --apply --via-cli`), which checks the approval file against the plan and diff hashes. Do not run `flagsmith feature create` or `flagsmith api -X POST` yourself.
- **No peeking.** Do not read lift or intervals before the readout says the stop rule is met. Name a winner only when the readout says `winner_candidate`. Never change the plan after CREATE.
- **On any error, stop.** Show the exact error (keys redacted) and ask. Never work around it.

## Token rules

- Orient with one call: `node skills/flagsmith-experiment-rollout/scripts/status.mjs plans/<id>.json --config ../flagsmith.json --app <app file>` (about 4 lines, ends with `next:`).
- Every direct `flagsmith` call uses `--jq` and returns only the fields you need, for example `flagsmith feature list -c ../flagsmith.json --jq '[.[] | select(.name=="<key>")] | length'`.
- Use `node src/cli.js`, not `npm run pilot --` (no npm banner; PowerShell drops a bare `--`).
- Quote pilot output only as far as needed: the full diff once, the readout's Decision/Why/Traffic lines.

The binding file (`flagsmith.json`, git-ignored; do not edit it) is `../flagsmith.json` in this repo.

## Workflow

**1. Plan.** Read the app code: find the event constant (for example `const CTA_EVENT = 'cta_clicked'`) and
the fallback constant equal to the control value. Write `plans/<id>.json` as in
[references/plan-format.md](references/plan-format.md). Use a new flag key and confirm it is free:
`flagsmith feature list -c ../flagsmith.json --jq '[.[] | select(.name=="<key>")] | length'` must print `0`.

**2. Guard and diff.** Run `node src/cli.js diff plans/<id>.json --app <app file> --phase create`.
On `REFUSED (guard): Gn ...`, fix the plan as [references/guard-rules.md](references/guard-rules.md) says and run it again.
Never weaken a rule to make it pass.

**3. STOP for approval.** Show the human the full diff and its hashes, then stop and ask the human to run, in their own terminal:
- human, own terminal: `node src/approve.js plans/<id>.json --app <app file> --phase create`

Wait until they say "approved". Then check that the status helper shows `create yes`.

**4. Create.** Run `node src/cli.js apply plans/<id>.json --app <app file> --phase create --via-cli --config ../flagsmith.json`
(a dry run that sends nothing), then the same with `--apply`. It creates the flag, the keyed variation, the metric
and the experiment (not started). Check that the status helper shows `experiment <n> created`.

**5. STOP for deploy, then start.** Ask: "Is the app that reads `<key>` and sends `<event>` deployed?" Only after
they say yes: show `node src/cli.js diff plans/<id>.json --app <app file> --phase start`, then stop for approval:
- human, own terminal: `node src/approve.js plans/<id>.json --app <app file> --phase start`

After "approved", run `node src/cli.js apply plans/<id>.json --app <app file> --phase start --apply --via-cli --config ../flagsmith.json`.
Check that the status helper shows `running`.

**6. Readout.** Run `node src/cli.js readout plans/<id>.json --refresh --via-cli --config ../flagsmith.json`.
Refresh is allowed at most once every 5 minutes. Report the decision word for word:
- `not_ready`: the stop rule is not met. Say "keep it running" and report only the exposures.
- `no_clear_winner`: the stop rule is met and the interval includes zero (or another reason given). Say "no clear winner".
- `winner_candidate`: the stop rule is met, the interval excludes zero and the threshold is met. The human still decides.
Always repeat the Traffic line: scripted `sim_` traffic is never evidence about real users.

**7. Complete.** Only after the readout is not `not_ready`, ask the human to choose `control`, `disable` or
`variant:<key>` (variant only when the readout named it). Rules and limits are in
[references/readout-and-rollout.md](references/readout-and-rollout.md). Show
`node src/cli.js diff plans/<id>.json --app <app file> --phase stop --rollout <choice>`, then stop for approval:
- human, own terminal: `node src/approve.js plans/<id>.json --app <app file> --phase stop --rollout <choice>`

After "approved", run `node src/cli.js apply plans/<id>.json --app <app file> --phase stop --rollout <choice> --apply --via-cli --config ../flagsmith.json`.

**8. Verify what visitors now get.**
`flagsmith flag get <key> -c ../flagsmith.json --jq '{enabled, value}'` and
`flagsmith evaluate <key> --identity sim_check_0001 -c ../flagsmith.json --jq '{value, variant}'`.
Run `evaluate` only after completion: an identity evaluated while the experiment runs may count as a visitor.

## What the CLI cannot do

Flagsmith CLI v2.0.0 has no `experiment`, `metric` or `results` command. Creating a metric or experiment,
starting it, reading or refreshing results, and completing it go through the pilot's commands above.
The pilot sends those calls through the CLI's own login (`--via-cli`, transport `flagsmith api`).
Full table and the verified commands: [references/cli-commands.md](references/cli-commands.md).
