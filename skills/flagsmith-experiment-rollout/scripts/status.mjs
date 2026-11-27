#!/usr/bin/env node
// Compact, read-only status for one experiment plan, plus the next step of the skill's workflow.
//   node skills/flagsmith-experiment-rollout/scripts/status.mjs <plan.json> [--config ../flagsmith.json] [--app <app file>]
// Run from the ExperimentPilot repo root (approvals/ is read from the current directory).
// Flagsmith calls (native CLI binary, never the npm wrapper, which hides exit codes):
//   flagsmith api api/v1/environments/<key>/ --jq '{name}'   (a bare string result is printed raw, not as JSON)
//   flagsmith feature list --jq '[.[] | select(.name==<flag>) | {id, type}]'
//   flagsmith api api/v1/environments/<key>/experiments/?q=<id> --jq '[.results[] | select(.name==<id>) | {id, status, rollout_decision}]'
// The environment key is read from the binding file, passed only as an argument to the CLI, and
// redacted from everything printed. Prints at most 4 lines.
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'usage: node skills/flagsmith-experiment-rollout/scripts/status.mjs <plan.json> [--config ../flagsmith.json] [--app <app file>]';
const fail = (msg) => { console.error(msg); process.exit(1); };

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const planPath = args[0];
if (!planPath || planPath.startsWith('--')) { console.error(USAGE); process.exit(2); }
const configPath = opt('--config', '../flagsmith.json');
const app = opt('--app', '<app file>');

const transportFile = [new URL('../../../src/flagsmith-cli-transport.js', import.meta.url), pathToFileURL(resolve('src/flagsmith-cli-transport.js'))]
  .find((u) => existsSync(u));
if (!transportFile) fail('run this from the ExperimentPilot repo root (src/flagsmith-cli-transport.js not found)');
const { resolveFlagsmithBin } = await import(transportFile.href);

let plan;
let binding;
try { plan = JSON.parse(readFileSync(planPath, 'utf8')); } catch (err) { fail(`cannot read plan: ${err.message}`); }
try { binding = JSON.parse(readFileSync(configPath, 'utf8')); } catch (err) { fail(`cannot read binding ${configPath}: ${err.message}`); }
const key = String(binding.environment ?? '');
const redact = (s) => (key ? String(s).split(key).join('<env key>') : String(s));
const id = String(plan.id ?? '');
const flagKey = String(plan.flag?.key ?? '');
if (!/^[\w.-]+$/.test(id) || !/^[\w.-]+$/.test(flagKey) || !/^\w+$/.test(key)) fail('plan id, flag key and environment key must be plain words');

const bin = resolveFlagsmithBin();
if (!bin) fail('Flagsmith CLI binary not found: run npm ci, or set FLAGSMITH_BIN to the native flagsmith binary');

function flagsmith(cliArgs) {
  return new Promise((done) => {
    const child = spawn(bin, [...cliArgs, '-c', configPath, '--no-input'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => done({ ok: false, err: e.message }));
    child.on('close', (code) => done({ ok: code === 0, out: out.trim(), err: redact(err.trim().split(/\r?\n/).find((l) => l.startsWith('Error:')) ?? err.trim()) }));
  });
}
const json = (r, what) => {
  if (!r.ok) fail(`flagsmith ${what} failed: ${r.err}`);
  return JSON.parse(r.out);
};

const q = JSON.stringify; // a JSON string is a valid jq string literal
const [envName, flags, experiments] = await Promise.all([
  flagsmith(['api', `api/v1/environments/${key}/`, '--jq', '{name}']).then((r) => json(r, 'environment check').name),
  flagsmith(['feature', 'list', '--jq', `[.[] | select(.name==${q(flagKey)}) | {id, type}]`]).then((r) => json(r, 'feature list')),
  flagsmith(['api', `api/v1/environments/${key}/experiments/?q=${encodeURIComponent(id)}`, '--jq', `[.results[] | select(.name==${q(id)}) | {id, status, rollout_decision}]`]).then((r) => json(r, 'experiment list')),
]);

const approved = Object.fromEntries(['create', 'start', 'stop'].map((p) => [p, existsSync(resolve('approvals', `${id}.${p}.json`))]));
const flag = flags[0];
const exp = experiments[0];
const cmd = (s) => `\`${s}\``;
const human = (phase, extra = '') => `ask the human to run ${cmd(`node src/approve.js ${planPath} --app ${app} --phase ${phase}${extra}`)} in their own terminal`;
const apply = (phase, extra = '') => cmd(`node src/cli.js apply ${planPath} --app ${app} --phase ${phase}${extra} --apply --via-cli --config ${configPath}`);

let next;
if (envName !== plan.environment) next = `STOP: the binding points at ${envName} but the plan says ${plan.environment}. Fix the binding; Production needs an explicit human instruction.`;
else if (experiments.length > 1) next = `STOP: ${experiments.length} experiments are named ${id}; show this to the human.`;
else if (!exp && flag && !approved.create) next = `STOP: flag ${flagKey} already exists; never edit an existing flag. Pick a new flag key and re-plan.`;
else if (!exp && flag) next = `STOP: CREATE looks incomplete (flag exists, no experiment). Show this to the human; do not retry.`;
else if (!exp && !approved.create) next = `STOP for approval: show ${cmd(`node src/cli.js diff ${planPath} --app ${app} --phase create`)}, then ${human('create')}.`;
else if (!exp) next = `create: ${apply('create')}`;
else if (exp.status === 'created' && !approved.start) next = `STOP: ask the human whether the app reading ${flagKey} is deployed; only then show the START diff and ${human('start')}.`;
else if (exp.status === 'created') next = `start: ${apply('start')}`;
else if (['running', 'paused'].includes(exp.status) && !approved.stop) next = `readout: ${cmd(`node src/cli.js readout ${planPath} --refresh --via-cli --config ${configPath}`)}. Complete only after it is not not_ready.`;
else if (['running', 'paused'].includes(exp.status)) next = `stop: ${apply('stop', ' --rollout <the choice the human approved>')} (the pilot re-checks the stop rule)`;
else if (exp.status === 'completed') next = `done: verify with ${cmd(`flagsmith flag get ${flagKey} -c ${configPath} --jq '{enabled, value}'`)}`;
else next = `STOP: experiment status ${exp.status} is unexpected; show this to the human.`;

const yn = (b) => (b ? 'yes' : 'no');
console.log(redact([
  `plan ${id} | flag ${flagKey} | plan env ${plan.environment} | binding env ${envName}`,
  `flagsmith: ${flag ? `flag present (id ${flag.id}, ${flag.type})` : 'flag absent'} | ${exp ? `experiment ${exp.id} ${exp.status}${exp.rollout_decision ? ` (rollout ${exp.rollout_decision})` : ''}` : 'experiment none'}`,
  `approvals: create ${yn(approved.create)}, start ${yn(approved.start)}, stop ${yn(approved.stop)} (files present; the pilot checks their hashes)`,
  `next: ${next}`,
].join('\n')));
