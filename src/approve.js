#!/usr/bin/env node
// The human approval command, and the ONLY code that writes approval files.
//   npm run approve -- <planfile> --app <app file> --phase create|start [--allow-production]
// Checks the plan (shape and guard G1-G10, reading the app file), prints that phase's exact
// Flagsmith diff, asks for the person's name and a typed "yes", then writes
// approvals/<planId>.<phase>.json { planId, phase, approver, approvedAt, planSha256, diffSha256 }.
// START can only be approved after a valid CREATE approval, and its question says the app
// must already be deployed. It refuses when stdin is not an interactive terminal, so a script
// or an agent cannot approve by piping text in.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { validatePlan, planSha256 } from './plan.js';
import { checkPlan } from './guard.js';
import { PHASES, buildDiff, diffSha256, formatDiff } from './diff.js';
import { APPROVALS_DIR, approvalPath, createApprovalRecord, readApprovalText, verifyApproval } from './approval.js';

const QUESTION = {
  create: 'Type yes to approve exactly these changes (nothing is started): ',
  start: 'The app using this flag and event is deployed. Type yes to approve starting the experiment: ',
};

export async function runApprove({
  planPath,
  appPath,
  phase,
  allowProduction = false,
  approvalsDir = APPROVALS_DIR,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  now = () => new Date(),
}) {
  const say = (line) => output.write(`${line}\n`);
  const refuse = (line) => { errorOutput.write(`Refused: ${line}\n`); return 1; };

  if (!planPath || !appPath || !PHASES.includes(phase)) {
    return refuse('usage: npm run approve -- <planfile> --app <app file> --phase create|start [--allow-production]');
  }
  if (!input.isTTY) return refuse('approval must be typed by a person at an interactive terminal (stdin is not a terminal).');

  let plan;
  let appSource;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (err) {
    return refuse(`cannot read plan file ${planPath}: ${err.message}`);
  }
  try {
    appSource = readFileSync(appPath, 'utf8');
  } catch (err) {
    return refuse(`cannot read app file ${appPath}: ${err.message}`);
  }
  const shape = validatePlan(plan);
  if (!shape.ok) return refuse(`plan file is invalid:\n  - ${shape.errors.join('\n  - ')}`);
  const guard = checkPlan(plan, { appSource, allowProduction: allowProduction === true });
  if (!guard.ok) return refuse(`the guard rejects this plan:\n  - ${guard.violations.map((v) => `${v.rule} ${v.reason}`).join('\n  - ')}`);

  if (phase === 'start') {
    const create = verifyApproval(plan, readApprovalText(plan.id, 'create', approvalsDir), 'create');
    if (!create.ok) return refuse(`START needs a valid create approval first: ${create.reason}`);
  }

  const diff = buildDiff(plan, phase);
  say(formatDiff(diff, { planSha256: planSha256(plan), diffSha256: diffSha256(diff) }));
  say('');

  const rl = createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    output.write(prompt);
    const { value, done } = await lines.next();
    return done ? null : value;
  };

  try {
    const name = (await ask('Your name: '))?.trim() ?? '';
    if (!name) return refuse('no name given; nothing was approved.');
    const answer = (await ask(QUESTION[phase]))?.trim();
    if (answer !== 'yes') return refuse(`answer was ${JSON.stringify(answer ?? '')}, not "yes"; nothing was approved.`);

    const record = createApprovalRecord({ plan, phase, approver: name, now: now() });
    const path = approvalPath(plan.id, phase, approvalsDir);
    const replacing = existsSync(path);
    mkdirSync(approvalsDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    say(`${replacing ? 'Replaced' : 'Wrote'} ${path}: ${phase} approved by ${record.approver} at ${record.approvedAt}.`);
    return 0;
  } finally {
    rl.close();
  }
}

export function parseArgv(argv) {
  const out = { planPath: undefined, appPath: undefined, phase: undefined, allowProduction: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--allow-production') out.allowProduction = true;
    else if (argv[i] === '--app') out.appPath = argv[++i];
    else if (argv[i] === '--phase') out.phase = argv[++i];
    else if (!out.planPath) out.planPath = argv[i];
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runApprove(parseArgv(process.argv.slice(2)));
}
