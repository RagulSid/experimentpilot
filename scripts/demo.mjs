// npm run demo: the whole ExperimentPilot story, offline, in one command.
// No network (only a fake Flagsmith on 127.0.0.1), no accounts, no keys. Every section says
// whether its data is RECORDED-REAL (saved from a real run) or SCRIPTED (made up for the demo).
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentOutput } from '../src/planner.js';
import { validatePlan } from '../src/plan.js';
import { checkPlan } from '../src/guard.js';
import { createApprovalRecord } from '../src/approval.js';
import { applyPlan } from '../src/applier.js';
import { createClient } from '../src/flagsmith-client.js';
import { readout, formatReadout } from '../src/readout.js';
import { startFakeFlagsmith } from '../test/helpers/fake-flagsmith.js';

const started = Date.now();
const root = fileURLToPath(new URL('..', import.meta.url));
const at = (p) => join(root, p);
const readJson = (p) => JSON.parse(readFileSync(at(p), 'utf8'));
const APP_FILE = 'site/app.js';
const APP = readFileSync(at(APP_FILE), 'utf8');

// Network guard: only loopback. Anything else throws, so the demo cannot reach Flagsmith.
const requests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error(`demo is offline: refused ${u.hostname}`);
  requests.push(u.hostname);
  return realFetch(url, init);
};

const say = (line = '') => console.log(line);
const section = (n, title, source) => { say(''); say(`== ${n}. ${title}  [${source}]`); };

say('ExperimentPilot demo: offline, no keys, fake Flagsmith on 127.0.0.1.');
say('Labels: RECORDED-REAL = saved from a real run; SCRIPTED = made up for this demo.');

// 1. Planner output, recorded from a real AI run
const runDir = 'fixtures/planner/recorded/2026-11-26-dev-headline';
const request = readJson(`${runDir}/request.json`);
section(1, 'AI planner output, re-checked by plain code', 'RECORDED-REAL AI output, Nov 26');
say(`Sentence: "${request.sentence}"`);
say(`Agent: ${request.command} ${request.args.map((a) => (a === '' ? '""' : a)).join(' ')}  (no tools; env names only: ${request.envKeys.length}, no credentials)`);
const parsed = parseAgentOutput(readFileSync(at(`${runDir}/stdout.txt`), 'utf8'));
if (!parsed.ok) throw new Error(`recorded planner output no longer parses: ${parsed.reason}`);
const proposed = parsed.plan;
const shape = validatePlan(proposed);
const accepted = checkPlan(proposed, { appSource: APP, startedExperimentFlagKeys: request.startedExperimentFlagKeys });
say(`Proposed plan ${proposed.id}: flag ${proposed.flag.key} (${proposed.flag.variants.map((v) => v.key).join(' / ')}), metric "${proposed.metric.name}" on ${proposed.metric.event}, stop rule ${proposed.stopRule.type} ${proposed.stopRule.value}, ${proposed.environment}`);
say(`shape: ${shape.ok ? 'ok' : shape.errors.join('; ')}`);
say(`guard: ${accepted.ok ? 'ACCEPTED (G1-G10 pass)' : `REFUSED ${accepted.violations.map((v) => v.rule).join(', ')}`}`);
if (!accepted.ok) process.exitCode = 1;

// 2. Bad plans, scripted, refused by the guard
section(2, 'The guard refuses bad plans, with the rule number', 'SCRIPTED plans, written by hand');
for (const f of readdirSync(at('fixtures/planner/scripted')).filter((x) => x.endsWith('.json')).sort()) {
  const s = readJson(`fixtures/planner/scripted/${f}`);
  const v = checkPlan(s.plan, { appSource: APP });
  const hit = v.violations.find((x) => x.rule === s.expectRule);
  say(`${hit ? 'REFUSED' : 'NOT REFUSED (unexpected)'} ${s.expectRule}  ${f.replace('.json', '')}: ${hit ? hit.reason : s.why}`);
  if (!hit) process.exitCode = 1;
}

// 3 and 4. Approvals and the applier, against a fake Flagsmith
const TOKEN = 'demo-token-not-a-real-secret';
const ENV_KEY = 'DemoEnvKey000000000001';
const fake = await startFakeFlagsmith({ token: TOKEN, environmentKey: ENV_KEY, projectId: 55988, environmentName: 'Development' });
const tmp = mkdtempSync(join(tmpdir(), 'ep-demo-'));
try {
  const lines = [];
  const client = createClient({ baseUrl: fake.baseUrl, env: { FLAGSMITH_ADMIN_TOKEN: TOKEN }, projectId: 55988, environmentKey: ENV_KEY, log: (l) => lines.push(l) });
  const quiet = () => {};
  // In real use a person types these approvals at a terminal (src/approve.js refuses a script).
  // Here the demo writes them itself, for the fake server only.
  const approval = (plan, phase) => JSON.stringify(createApprovalRecord({ plan, phase, approver: 'demo script (SCRIPTED, fake server only)', now: new Date('2026-11-26T12:00:00Z') }));
  const createApproval = approval(proposed, 'create');

  section(3, 'Tampered approvals are refused before any call', 'SCRIPTED approvals, fake server');
  const edited = { ...structuredClone(proposed), split: { control: 70, variant_b: 30 } };
  const t1 = await applyPlan({ plan: edited, phase: 'create', approvalText: createApproval, appSource: APP, apply: true, client, log: quiet });
  say(`plan edited after approval (split 70/30): tampered -> ${t1.status === 'refused' ? 'REFUSED' : t1.status}: ${t1.reasons?.[0] ?? ''}`);
  const forged = JSON.parse(createApproval);
  forged.diffSha256 = '0'.repeat(64);
  const t2 = await applyPlan({ plan: proposed, phase: 'create', approvalText: JSON.stringify(forged), appSource: APP, apply: true, client, log: quiet });
  say(`approval file with a changed diff hash: tampered -> ${t2.status === 'refused' ? 'REFUSED' : t2.status}: ${t2.reasons?.[0] ?? ''}`);
  const t3 = await applyPlan({ plan: proposed, phase: 'start', approvalText: approval(proposed, 'start'), createApprovalText: null, appSource: APP, apply: true, client, log: quiet });
  say(`START without a CREATE approval: tampered -> ${t3.status === 'refused' ? 'REFUSED' : t3.status}: ${t3.reasons?.[0] ?? ''}`);
  say(`Calls to Flagsmith so far: ${fake.requests.length}`);
  if ([t1, t2, t3].some((t) => t.status !== 'refused') || fake.requests.length) process.exitCode = 1;

  section(4, 'Apply the approved plan: CREATE, then START', 'SCRIPTED fake server replaying RECORDED-REAL Flagsmith bodies');
  const c = await applyPlan({ plan: proposed, phase: 'create', approvalText: createApproval, appSource: APP, apply: true, client, log: (l) => say(`  ${l}`) });
  const s = await applyPlan({ plan: proposed, phase: 'start', approvalText: approval(proposed, 'start'), createApprovalText: createApproval, appSource: APP, apply: true, client, log: (l) => say(`  ${l}`) });
  say(`Writes sent: ${fake.requests.filter((q) => q.method !== 'GET').map((q) => q.route).join(', ')}`);
  if (c.status !== 'applied' || s.status !== 'applied') process.exitCode = 1;
} finally {
  await fake.close();
  rmSync(tmp, { recursive: true, force: true });
}

// 5. Readouts on real recorded results
section(5, 'Readout: scripted sim_ traffic on Development', 'RECORDED-REAL Flagsmith results, SCRIPTED sim_ traffic (400 visitors, made-up rates) plus 4 web_');
const rehearsal = readJson('plans/pilot_rehearsal_1.json');
const devResults = readJson('fixtures/flagsmith/recorded/2026-11-26-web-results/15-getResults.json').response;
const r1 = readout({ plan: rehearsal, results: devResults, metricId: 577, now: new Date('2026-11-26T13:00:00Z') });
say(formatReadout(r1));

section(6, 'Readout: the real experiment in Production, before its stop rule', 'RECORDED-REAL Flagsmith results, real web_ visitors (3, the author\'s own test loads)');
const real = readJson('plans/creatordigest_headline_1.json');
const prodFiles = readdirSync(at('fixtures/flagsmith/recorded/2026-11-26-production-results-1')).filter((f) => f.includes('getResults')).sort();
const prodResults = readJson(`fixtures/flagsmith/recorded/2026-11-26-production-results-1/${prodFiles.at(-1)}`).response;
const r2 = readout({ plan: real, results: prodResults, metricId: 639, now: new Date('2026-11-26T13:30:00Z') });
say(formatReadout(r2));
if (r1.decision !== 'no_clear_winner' || r2.decision !== 'not_ready') process.exitCode = 1;

say('');
say(`network: ${requests.length} request${requests.length === 1 ? '' : 's'}, all to 127.0.0.1 (fake Flagsmith); nothing left this machine`);
say(`done in ${((Date.now() - started) / 1000).toFixed(1)} s${process.exitCode ? ' WITH FAILURES' : ''}`);
