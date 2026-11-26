#!/usr/bin/env node
// ExperimentPilot command line. Commands are added as each build step lands.
// Anything not built yet exits with code 1 and says so; nothing pretends to succeed.
//
//   npm run pilot -- apply <planfile> --app <app file> [--apply] [--config flagsmith.json] [--allow-production]
//     Dry run unless --apply is given. Approvals are read from approvals/<planId>.json
//     (written only by `npm run approve -- <planfile>`). The admin token comes only from
//     the FLAGSMITH_ADMIN_TOKEN environment variable.
import { readFileSync } from 'node:fs';
import { applyPlan } from './applier.js';
import { readApprovalText } from './approval.js';
import { createClient } from './flagsmith-client.js';

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

async function apply(args) {
  const usage = 'usage: npm run pilot -- apply <planfile> --app <app file> [--apply] [--config flagsmith.json] [--allow-production]';
  let parsed;
  try {
    parsed = parseArgs(args, { flags: ['--apply', '--allow-production'], options: ['--app', '--config'] });
  } catch (err) {
    console.error(`${err.message}\n${usage}`);
    return 1;
  }
  const [planPath] = parsed.positional;
  const appPath = parsed.options['--app'];
  if (!planPath || !appPath) {
    console.error(usage);
    return 1;
  }

  let plan;
  let appSource;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
    appSource = readFileSync(appPath, 'utf8');
  } catch (err) {
    console.error(`cannot read input: ${err.message}`);
    return 1;
  }

  let approvalText = null;
  try {
    approvalText = typeof plan?.id === 'string' ? readApprovalText(plan.id) : null;
  } catch {
    approvalText = null;
  }

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
    client = createClient({ projectId: config.project, environmentKey: config.environment, log });
  }

  const result = await applyPlan({
    plan,
    approvalText,
    appSource,
    apply: parsed.flags['--apply'] === true,
    client,
    allowProduction: parsed.flags['--allow-production'] === true,
    log,
  });
  return result.status === 'dry_run' || result.status === 'applied' ? 0 : 1;
}

const COMMANDS = { apply };

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
