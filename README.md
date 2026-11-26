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
- **Approval gate** ([src/approve.js](src/approve.js), [src/approval.js](src/approval.js)): `npm run approve -- <planfile>` prints the diff, asks for a name and a typed `yes`, and writes `approvals/<planId>.json` with both hashes. It refuses unless a person is typing at a terminal. No other file in `src/` writes approvals, and a test checks this. The applier refuses when the approval is missing or malformed, has no approver, or belongs to another plan, and when the plan or the diff has changed since approval.
- **Applier** ([src/applier.js](src/applier.js)): `npm run pilot -- apply <planfile> --app <file>` re-runs the guard, checks the approval, and does a **dry run** unless `--apply` is given. With `--apply` it refuses if the flag or experiment already exists, never modifies or deletes anything, and stops at the first error, listing what it created. The admin token is read only from `FLAGSMITH_ADMIN_TOKEN`, sent only as `Authorization: Api-Key <token>`, and redacted from logs and errors.
- **Tested only against a local fake Flagsmith so far**, built from real responses recorded on Nov 25 ([fixtures/flagsmith/recorded/](fixtures/flagsmith/recorded/)). Three routes have not yet been seen working against the real API: create flag, list flags, list experiments. The applier refuses to send them to a real Flagsmith host until they are recorded.

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
- `fixtures/app/experiment.mjs` follows the shape of the rehearsal's constants file (one event constant, one fallback constant), with a new flag key `pilot_rehearsal_1`. The event name `cta_clicked` and the two headlines in `fixtures/plans/valid-plan.json` are the ones used in the rehearsal.

## License

MIT, see [LICENSE](LICENSE).
