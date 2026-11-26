// The checks behind `npm run check`. Plain code; each returns a list of problems (empty = pass).
// Secret values are never printed: problems name the kind of secret and the file only.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validatePlan } from './plan.js';
import { checkPlan } from './guard.js';
import { readApprovalText, verifyApproval } from './approval.js';

// --- README --------------------------------------------------------------------------------

// The first two patterns are the crosschecker's H4a and H4b; the placeholder pattern is its H11.
const README_RULES = [
  [/^#+ .*(setup|install|quick ?start|getting started|run it|try it)/im, 'README needs a setup heading (setup, install, quick start, run it or try it)'],
  [/^#+ .*flagsmith/im, 'README needs a heading about how Flagsmith is used'],
  [/^#+ .*AI-assisted/im, 'README needs the "How this was built: AI-assisted" section'],
  [/^#+ Before the start/im, 'README needs the "Before the start" disclosure section'],
];
const PLACEHOLDERS = /TODO|link coming|coming soon|<your-|<\.\.\.>|lorem ipsum/i;

export function checkReadme(text) {
  const problems = README_RULES.filter(([re]) => !re.test(text)).map(([, why]) => why);
  const line = text.split('\n').findIndex((l) => PLACEHOLDERS.test(l));
  if (line >= 0) problems.push(`README has a placeholder on line ${line + 1}`);
  return problems;
}

// --- guard on every plan ------------------------------------------------------------------------

// Every plan in plans/ and plans/proposed/ must pass the shape check and the guard. Production is
// allowed only for a plan with a valid committed CREATE approval (a person already approved it).
export function checkPlans({ root = '.', appSource }) {
  const problems = [];
  const checked = [];
  for (const sub of ['plans', join('plans', 'proposed')]) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const shown = join(sub, file);
      let plan;
      try {
        plan = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      } catch (err) {
        problems.push(`${shown}: not valid JSON (${err.message})`);
        continue;
      }
      const shape = validatePlan(plan);
      if (!shape.ok) {
        problems.push(`${shown}: ${plan.id ?? '?'}: invalid plan: ${shape.errors.join('; ')}`);
        continue;
      }
      const approved = plan.environment === 'Production'
        && verifyApproval(plan, readApprovalText(plan.id, 'create', join(root, 'approvals')), 'create').ok;
      const guard = checkPlan(plan, { appSource, allowProduction: approved });
      for (const v of guard.violations) problems.push(`${shown}: ${plan.id}: ${v.rule} ${v.reason}`);
      checked.push({ file: shown, id: plan.id, environment: plan.environment, ok: guard.ok, productionApproved: approved });
    }
  }
  return { problems, checked };
}

// --- secret scan ------------------------------------------------------------------------------------

const FORBIDDEN_FILE = /(^|\/)(\.env(\..*)?|flagsmith\.json|flagsmith\.production\.json|flagsmith\.env|config\.local\.[^/]+|[^/]*\.local\.js|\.flagsmith-admin-token)$/;
const SHAPES = [
  ['admin-token shape', /(?<![A-Za-z0-9])[A-Za-z0-9]{8}\.[A-Za-z0-9]{32}(?![A-Za-z0-9])/g],
  ['server-side key (ser.)', /ser\.[A-Za-z0-9]{20,}/g],
  ['Api-Key header with a value', /Api-Key\s+(?!<)[A-Za-z0-9._-]{12,}/g],
];
// A Flagsmith client-side key: 22 letters and digits. Both real keys we hold contain digits, and
// 22-letter words such as minExposuresPerVariant are code, so a digit is required.
const KEY_22 = /(?<![A-Za-z0-9_$])[A-Za-z0-9]{22}(?![A-Za-z0-9_])/g;
const PLACEHOLDER_KEY = /^[A-Za-z]+0{5,}[0-9]*$/; // e.g. FakeEnvKey000000000001

function blobsInHistory(dir) {
  const git = (args, input) => execFileSync('git', args, { cwd: dir, input, maxBuffer: 1 << 30 });
  const lines = git(['rev-list', '--objects', '--all']).toString('utf8').split('\n').filter((l) => l.includes(' '));
  const paths = new Map();
  for (const l of lines) {
    const i = l.indexOf(' ');
    const sha = l.slice(0, i);
    if (!paths.has(sha)) paths.set(sha, new Set());
    paths.get(sha).add(l.slice(i + 1));
  }
  if (!paths.size) return [];
  const out = git(['cat-file', '--batch'], [...paths.keys()].join('\n') + '\n');
  const blobs = [];
  let pos = 0;
  while (pos < out.length) {
    const nl = out.indexOf(10, pos);
    const [sha, type, size] = out.subarray(pos, nl).toString('utf8').split(' ');
    const start = nl + 1;
    const end = start + Number(size);
    if (type === 'blob') blobs.push({ where: `history: ${[...paths.get(sha)].join(', ')}`, text: out.subarray(start, end).toString('utf8') });
    pos = end + 1;
  }
  return blobs;
}

function filesInTree(dir) {
  const list = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean);
  return list.flatMap((f) => {
    try { return [{ where: `tree: ${f}`, text: readFileSync(join(dir, f), 'utf8') }]; } catch { return []; }
  });
}

// Scans every file version in the git history (all refs) and the working tree git would see
// (tracked plus untracked, not ignored). knownSecrets: { name: value } matched byte for byte.
export function scanRepo({ dir = '.', allowedKeys = [], knownSecrets = {} }) {
  const problems = [];
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 30 });
  const names = new Set([
    ...git('log', '--all', '--name-only', '--format=').split('\n').filter(Boolean),
    ...git('ls-files', '-co', '--exclude-standard').split('\n').filter(Boolean),
  ]);
  for (const n of [...names].sort()) if (FORBIDDEN_FILE.test(n)) problems.push(`forbidden file committed or about to be: ${n}`);

  const secrets = Object.entries(knownSecrets).filter(([, v]) => typeof v === 'string' && v.length >= 8);
  const seen = new Set();
  const add = (p) => { if (!seen.has(p)) { seen.add(p); problems.push(p); } };
  const items = [...blobsInHistory(dir), ...filesInTree(dir)];
  for (const { where, text } of items) {
    for (const [name, value] of secrets) if (text.includes(value)) add(`known secret ${name} found in ${where}`);
    for (const [name, re] of SHAPES) if (re.test(text)) { re.lastIndex = 0; add(`${name} found in ${where}`); }
    for (const m of text.matchAll(KEY_22)) {
      const v = m[0];
      if (!/\d/.test(v) || !/[A-Za-z]/.test(v) || allowedKeys.includes(v) || PLACEHOLDER_KEY.test(v)) continue;
      add(`unknown 22-character key (${v.slice(0, 2)}…) found in ${where}`);
    }
  }
  return { problems, scanned: { files: items.length, names: names.size } };
}
