# ExperimentPilot

You describe an experiment in one sentence. An agent drafts the Flagsmith experiment, plain code rejects anything unsafe, a person approves the exact change, and plain code reads the result honestly.

Entry for **Toggle Wars** (WeMakeDevs x Flagsmith), **Track 02: AI Agents and Feature Flags**.

## Status

Built step by step during the hacking window (Thu Nov 26 to Sun Nov 29, 2026). This README only describes what exists in the repo at each commit.

- Repo skeleton, MIT licence and CI on Ubuntu and Windows (`npm test`).

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

## License

MIT, see [LICENSE](LICENSE).
