#!/usr/bin/env node
// ExperimentPilot command line. Commands are added as each build step lands.
// Anything not built yet exits with code 1 and says so; nothing pretends to succeed.
//
//   npm run pilot -- diff  <planfile> --app <app file> --phase create|start
//     Runs the guard and prints that phase's exact Flagsmith diff and hashes. Sends nothing.
//   npm run pilot -- apply <planfile> --app <app file> --phase create|start
//                          [--apply] [--config flagsmith.json] [--allow-production] [--record <folder>]
//     Dry run unless --apply is given. Approvals are read from approvals/<planId>.<phase>.json
//     (written only by `npm run approve`). The admin token comes only from FLAGSMITH_ADMIN_TOKEN.
//     --record saves every call's request and response, redacted, as numbered JSON files.
import { readFileSync } from 'node:fs';
import { applyPlan } from './applier.js';
import { readApprovalText } from './approval.js';
import { createClient } from './flagsmith-client.js';
import { createRecorder } from './recorder.js';
import { validatePlan, planSha256 } from './plan.js';
import { checkPlan } from './guard.js';
import { PHASES, buildDiff, diffSha256, formatDiff } from './diff.js';
import { fetchAndRead, formatReadout } from './readout.js';

function parseArgs(args, { flags = [], options = [] }) {
  const out = { positional: [], flags: {}, options: {} };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (flags.includes(a)) out.flags[a] = true;
    else if (options.includes(a)) {
      if (i + 1 >= args.length) throw new Error(`${a} needs a value`);
      out.options[a] = args[++i];
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else out.positional.push(a);
  }
  return out;
}

function readInputs(planPath, appPath) {
  return {
    plan: JSON.parse(readFileSync(planPath, 'utf8')),
    appSource: readFileSync(appPath, 'utf8'),
  };
}

async function diff(args) {
  const usage = 'usage: npm run pilot -- diff <planfile> --app <app file> --phase create|start';
  let parsed;
  try {
    parsed = parseArgs(args, { options: ['--app', '--phase'] });
  } catch (err) {
    console.error(`${err.message}\n${usage}`);
    return 1;
  }
  const [planPath] = parsed.positional;
  const phase = parsed.options['--phase'];
  if (!planPath || !parsed.options['--app'] || !PHASES.includes(phase)) {
    console.error(usage);
    return 1;
  }
  let inputs;
  try {
    inputs = readInputs(planPath, parsed.options['--app']);
  } catch (err) {
    console.error(`cannot read input: ${err.message}`);
    return 1;
  }
  const shape = validatePlan(inputs.plan);
  if (!shape.ok) {
    for (const e of shape.errors) console.error(`REFUSED (plan): ${e}`);
    return 1;
  }
  const guard = checkPlan(inputs.plan, { appSource: inputs.appSource });
  if (!guard.ok) {
    for (const v of guard.violations) console.error(`REFUSED (guard): ${v.rule} ${v.reason}`);
    return 1;
  }
  const changes = buildDiff(inputs.plan, phase);
  console.log(formatDiff(changes, { planSha256: planSha256(inputs.plan), diffSha256: diffSha256(changes) }));
  return 0;
}

async function apply(args) {
  const usage = 'usage: npm run pilot -- apply <planfile> --app <app file> --phase create|start [--apply] [--config flagsmith.json] [--allow-production] [--record <folder>]';
  let parsed;
  try {
    parsed = parseArgs(args, { flags: ['--apply', '--allow-production'], options: ['--app', '--config', '--phase', '--record'] });
  } catch (err) {
    console.error(`${err.message}\n${usage}`);
    return 1;
  }
  const [planPath] = parsed.positional;
  const phase = parsed.options['--phase'];
  if (!planPath || !parsed.options['--app'] || !PHASES.includes(phase)) {
    console.error(usage);
    return 1;
  }
  let inputs;
  try {
    inputs = readInputs(planPath, parsed.options['--app']);
  } catch (err) {
    console.error(`cannot read input: ${err.message}`);
    return 1;
  }

  const approvalOf = (p) => {
    try {
      return typeof inputs.plan?.id === 'string' ? readApprovalText(inputs.plan.id, p) : null;
    } catch {
      return null;
    }
  };

  const log = (line) => console.log(line);
  let client;
  if (parsed.flags['--apply']) {
    const configPath = parsed.options['--config'] ?? 'flagsmith.json';
    let config;
    try {
      config = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (err) {
      console.error(`cannot read ${configPath} (project and environment): ${err.message}`);
      return 1;
    }
    const record = parsed.options['--record'] ? createRecorder(parsed.options['--record']) : null;
    client = createClient({ projectId: config.project, environmentKey: config.environment, log, record });
  }

  const result = await applyPlan({
    plan: inputs.plan,
    phase,
    approvalText: approvalOf(phase),
    createApprovalText: phase === 'start' ? approvalOf('create') : undefined,
    appSource: inputs.appSource,
    apply: parsed.flags['--apply'] === true,
    client,
    allowProduction: parsed.flags['--allow-production'] === true,
    log,
  });
  return result.status === 'dry_run' || result.status === 'applied' ? 0 : 1;
}

// npm run pilot -- readout <planfile> [--refresh] [--config flagsmith.json] [--record <folder>]
//   Reads the plan's experiment results from Flagsmith and prints not_ready / no_clear_winner /
//   winner_candidate with the reasons. --refresh asks Flagsmith to recompute first (at most once
//   every 5 minutes). Reads only; changes nothing in the experiment.
async function readoutCommand(args) {
  const usage = 'usage: npm run pilot -- readout <planfile> [--refresh] [--config flagsmith.json] [--record <folder>]';
  let parsed;
  try {
    parsed = parseArgs(args, { flags: ['--refresh'], options: ['--config', '--record'] });
  } catch (err) {
    console.error(`${err.message}\n${usage}`);
    return 1;
  }
  const [planPath] = parsed.positional;
  if (!planPath) {
    console.error(usage);
    return 1;
  }
  let plan;
  let config;
  const configPath = parsed.options['--config'] ?? 'flagsmith.json';
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    console.error(`cannot read input: ${err.message}`);
    return 1;
  }
  const shape = validatePlan(plan);
  if (!shape.ok) {
    for (const e of shape.errors) console.error(`REFUSED (plan): ${e}`);
    return 1;
  }
  const log = (line) => console.log(line);
  const record = parsed.options['--record'] ? createRecorder(parsed.options['--record']) : null;
  const client = createClient({ projectId: config.project, environmentKey: config.environment, log, record });
  try {
    const environment = await client.getEnvironment();
    if (environment?.name !== plan.environment) {
      console.error(`REFUSED (environment): configured environment is ${JSON.stringify(environment?.name)}, plan says ${JSON.stringify(plan.environment)}`);
      return 1;
    }
    const r = await fetchAndRead({ plan, client, refresh: parsed.flags['--refresh'] === true, log });
    console.log('');
    console.log(`Experiment ${r.experimentId} (${plan.id}), status ${r.experimentStatus}, metric ${r.metricId}${r.refreshed ? `, refreshed${r.stale ? ' (Flagsmith had not finished recomputing; numbers may be older)' : ''}` : ''}`);
    console.log(formatReadout(r.readout));
    return 0;
  } catch (err) {
    console.error(`FAILED: ${client.redact(err.message)}`);
    return 1;
  }
}

const COMMANDS = { diff, apply, readout: readoutCommand };

const [command, ...args] = process.argv.slice(2);

if (!command || command === 'help' || command === '--help') {
  console.log('Usage: npm run pilot -- <command> [args]');
  console.log(`Commands: ${Object.keys(COMMANDS).join(', ')}`);
  process.exit(command ? 0 : 1);
}

const run = COMMANDS[command];
if (!run) {
  console.error(`"${command}" is not implemented yet.`);
  process.exit(1);
}
process.exitCode = await run(args);
