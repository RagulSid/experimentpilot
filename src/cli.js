#!/usr/bin/env node
// ExperimentPilot command line. Commands are added as each build step lands.
// Anything not built yet exits with code 1 and says so; nothing pretends to succeed.

const COMMANDS = {};

const [command, ...args] = process.argv.slice(2);

if (!command || command === 'help' || command === '--help') {
  const names = Object.keys(COMMANDS);
  console.log('Usage: npm run pilot -- <command> [args]');
  console.log(names.length ? `Commands: ${names.join(', ')}` : 'No commands are implemented yet.');
  process.exit(command ? 0 : 1);
}

const run = COMMANDS[command];
if (!run) {
  console.error(`"${command}" is not implemented yet.`);
  process.exit(1);
}
process.exitCode = await run(args);
