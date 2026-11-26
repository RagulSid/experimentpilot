#!/usr/bin/env node
// ExperimentPilot command line. Commands are added as each build step lands.
// Anything not built yet exits with code 1 and says so; nothing pretends to succeed.
//
//   npm run pilot -- diff  <planfile> --app <app file> --phase create|start|stop [--rollout <choice>]
//     Runs the guard and prints that phase's exact Flagsmith diff and hashes. Sends nothing.
//   npm run pilot -- apply <planfile> --app <app file> --phase create|start
//                          [--apply] [--config flagsmith.json] [--allow-production] [--record <folder>]
//     Dry run unless --apply is given. Approvals are read from approvals/<planId>.<phase>.json
//     (written only by `npm run approve`). The admin token comes only from FLAGSMITH_ADMIN_TOKEN.
//     --record saves every call's request and response, redacted, as numbered JSON files.
//   npm run pilot -- plan "<one sentence>" --app <app file> [--record <folder>] [--timeout-ms <ms>]
//     Asks an AI coding agent (no tools, no credentials) for a plan, parses it strictly and runs
//     the guard. Writes only plans/proposed/<id>.json, and only if the guard passes. Applies nothing.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyPlan } from './applier.js';
import { readApprovalText } from './approval.js';
import { createClient } from './flagsmith-client.js';
import { createRecorder } from './recorder.js';
import { validatePlan, planSha256 } from './plan.js';
import { checkPlan } from './guard.js';
import { PHASES, buildDiff, diffSha256, formatDiff } from './diff.js';
import { fetchAndRead, formatReadout } from './readout.js';
import { proposePlan, recordPlannerRun, childEnv, AGENT, DEFAULT_TIMEOUT_MS } from './planner.js';

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
  const usage = 'usage: npm run pilot -- diff <planfile> --app <app file> --phase create|start|stop [--allow-production] [--rollout control|disable|variant:<key>] (--rollout is required for stop)';
  let parsed;
  try {
    parsed = parseArgs(args, { flags: ['--allow-production'], options: ['--app', '--phase', '--rollout'] });
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
  const guard = checkPlan(inputs.plan, { appSource: inputs.appSource, allowProduction: parsed.flags['--allow-production'] === true });
  if (!guard.ok) {
    for (const v of guard.violations) console.error(`REFUSED (guard): ${v.rule} ${v.reason}`);
    return 1;
  }
  let changes;
  try {
    changes = buildDiff(inputs.plan, phase, { rollout: parsed.options['--rollout'] });
  } catch (err) {
    console.error(`REFUSED: ${err.message} (pass --rollout for stop)`);
    return 1;
  }
  console.log(formatDiff(changes, { planSha256: planSha256(inputs.plan), diffSha256: diffSha256(changes) }));
  return 0;
}

async function apply(args) {
  const usage = 'usage: npm run pilot -- apply <planfile> --app <app file> --phase create|start [--apply] [--config flagsmith.json] [--allow-production] [--record <folder>]';
  let parsed;
  try {
    parsed = parseArgs(args, { flags: ['--apply', '--allow-production'], options: ['--app', '--config', '--phase', '--record', '--rollout'] });
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
    startApprovalText: phase === 'stop' ? approvalOf('start') : undefined,
    rollout: parsed.options['--rollout'],
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

const readPlans = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))) : []);

async function planCommand(args) {
  const usage = 'usage: npm run pilot -- plan "<one sentence>" --app <app file> [--record <folder>] [--timeout-ms <ms>]';
  let parsed;
  try {
    parsed = parseArgs(args, { options: ['--app', '--record', '--timeout-ms'] });
  } catch (err) {
    console.error(`${err.message}
${usage}`);
    return 1;
  }
  const sentence = parsed.positional.join(' ').trim();
  const app = parsed.options['--app'];
  if (!sentence || !app) {
    console.error(usage);
    return 1;
  }
  const appSource = readFileSync(app, 'utf8');
  const examplePlans = readPlans('plans');
  const proposed = readPlans(join('plans', 'proposed'));
  const all = [...examplePlans, ...proposed];
  // Flags of experiments that were started (a committed START approval exists): G9 refuses reusing them.
  const startedExperimentFlagKeys = all.filter((p) => existsSync(join('approvals', `${p.id}.start.json`))).map((p) => p.flag.key);
  const timeoutMs = parsed.options['--timeout-ms'] ? Number(parsed.options['--timeout-ms']) : DEFAULT_TIMEOUT_MS;

  console.log(`Asking the AI agent (${AGENT.command}, no tools, no credentials) for a plan: "${sentence}"`);
  const result = await proposePlan({
    sentence, appSource, examplePlans,
    existingPlanIds: all.map((p) => p.id),
    existingFlagKeys: all.map((p) => p.flag?.key).filter(Boolean),
    startedExperimentFlagKeys, timeoutMs,
  });
  if (parsed.options['--record']) {
    recordPlannerRun(parsed.options['--record'], { sentence, app, command: AGENT.command, args: AGENT.args, envKeys: Object.keys(childEnv()), startedExperimentFlagKeys, result });
    console.log(`Recorded the raw agent output and the verdict in ${parsed.options['--record']}`);
  }
  console.log(`Agent answered in ${(result.raw.ms / 1000).toFixed(1)} s (exit code ${result.raw.code}${result.raw.timedOut ? ', timed out' : ''}).`);
  if (result.status === 'proposed') {
    console.log(`PROPOSED: ${result.path} (guard: all of G1-G10 pass). Nothing was applied.`);
    console.log(`Next: npm run pilot -- diff ${result.path} --app ${app} --phase create, then a person approves it.`);
    return 0;
  }
  console.error(`REFUSED at the ${result.stage} step:`);
  for (const r of result.reasons) console.error(`  - ${r}`);
  return 1;
}

const COMMANDS = { diff, apply, readout: readoutCommand, plan: planCommand };

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
