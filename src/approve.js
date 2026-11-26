#!/usr/bin/env node
// The human approval command, and the ONLY code that writes approval files.
//   npm run approve -- <planfile>
// Prints the exact Flagsmith diff, asks for the person's name and a typed "yes", then writes
// approvals/<planId>.json { planId, approver, approvedAt, planSha256, diffSha256 }.
// It refuses when stdin is not an interactive terminal, so a script or an agent cannot
// approve by piping text in.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { validatePlan, planSha256 } from './plan.js';
import { buildDiff, diffSha256, formatDiff } from './diff.js';
import { APPROVALS_DIR, approvalPath, createApprovalRecord } from './approval.js';

export async function runApprove({
  planPath,
  approvalsDir = APPROVALS_DIR,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  now = () => new Date(),
}) {
  const say = (line) => output.write(`${line}\n`);
  const refuse = (line) => { errorOutput.write(`Refused: ${line}\n`); return 1; };

  if (!planPath) return refuse('usage: npm run approve -- <planfile>');
  if (!input.isTTY) return refuse('approval must be typed by a person at an interactive terminal (stdin is not a terminal).');

  let plan;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (err) {
    return refuse(`cannot read plan file ${planPath}: ${err.message}`);
  }
  const shape = validatePlan(plan);
  if (!shape.ok) return refuse(`plan file is invalid:\n  - ${shape.errors.join('\n  - ')}`);

  const diff = buildDiff(plan);
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
    const answer = (await ask('Type yes to approve exactly these changes: '))?.trim();
    if (answer !== 'yes') return refuse(`answer was ${JSON.stringify(answer ?? '')}, not "yes"; nothing was approved.`);

    const record = createApprovalRecord({ plan, approver: name, now: now() });
    const path = approvalPath(plan.id, approvalsDir);
    const replacing = existsSync(path);
    mkdirSync(approvalsDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    say(`${replacing ? 'Replaced' : 'Wrote'} ${path}: approved by ${record.approver} at ${record.approvedAt}.`);
    return 0;
  } finally {
    rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runApprove({ planPath: process.argv[2] });
}
