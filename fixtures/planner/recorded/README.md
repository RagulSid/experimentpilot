# Recorded planner runs (real AI output)

Each folder is one real run of `npm run pilot -- plan "<sentence>" --app site/app.js --record <folder>`.

- `request.json`: the sentence, the agent command and flags, the NAMES of the environment variables the agent got (no values, and no Flagsmith or other credentials), and timing.
- `prompt.txt`: exactly what the agent was sent on stdin.
- `stdout.txt`: the agent CLI's output as printed. One field is blanked: `credential_expires_at` (when the sign-in expires; about the account, not the answer). The reply text is unchanged.
- `stderr.txt`: the agent's error output.
- `verdict.json`: what plain code decided (parse, shape check, guard G1 to G10).

`2026-11-26-dev-headline` (Thu Nov 26, 20:49 IST): proposed `plans/proposed/creatordigest_headline_dev_1.json` for Development; the guard passed it. Nothing was created in Flagsmith.

The bad plans in `../scripted/` are **scripted**: written by hand to show the guard refusing them. They are not AI output.
