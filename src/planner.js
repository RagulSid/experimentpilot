// Planner: the AI part, and the only part that uses AI.
// An AI coding agent turns one sentence into a proposed experiment plan (JSON). Plain code then
// parses it strictly (one JSON object, nothing else), checks its shape and runs the guard.
// Pipeline: AI proposes -> guard -> a person approves (src/approve.js) -> applier.
// Nothing here talks to Flagsmith, and the agent never gets Flagsmith credentials:
//   - it runs with a minimal, allow-listed environment (no tokens, keys or secrets),
//   - with every tool disabled (it cannot read files or run commands),
//   - in an empty temporary folder outside the repo,
//   - and gets the app source and example plans only through the prompt, on stdin.
// The output is only a file under plans/proposed/. A proposal can never target Production.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePlan, planSha256 } from './plan.js';
import { checkPlan, RULES } from './guard.js';

// Flags checked against `claude --help` (Claude Code 2.1.325) on 2026-11-26; none are guessed.
//   -p                      print the answer and exit (non-interactive)
//   --output-format json    one JSON result envelope on stdout
//   --tools ""              disable every built-in tool
//   --strict-mcp-config     load no MCP servers (none are given with --mcp-config)
//   --no-session-persistence  do not save the session
export const AGENT = {
  command: 'claude',
  args: ['-p', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--no-session-persistence'],
  verifiedWith: 'claude --help, Claude Code 2.1.325, 2026-11-26',
};

export const DEFAULT_TIMEOUT_MS = 180_000;

// Only what a CLI needs to start and find its own sign-in. Anything that looks like a credential is
// dropped even if it is on this list.
const ENV_ALLOW = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'ComSpec',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG', 'TERM'];
const ENV_DENY = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|FLAGSMITH|AUTH/i;

export function childEnv(parent = process.env) {
  const env = {};
  for (const name of ENV_ALLOW) {
    if (parent[name] !== undefined && !ENV_DENY.test(name)) env[name] = parent[name];
  }
  return env;
}

export function buildPrompt({ sentence, appSource, examplePlans = [], existingFlagKeys = [], existingPlanIds = [] }) {
  const rules = Object.entries(RULES).map(([id, text]) => `- ${id}: ${text}`).join('\n');
  const examples = examplePlans.map((p) => JSON.stringify(p, null, 2)).join('\n\n');
  return [
    'You draft A/B experiment plans for ExperimentPilot, which runs them on Flagsmith.',
    'Turn the goal below into ONE experiment plan.',
    '',
    `GOAL: ${sentence}`,
    '',
    'Reply with exactly one JSON object and nothing else: no prose, no explanation, no code fences.',
    'Use exactly the fields and structure of the example plans (no extra fields).',
    'Constraints:',
    '- environment must be "Development".',
    '- id and flag.key: new, lowercase letters, digits and underscores; flag.key may equal id.',
    `- do not reuse these plan ids: ${JSON.stringify(existingPlanIds)}; or these flag keys: ${JSON.stringify(existingFlagKeys)}.`,
    '- flag.type "multivariate"; one variant has key "control" and value "control"; the others are values the app below understands.',
    '- metric.event must equal the app\'s event constant exactly; decisionRule.primaryMetric must equal metric.name.',
    '- identity.prefixReal "web_", identity.prefixScripted "sim_".',
    '- stopRule: {"type":"minExposuresPerVariant","value":<whole number>} or {"type":"fixedEnd","value":"<ISO date-time with offset>"}; decide the stop rule now, never "stop when significant".',
    '- decisionRule.winProbabilityAtLeast between 0 and 1 (0.95 is usual), intervalExcludesZero true.',
    '- no wording about peeking, stopping early or deciding early anywhere.',
    '',
    'Plain code checks your plan against these rules and rejects it if any fails:',
    rules,
    '',
    'EXAMPLE PLANS:',
    examples,
    '',
    'APP SOURCE (the page that serves the flag and sends the event):',
    appSource,
  ].join('\n');
}

// Strict parse of what the agent printed. Accepts the CLI's result envelope
// ({"type":"result", "result": "<reply text>"}) or a bare JSON object. The reply must be one
// JSON object and nothing else.
export function parseAgentOutput(stdout) {
  let outer;
  try {
    outer = JSON.parse(String(stdout).trim());
  } catch {
    return { ok: false, reason: 'the agent output is not JSON' };
  }
  if (outer && typeof outer === 'object' && outer.type === 'result' && 'result' in outer) {
    if (outer.is_error === true || (outer.subtype && outer.subtype !== 'success')) {
      return { ok: false, reason: `the agent reported an error (${outer.subtype ?? 'is_error'})` };
    }
    const text = String(outer.result ?? '').trim();
    if (!text.startsWith('{') || !text.endsWith('}')) {
      return { ok: false, reason: 'the reply must be only one JSON object: it has prose or code fences around it' };
    }
    try {
      outer = JSON.parse(text);
    } catch (err) {
      return { ok: false, reason: `the reply is not valid JSON: ${err.message}` };
    }
  }
  if (!outer || typeof outer !== 'object' || Array.isArray(outer)) {
    return { ok: false, reason: 'the reply must be only one JSON object' };
  }
  return { ok: true, plan: outer };
}

export function runAgent({
  prompt,
  command = AGENT.command,
  args = AGENT.args,
  env = childEnv(),
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawn,
}) {
  const workDir = cwd ?? mkdtempSync(join(tmpdir(), 'ep-planner-'));
  const started = Date.now();
  return new Promise((resolvePromise) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let timedOut = false;
    const finish = (code, extra = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code, timedOut, ms: Date.now() - started, cwd: workDir, ...extra });
    };
    let child;
    try {
      child = spawnImpl(command, args, { cwd: workDir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolvePromise({ stdout, stderr: err.message, code: null, timedOut: false, ms: 0, cwd: workDir, error: err.message });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; child.kill(); finish(null); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish(null, { error: err.message, stderr: stderr || err.message }));
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {}); // the agent may exit before reading everything
    child.stdin.end(prompt);
  });
}

const refused = (stage, reasons, extra = {}) => ({ status: 'refused', stage, reasons, ...extra });

export async function proposePlan({
  sentence,
  appSource,
  examplePlans = [],
  existingPlanIds = examplePlans.map((p) => p.id),
  existingFlagKeys = examplePlans.map((p) => p.flag?.key).filter(Boolean),
  startedExperimentFlagKeys = [],
  outDir = join('plans', 'proposed'),
  runAgent: run = runAgent,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const prompt = buildPrompt({ sentence, appSource, examplePlans, existingFlagKeys, existingPlanIds });
  const agent = await run({ prompt, timeoutMs });
  const raw = { stdout: agent.stdout, stderr: agent.stderr, code: agent.code, timedOut: agent.timedOut, ms: agent.ms };
  const withVerdict = (r) => ({ ...r, prompt, raw, verdict: { status: r.status, stage: r.stage, reasons: r.reasons, guard: r.guard ?? null, planSha256: r.plan && r.stage !== 'parse' && r.stage !== 'shape' ? planSha256(r.plan) : null } });

  if (agent.timedOut) return withVerdict(refused('agent', [`the agent did not answer within ${Math.round(timeoutMs / 1000)} s; nothing was proposed`]));
  if (agent.code !== 0) {
    return withVerdict(refused('agent', [`the agent failed (exit code ${agent.code}): ${String(agent.stderr || agent.error || '').trim().slice(0, 300)}`]));
  }

  const parsed = parseAgentOutput(agent.stdout);
  if (!parsed.ok) return withVerdict(refused('parse', [parsed.reason]));
  const plan = parsed.plan;

  const shape = validatePlan(plan);
  if (!shape.ok) return withVerdict(refused('shape', shape.errors, { plan }));

  // allowProduction is always false here: an AI proposal can never target Production.
  const guard = checkPlan(plan, { appSource, allowProduction: false, startedExperimentFlagKeys });
  if (!guard.ok) return withVerdict(refused('guard', guard.violations.map((v) => `${v.rule} ${v.reason}`), { plan, guard }));

  const clashes = [];
  if (existingPlanIds.includes(plan.id)) clashes.push(`plan id ${plan.id} already exists`);
  if (existingFlagKeys.includes(plan.flag.key)) clashes.push(`flag key ${plan.flag.key} already exists in another plan`);
  const path = join(outDir, `${plan.id}.json`);
  if (existsSync(path)) clashes.push(`${path} already exists; not overwritten`);
  if (clashes.length) return withVerdict(refused('clash', clashes, { plan, guard }));

  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' });
  return withVerdict({ status: 'proposed', stage: 'done', reasons: [], plan, guard, path });
}

// Fields of the CLI's result envelope that describe the person's account, not the answer.
const ACCOUNT_FIELDS = ['credential_expires_at'];

// The agent's stdout with account fields blanked. Everything else, including the reply, is kept as is.
export function redactAgentStdout(stdout) {
  let o;
  try { o = JSON.parse(stdout); } catch { return stdout; }
  if (!o || typeof o !== 'object') return stdout;
  let changed = false;
  for (const k of ACCOUNT_FIELDS) if (k in o) { o[k] = '<redacted>'; changed = true; }
  return changed ? JSON.stringify(o) : stdout;
}

// Saves one planner run for the record: what was asked, the agent's raw output and the verdict.
// Only environment variable NAMES are saved, never values.
export function recordPlannerRun(dir, { sentence, app, command, args, envKeys, startedExperimentFlagKeys, result }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'request.json'), `${JSON.stringify({ sentence, app, command, args, envKeys, cwd: '<empty temporary folder outside the repo>', startedExperimentFlagKeys, ms: result.raw.ms, exitCode: result.raw.code, timedOut: result.raw.timedOut }, null, 2)}\n`);
  writeFileSync(join(dir, 'prompt.txt'), result.prompt);
  writeFileSync(join(dir, 'stdout.txt'), redactAgentStdout(result.raw.stdout ?? ''));
  writeFileSync(join(dir, 'stderr.txt'), result.raw.stderr ?? '');
  writeFileSync(join(dir, 'verdict.json'), `${JSON.stringify(result.verdict, null, 2)}\n`);
}
