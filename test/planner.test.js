// Planner: the AI part. An AI coding agent proposes a plan as JSON; plain code parses it strictly,
// checks its shape and runs the guard. Nothing is applied. The agent never sees Flagsmith
// credentials: it runs with a minimal environment, no tools and a working folder outside the repo.
// Written before src/planner.js existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPlan } from '../src/guard.js';

const path = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const REPO = resolve(path('.'));
const VALID = JSON.parse(readFileSync(path('fixtures/plans/valid-plan.json'), 'utf8'));
const APP = readFileSync(path('fixtures/app/experiment.mjs'), 'utf8');
const load = () => import('../src/planner.js');

const newPlan = () => ({ ...structuredClone(VALID), id: 'proposed_cta_1', flag: { ...structuredClone(VALID.flag), key: 'proposed_cta_1' } });
// What `claude -p --output-format json` prints: one result envelope whose `result` is the reply text.
const envelope = (text, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, ...extra });
const agentReturning = (stdout, more = {}) => async () => ({ stdout, stderr: '', code: 0, timedOut: false, ms: 5, ...more });
const outDir = () => mkdtempSync(join(tmpdir(), 'ep-proposed-'));
const base = (over = {}) => ({ sentence: 'Test a new headline in Development.', appSource: APP, examplePlans: [VALID], outDir: outDir(), ...over });

test('parse: one JSON object inside the result envelope is accepted', async () => {
  const { parseAgentOutput } = await load();
  const r = parseAgentOutput(envelope(JSON.stringify(newPlan())));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.plan, newPlan());
});

test('parse: bad JSON is refused', async () => {
  const { parseAgentOutput } = await load();
  assert.equal(parseAgentOutput('not json at all').ok, false);
  const r = parseAgentOutput(envelope('{"id": "x", "flag": '));
  assert.equal(r.ok, false);
  assert.match(r.reason, /JSON/);
});

test('parse: prose or code fences around the JSON are refused (JSON only)', async () => {
  const { parseAgentOutput } = await load();
  const json = JSON.stringify(newPlan());
  for (const text of [`Here is the plan:\n${json}`, `${json}\nLet me know if you want changes.`, `\`\`\`json\n${json}\n\`\`\``]) {
    const r = parseAgentOutput(envelope(text));
    assert.equal(r.ok, false, text.slice(0, 30));
    assert.match(r.reason, /only/i);
  }
});

test('parse: an envelope that reports an error is refused', async () => {
  const { parseAgentOutput } = await load();
  const r = parseAgentOutput(envelope('', { is_error: true, subtype: 'error_during_execution' }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /error/i);
});

test('proposePlan: a good plan passes shape and guard and is written to plans/proposed/ only', async () => {
  const { proposePlan } = await load();
  const opts = base({ runAgent: agentReturning(envelope(JSON.stringify(newPlan()))) });
  const r = await proposePlan(opts);
  assert.equal(r.status, 'proposed', JSON.stringify(r.reasons));
  assert.deepEqual(readdirSync(opts.outDir), ['proposed_cta_1.json']);
  assert.deepEqual(JSON.parse(readFileSync(r.path, 'utf8')), newPlan());
  assert.deepEqual(r.verdict.guard, { ok: true, violations: [] });
});

test('proposePlan: missing fields are refused at the shape check; nothing is written', async () => {
  const { proposePlan } = await load();
  const plan = newPlan();
  delete plan.stopRule;
  delete plan.metric.event;
  const opts = base({ runAgent: agentReturning(envelope(JSON.stringify(plan))) });
  const r = await proposePlan(opts);
  assert.equal(r.status, 'refused');
  assert.equal(r.stage, 'shape');
  assert.ok(r.reasons.some((x) => /stopRule/.test(x)) && r.reasons.some((x) => /event/.test(x)), r.reasons.join('; '));
  assert.deepEqual(readdirSync(opts.outDir), []);
});

test('proposePlan: a plan the guard rejects is refused with the rule numbers; nothing is written', async () => {
  const { proposePlan } = await load();
  const plan = newPlan();
  plan.environment = 'Production';
  plan.hypothesis += ' We will peek daily and stop early if it looks good.';
  const opts = base({ runAgent: agentReturning(envelope(JSON.stringify(plan))) });
  const r = await proposePlan(opts);
  assert.equal(r.status, 'refused');
  assert.equal(r.stage, 'guard');
  assert.deepEqual(r.verdict.guard.violations.map((v) => v.rule).sort(), ['G7', 'G9']);
  assert.deepEqual(readdirSync(opts.outDir), []);
});

test('proposePlan: the AI can never target Production, even if the caller asks', async () => {
  const { proposePlan } = await load();
  const plan = newPlan();
  plan.environment = 'Production';
  const r = await proposePlan(base({ runAgent: agentReturning(envelope(JSON.stringify(plan))), allowProduction: true }));
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.verdict.guard.violations.map((v) => v.rule), ['G9']);
});

test('proposePlan: an id or flag key that already exists is refused; an existing file is never overwritten', async () => {
  const { proposePlan } = await load();
  const dir = outDir();
  writeFileSync(join(dir, 'proposed_cta_1.json'), '{"keep":"me"}');
  const r = await proposePlan(base({ outDir: dir, runAgent: agentReturning(envelope(JSON.stringify(newPlan()))) }));
  assert.equal(r.status, 'refused');
  assert.match(r.reasons.join(' '), /already exists/);
  assert.equal(readFileSync(join(dir, 'proposed_cta_1.json'), 'utf8'), '{"keep":"me"}');

  const clash = await proposePlan(base({ runAgent: agentReturning(envelope(JSON.stringify({ ...newPlan(), flag: { ...newPlan().flag, key: VALID.flag.key } }))) }));
  assert.equal(clash.status, 'refused');
  assert.match(clash.reasons.join(' '), /flag key/);
});

test('proposePlan: an agent timeout or a failed agent is refused at the agent stage', async () => {
  const { proposePlan } = await load();
  const t = await proposePlan(base({ runAgent: agentReturning('', { timedOut: true, code: null, ms: 1000 }) }));
  assert.equal(t.status, 'refused');
  assert.equal(t.stage, 'agent');
  assert.match(t.reasons[0], /did not answer/);
  const f = await proposePlan(base({ runAgent: agentReturning('', { code: 1, stderr: 'not logged in' }) }));
  assert.equal(f.stage, 'agent');
  assert.match(f.reasons[0], /exit code 1.*not logged in/);
});

function fakeSpawn({ stdout = '', exitAfterMs = 0, neverExit = false } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let input = '';
    child.stdin.on('data', (d) => { input += d; });
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null, 'SIGTERM')); return true; };
    calls.push({ command, args, options, child, input: () => input });
    if (!neverExit) {
      setTimeout(() => { child.stdout.end(stdout); child.stderr.end(); child.emit('close', 0, null); }, exitAfterMs);
    }
    return child;
  };
  return { spawnImpl, calls };
}

test('runAgent: times out, kills the agent and says so', async () => {
  const { runAgent } = await load();
  const { spawnImpl, calls } = fakeSpawn({ neverExit: true });
  const r = await runAgent({ prompt: 'p', spawnImpl, timeoutMs: 50 });
  assert.equal(r.timedOut, true);
  assert.equal(calls[0].child.killed, true);
});

test('runAgent: no credentials reach the agent; no tools; works outside the repo; prompt on stdin', async () => {
  const { runAgent, childEnv, AGENT } = await load();
  const secretEnv = {
    PATH: 'C:\\bin', USERPROFILE: 'C:\\Users\\x', APPDATA: 'C:\\a', SystemRoot: 'C:\\Windows',
    FLAGSMITH_ADMIN_TOKEN: 'admin-token-value', FLAGSMITH_ENVIRONMENT_KEY: 'env-key-value',
    ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 's', NPM_CONFIG_PASSWORD: 'p', RANDOM_THING: 'r',
  };
  const env = childEnv(secretEnv);
  assert.deepEqual(Object.keys(env).sort(), ['APPDATA', 'PATH', 'SystemRoot', 'USERPROFILE']);

  const saved = process.env.FLAGSMITH_ADMIN_TOKEN;
  process.env.FLAGSMITH_ADMIN_TOKEN = 'admin-token-value';
  try {
    const { spawnImpl, calls } = fakeSpawn({ stdout: envelope('{}') });
    const r = await runAgent({ prompt: 'the prompt', spawnImpl });
    assert.equal(r.code, 0);
    const { command, args, options, input } = calls[0];
    assert.equal(command, AGENT.command);
    assert.ok(!Object.keys(options.env).some((k) => /FLAGSMITH|TOKEN|KEY|SECRET|PASSWORD/i.test(k)), Object.keys(options.env).join(','));
    assert.ok(!JSON.stringify(options.env).includes('admin-token-value'));
    const tools = args.indexOf('--tools');
    assert.ok(tools >= 0 && args[tools + 1] === '', 'all tools disabled');
    assert.ok(args.includes('-p') && args.includes('--strict-mcp-config'));
    assert.ok(!resolve(options.cwd).startsWith(REPO), `agent runs outside the repo, got ${options.cwd}`);
    assert.equal(input(), 'the prompt');
    assert.ok(!args.join(' ').includes('the prompt'), 'prompt goes on stdin, not the command line');
  } finally {
    if (saved === undefined) delete process.env.FLAGSMITH_ADMIN_TOKEN; else process.env.FLAGSMITH_ADMIN_TOKEN = saved;
  }
});

test('buildPrompt: sentence, app source, example plans and the rules; asks for JSON only; Development only', async () => {
  const { buildPrompt } = await load();
  const p = buildPrompt({ sentence: 'Try a shorter headline.', appSource: APP, examplePlans: [VALID] });
  assert.match(p, /Try a shorter headline\./);
  assert.ok(p.includes(APP));
  assert.ok(p.includes(JSON.stringify(VALID, null, 2)));
  assert.match(p, /JSON/);
  assert.match(p, /Development/);
  for (const rule of ['G1', 'G6', 'G7', 'G10']) assert.ok(p.includes(rule), rule);
});

test('scripted bad plans (one per guard-rule family) are labelled scripted and refused with the expected rule', () => {
  const dir = path('fixtures/planner/scripted');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  assert.deepEqual(files, ['missing-control.json', 'peeking-language.json', 'production-without-allow.json', 'stop-when-significant.json']);
  for (const f of files) {
    const s = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    assert.match(s.label, /^SCRIPTED/);
    const verdict = checkPlan(s.plan, { appSource: APP });
    assert.equal(verdict.ok, false, f);
    assert.ok(verdict.violations.some((v) => v.rule === s.expectRule), `${f}: expected ${s.expectRule}, got ${verdict.violations.map((v) => v.rule)}`);
  }
});

test('recorded real planner run: raw agent output and guard verdict are saved, and re-checking gives the same verdict', async () => {
  const { parseAgentOutput } = await load();
  const root = path('fixtures/planner/recorded');
  assert.ok(existsSync(root), 'fixtures/planner/recorded exists');
  const runs = readdirSync(root).filter((d) => !d.includes('.'));
  assert.ok(runs.length >= 1, 'at least one recorded run');
  for (const run of runs) {
    const dir = join(root, run);
    const stdout = readFileSync(join(dir, 'stdout.txt'), 'utf8');
    const verdict = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8'));
    const request = JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'));
    assert.ok(!request.envKeys.some((k) => /FLAGSMITH|TOKEN|KEY|SECRET|PASSWORD/i.test(k)));
    const parsed = parseAgentOutput(stdout);
    if (verdict.stage === 'parse') { assert.equal(parsed.ok, false); continue; }
    assert.equal(parsed.ok, true, parsed.reason);
    const app = readFileSync(path(request.app), 'utf8');
    assert.deepEqual(checkPlan(parsed.plan, { appSource: app, startedExperimentFlagKeys: request.startedExperimentFlagKeys }), verdict.guard);
  }
});


test('recordPlannerRun: saves the raw output but blanks account fields (credential expiry); env values are never saved', async () => {
  const { recordPlannerRun } = await load();
  const dir = mkdtempSync(join(tmpdir(), 'ep-record-'));
  const stdout = envelope(JSON.stringify(newPlan()), { credential_expires_at: '2026-12-01T00:00:00Z', session_id: 's1' });
  recordPlannerRun(dir, {
    sentence: 's', app: 'site/app.js', command: 'claude', args: ['-p'], envKeys: ['PATH'], startedExperimentFlagKeys: [],
    result: { prompt: 'p', raw: { stdout, stderr: '', code: 0, timedOut: false, ms: 1 }, verdict: { status: 'proposed' } },
  });
  const saved = JSON.parse(readFileSync(join(dir, 'stdout.txt'), 'utf8'));
  assert.equal(saved.credential_expires_at, '<redacted>');
  assert.equal(saved.session_id, 's1');
  assert.equal(saved.result, JSON.parse(stdout).result, 'the reply itself is kept byte for byte');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')).envKeys, ['PATH']);
});
