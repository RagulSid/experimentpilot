// npm run check: the pre-push gate. Exits 1 if anything fails; it never prints success it did not see.
//   1. the full test suite (node --test)
//   2. shape check and guard on every plan in plans/ and plans/proposed/
//      (Production only for a plan with a valid committed CREATE approval)
//   3. secret scan of the working tree and every file version in the git history
//      (patterns everywhere; plus exact matches for our own secrets when they exist on this machine)
//   4. README headings (setup, Flagsmith, AI-assisted, Before the start) and no placeholders
// Secret values are never printed.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkReadme, checkPlans, scanRepo } from '../src/check.js';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
const results = [];
const record = (name, problems, detail) => {
  results.push({ name, ok: problems.length === 0, detail });
  console.log(`${problems.length ? 'FAIL' : 'PASS'}  ${name}${detail ? ` (${detail})` : ''}`);
  for (const p of problems) console.log(`        - ${p}`);
};

// 1. tests
const t = spawnSync(process.execPath, ['--test', 'test/**/*.test.js'], { encoding: 'utf8', maxBuffer: 1 << 28 });
const count = (name) => Number((t.stdout.match(new RegExp(`^# ${name} (\\d+)`, 'm')) ?? [])[1] ?? NaN);
const failedTests = [...t.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
record('tests', t.status === 0 ? [] : (failedTests.length ? failedTests : [`node --test exited with ${t.status}`]), `${count('pass')} passed, ${count('fail')} failed`);

// 2. guard on every plan
const plans = checkPlans({ root: '.', appSource: readFileSync('site/app.js', 'utf8') });
record('guard on every plan', plans.problems, plans.checked.map((c) => `${c.id} ${c.environment}${c.productionApproved ? ' approved' : ''}`).join(', '));

// 3. secret scan
const readIf = (p, pick) => { try { return existsSync(p) ? pick(readFileSync(p, 'utf8')) : undefined; } catch { return undefined; } };
const quoted = (name) => (text) => (text.match(new RegExp(`${name}\\s*=\\s*'([^']+)'`)) ?? [])[1];
const productionKey = readIf('site/config.js', quoted('FLAGSMITH_ENVIRONMENT_KEY'));
const knownSecrets = {
  adminToken: readIf('../.flagsmith-admin-token', (s) => s.replace(/[\r\n]/g, '')),
  developmentKey: readIf('site/config.local.js', quoted('FLAGSMITH_ENVIRONMENT_KEY')),
  boundEnvironmentKey: readIf('../flagsmith.json', (s) => JSON.parse(s).environment),
};
for (const [k, v] of Object.entries(knownSecrets)) if (!v || v === productionKey) delete knownSecrets[k];
const scan = scanRepo({ dir: '.', allowedKeys: productionKey ? [productionKey] : [], knownSecrets });
record('secret scan (tree and all history)', scan.problems, `${scan.scanned.files} file versions, ${scan.scanned.names} paths; exact matches for: ${Object.keys(knownSecrets).join(', ') || 'none on this machine (patterns only)'}`);

// 4. README
record('README headings and placeholders', checkReadme(readFileSync('README.md', 'utf8')));

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\nCHECK FAILED: ${failed} of ${results.length} checks failed.` : `\nAll ${results.length} checks passed.`);
process.exitCode = failed ? 1 : 0;
