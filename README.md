# ExperimentPilot

You describe an experiment in one sentence. An agent drafts the Flagsmith experiment, plain code rejects anything unsafe, a person approves the exact change, and plain code reads the result honestly.

Entry for **Toggle Wars** (WeMakeDevs x Flagsmith), **Track 02: AI Agents and Feature Flags**.

## Status

Built step by step during the hacking window (Thu Nov 26 to Sun Nov 29, 2026). This README only describes what exists in the repo at each commit.

- Repo skeleton, MIT licence and CI on Ubuntu and Windows (`npm test`).
- **Guard** ([src/guard.js](src/guard.js)): plain code, no AI. Checks a plan against rules G1 to G10 and returns every violated rule with a reason. One test per rule in [test/guard.test.js](test/guard.test.js), written first and committed failing, then made to pass.

| Rule | The guard rejects a plan unless |
|---|---|
| G1 | the flag is multivariate |
| G2 | there are at least 2 variations, every key is unique and non-empty, exactly one is the control, and "control" is not reused |
| G3 | the split sums to 100 and every share is above 0 |
| G4 | there is exactly one primary metric with name, event and direction, fixed before the start |
| G5 | one stable id is used for both flag and events; real ids start `web_`, scripted ids start `sim_` |
| G6 | a stop rule exists (minimum exposures per variation, or a fixed end) and is not "stop when significant" |
| G7 | no peeking or "decide early" wording appears anywhere in the plan |
| G8 | the metric's event name equals exactly one string constant in the app code, case included |
| G9 | the environment is Development (Production only when explicitly allowed) and the flag key is not used by a started experiment |
| G10 | the app code has a fallback constant equal to the control value |

Limits of the guard today: G8 and G10 read the app file as text and find `const NAME = '...'` declarations, so an event name built at run time, or a fallback without "fallback" in its constant name, is not recognised (the guard then rejects the plan rather than passing it). G7 matches a fixed list of English phrases.

- **Plan and hash** ([src/plan.js](src/plan.js)): checks the plan file's shape, writes canonical JSON (keys sorted, no whitespace, UTF-8) and its `planSha256`. The expected hashes in the tests were computed separately in Python.
- **Diff** ([src/diff.js](src/diff.js)): the exact Flagsmith changes in order (create flag, create metric, create experiment, start) and their `diffSha256`. It also says that a new flag appears in every environment of the project.
- **Two approvals, each for its own diff** ([src/approve.js](src/approve.js), [src/approval.js](src/approval.js)):
  - **CREATE** makes the flag, its keyed variations, the metric and the experiment, and does not start it. `npm run approve -- <planfile> --app <app file> --phase create`
  - **START** starts the experiment. A person approves it only after the app using the flag is deployed, and only once a valid CREATE approval exists. `... --phase start`
  - Each run checks the plan with the guard, prints that phase's diff, asks for a name and a typed `yes`, and writes `approvals/<planId>.<phase>.json` with both hashes.
  - It refuses unless a person is typing at a terminal. No other file in `src/` writes approvals, and a test checks this. Approval files are committed as evidence.
  - In Windows PowerShell, the bare `--` after `npm run approve` is swallowed, so npm takes `--app` and `--phase` as its own settings and the command refuses with its usage line. Run `node src/approve.js <planfile> --app <app file> --phase create` directly, or quote the separator: `npm run approve '--' ...`.
  - The applier refuses when an approval is missing or malformed, has no approver, or is for another plan or phase, and when the plan or the diff has changed since approval.
- **Applier** ([src/applier.js](src/applier.js)): `npm run pilot -- apply <planfile> --app <file> --phase create|start` re-runs the guard and checks that phase's approval. It does a **dry run** unless `--apply` is given. With `--apply`:
  - It reads the environment through the API first and refuses if its name differs from the plan's.
  - It refuses if the flag, the experiment or a metric with the same name already exists.
  - It never modifies or deletes anything, and stops at the first error, listing what it created.
  - The admin token is read only from `FLAGSMITH_ADMIN_TOKEN`, sent only as `Authorization: Api-Key <token>`, and redacted from logs, errors and recordings. `--record <folder>` saves each call, redacted.
  - `npm run pilot -- diff <planfile> --app <file> --phase create|start` prints a phase's diff and hashes without sending anything.
- **The flag is created enabled.** A Flagsmith flag belongs to the whole project, so it also appears in Production, enabled and serving the control value. Only Development gets the experiment. The CREATE diff says this before anyone approves.
- **First real run (Thu Nov 26, 14:14 IST, Development only):** after a person approved CREATE (`approvals/pilot_rehearsal_1.create.json`), the applier confirmed the environment was named Development. It then found no existing flag, experiment or metric with these names, and created flag `pilot_rehearsal_1` (305157) with keyed variation `variant_b` (37083), metric "Get started clicks (pilot_rehearsal_1)" (577) and experiment 579, status `created`. **Not started.** Every call is saved, redacted, in [fixtures/flagsmith/recorded/2026-11-26-create/](fixtures/flagsmith/recorded/2026-11-26-create/).
- **START on Development (Thu Nov 26, 16:12 IST):** after a person approved START in their own terminal (`approvals/pilot_rehearsal_1.start.json`, diff sha256 `3144d47d…6ec3`), the applier confirmed the environment name, found exactly one experiment named `pilot_rehearsal_1` with status `created`, started it and read it back as `running` (rollout 100%, variant_b 50%). Recorded in [fixtures/flagsmith/recorded/2026-11-26-start/](fixtures/flagsmith/recorded/2026-11-26-start/).
- **First readout on Development (Thu Nov 26, 16:14 IST): `no_clear_winner`.** Source: Flagsmith results for experiment 579, refreshed and recorded in [fixtures/flagsmith/recorded/2026-11-26-start-results/](fixtures/flagsmith/recorded/2026-11-26-start-results/). **All of it is scripted `sim_` traffic** with made-up rates (400 visitors): control 34/217 (15.7%), variant_b 29/183 (15.8%), 95% interval for the lift [−45.0%, +47.2%], chance to beat control 51.9%. The stop rule (150 per variation) was met; the interval includes zero and 51.9% is below 95%, so no winner. These numbers say nothing about real users. Experiment 579's stored hypothesis still names an earlier variant_b headline; the rehearsal page shows the new copy.
- **Second readout on Development, after real browser loads (Thu Nov 26, 18:23 IST): still `no_clear_winner`.** Source: Flagsmith results for experiment 579, recorded in [fixtures/flagsmith/recorded/2026-11-26-web-results/](fixtures/flagsmith/recorded/2026-11-26-web-results/). **Mixed traffic: 400 scripted `sim_` visitors plus 4 real `web_` visitors** (the 4 are attributed by time: they arrived after the scripted run ended; Flagsmith does not list ids). control 34/217 (15.7%), variant_b 32/187 (17.1%), lift +9.2%, 95% interval [−39.1%, +57.5%], chance to beat control 64.6%. The interval includes zero and 64.6% is below 95%, so no winner. This run also found a bug: the readout judged "is the refresh done?" against this machine's clock and wrongly called fresh numbers stale; it now uses Flagsmith's own `refresh_requested_at` and `as_of` (test first, then fix).
- **Test page** ([site/](site/)): CreatorDigest, a static page with no build step. It loads the Flagsmith JS SDK 12.6.0 from a vendored copy ([site/vendor/](site/vendor/), BSD-3-Clause).
  - The flag picks the headline: control "Your creator digest, summarized by AI", or variant_b "Yesterday's 5 biggest creator posts, in 60 seconds. See today's." with an example line.
  - An unknown value, an unreachable Flagsmith, or no answer within 2 s shows the control copy (`FALLBACK_VALUE`).
  - Each browser gets one `web_` visitor id, used for `identify()`, the exposure (`getExperimentFlag` only) and the `cta_clicked` event (`CTA_EVENT`).
  - Committed `config.js` holds the Production client-side key (public by design) and the real flag, `creatordigest_headline`. The git-ignored `site/config.local.js` overrides both for local runs with the Development key and the rehearsal flag `pilot_rehearsal_1`; it is never published (the Pages workflow checks).
  - Run it locally with `npm run site` (port 5173, or `PORT=5174`).
- **Readout** ([src/readout.js](src/readout.js)): `npm run pilot -- readout <planfile> [--refresh]` prints `not_ready` (stop rule unmet; no numbers to act on), `no_clear_winner` or `winner_candidate`, each with its reasons. It labels scripted traffic, because Flagsmith's results do not separate `sim_` from `web_` visitors. A test checks a hand-calculated example: 15/150 against 22/150 gives a lift of 7/15, the same as Flagsmith's.
- **Scripted traffic** ([scripts/simulate.mjs](scripts/simulate.mjs)): `sim_` visitors at made-up rates (control 10%, variant_b 14%). It runs only against the Development key bound in `flagsmith.json`, takes the Development flag key from `config.local.js` (never the real flag), and reuses the page's event constant.
- **Real experiment plan, not created yet:** [plans/creatordigest_headline_1.json](plans/creatordigest_headline_1.json). Production, flag `creatordigest_headline` (control / variant_b, 50/50), metric "Early access clicks (creatordigest_headline)" on `cta_clicked`, higher is better, real `web_` visitors only (no scripted traffic), fixed end Sat Nov 28, 22:00 IST, winner only if the chance to win is at least 95% and the interval excludes zero. The guard refuses it (G9) unless `--allow-production` is given; `diff`, `approve` and `apply` all take that flag, and a Production diff starts with a `PRODUCTION:` warning line. Only its dry-run diff has been produced (plan sha256 `4013bb29…ab26`, CREATE diff sha256 `18549af0…4369`). No approval exists for it. Read-only checks of Production (GET only, Thu Nov 26, 18:04 IST, recorded in [fixtures/flagsmith/recorded/2026-11-26-production-readonly/](fixtures/flagsmith/recorded/2026-11-26-production-readonly/)): the environment is named Production, no flag, metric or experiment with these names exists, and its settings match Development. Its warehouse connection shows `pending_connection` with 0 events; Development showed the same status and its results still worked, but that is not yet proven for Production.
- **Real experiment created in Production (Thu Nov 26, 18:36 IST), not started.** After a person approved CREATE with `--allow-production` (`approvals/creatordigest_headline_1.create.json`, diff sha256 `18549af0…4369`), the applier ran a dry run, then confirmed the environment was named Production and that nothing with these names existed, and created flag `creatordigest_headline` (305552, enabled, control) with keyed variation `variant_b` (37266), metric "Early access clicks (creatordigest_headline)" (639) and experiment 650, status `created`. Recorded in [fixtures/flagsmith/recorded/2026-11-26-production-create/](fixtures/flagsmith/recorded/2026-11-26-production-create/). Until START, every visitor gets the control headline. START needs its own approval after the page is deployed.
- **Real experiment started in Production (Thu Nov 26, 18:50 IST).** The page was published on GitHub Pages first (https://ragulsid.github.io/experimentpilot/; its `app.js` and `config.js` checked byte-identical to the repo, `config.local.js` not published). A person then approved START with `--allow-production` (`approvals/creatordigest_headline_1.start.json`, diff sha256 `6f0fa86d…af1d`), and the applier started experiment 650: status `running`, started 2026-11-26T13:20:06Z, rollout 100%, variant_b 50%. Recorded in [fixtures/flagsmith/recorded/2026-11-26-production-start/](fixtures/flagsmith/recorded/2026-11-26-production-start/). The pre-registered stop rule ends it at Sat Nov 28, 22:00 IST; until then the readout says `not_ready`. No results are reported here yet.
- **Hosting:** [.github/workflows/pages.yml](.github/workflows/pages.yml) publishes `site/` to GitHub Pages when started by hand. Pages is on: https://ragulsid.github.io/experimentpilot/.
- **Where each Flagsmith call comes from:** every route the client uses has now been recorded working for real (call numbers in [src/flagsmith-client.js](src/flagsmith-client.js) and [fixtures/flagsmith/recorded/](fixtures/flagsmith/recorded/)). Routes added in Step 4b were first checked against Flagsmith's public OpenAPI spec (operationIds kept in the code). The applier refuses to send a route that is neither recorded nor in the spec to a real Flagsmith host.

## How this was built: AI-assisted

This project was built with the help of an AI coding agent. Plainly:

- **The AI wrote** the code, tests, workflows and this README, working in small checkpoints, and ran the commands (tests, dry runs, and the Flagsmith calls after each human approval).
- **Ragul (the human) decided** the product, the track, the rules (guard rules G1 to G10 and the non-negotiables), and each open question the AI raised (for example: create the flag enabled, two separate approvals, commit the Production client key, no Production writes until the real experiment).
- **Ragul reviewed** each checkpoint report (what changed, the exact command and its output, what was still unverified) before the next step was allowed, and approved every install, the push and each Flagsmith write.
- **Ragul approved every Flagsmith change in a terminal, by typing.** `src/approve.js` refuses unless a person is typing at a terminal; when the AI tried to pipe "yes" into it to demonstrate the refusal, the agent's permission check blocked it. The approval files in [approvals/](approvals/) carry the approver's name and the plan and diff hashes, and the applier refuses without them.
- **Plain code, not the AI, makes the safety decisions:** the guard, the approval check and the readout's decision are deterministic code with tests. The AI cannot bypass them at run time.

| What | Written by | Checked by |
|---|---|---|
| Requirements, guard rules G1 to G10, decisions | Ragul | — |
| Code, tests, workflows, README | AI | tests (failing first, then passing), CI on Ubuntu and Windows, Ragul's checkpoint reviews |
| Each Flagsmith write (CREATE, START) | applier code, run by the AI | Ragul's typed approval of the exact diff, matched by hash |
| Recorded Flagsmith responses | Flagsmith | secret scan before each commit and push |
| Numbers in this README | Flagsmith results (source stated next to each) | readout code; real or scripted traffic stated each time |

## Before the start

Work done before the hacking window opened (Thu Nov 26, 8:00 AM IST), disclosed in full. All of it happened on **Wed Nov 25, 2026**, and none of it is code in this repo unless listed under "Copied into this repo".

**Rehearsal on Flagsmith Cloud, Development environment only:**
- Ran Flagsmith's official coding-agent setup prompt (docs.flagsmith.com, "Set up an experiment with a coding agent") once, end to end.
- Created the multivariate flag `rehearsal_headline` (control `control`, variation key `variant_b`), the metric "Get started clicks" (event `cta_clicked`) and experiment 457, then started it. It is still running in Development and is not part of this project's real experiment.
- Built a throwaway demo page and a traffic script outside this repo. The script sent 300 **scripted** users (ids starting `sim_`, made-up conversion rates) to check that exposures and conversions arrive. Those numbers are synthetic and are not reported as results anywhere.
- Recorded the exact Flagsmith CLI and Admin API calls used (27 calls), to serve as the source of truth for the applier. Kept outside the repo because it refers to the private environment.
- Read the `@flagsmith/flagsmith` 12.6.0 source to confirm two behaviours: `getExperimentFlag` records an exposure only for an identified, enrolled visitor with flags fetched from the server, and `trackEvent` accepts an optional `identifier`.
- Installed the Flagsmith CLI v2.0.0.

**Planning documents** (kept outside the repo): a schedule, a pass/fail checklist for the submission, and the build prompt with the guard rules G1 to G10.

**Copied into this repo:**
- `scripts/crosscheck.sh`: written on Nov 25 as part of the pass/fail checklist and copied unchanged. Its usage comment still shows a Python example from the template it was written against.

- `fixtures/flagsmith/recorded/`: real Flagsmith request and response bodies recorded during the Nov 25 rehearsal (environment key redacted), saved as test fixtures on Nov 26 without changing any values. The results body comes from scripted traffic.

**Modelled on the rehearsal, written new on Nov 26:**
- `scripts/serve-site.mjs` and `scripts/simulate.mjs` follow the shape of the rehearsal's local server and traffic script (same SDK calls, `sim_` ids, made-up rates); `site/` follows the rehearsal page's structure (fallback headline, `web_` id, one event constant) with new copy.
- `fixtures/app/experiment.mjs` follows the shape of the rehearsal's constants file (one event constant, one fallback constant), with a new flag key `pilot_rehearsal_1`. The event name `cta_clicked` and the two headlines in `fixtures/plans/valid-plan.json` are the ones used in the rehearsal.

## License

MIT, see [LICENSE](LICENSE).
