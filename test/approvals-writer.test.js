// Only the human `approve` command may write approval files.
// Reads every file in src/ as text: a file that calls a file-system write API and mentions
// approvals must be src/approve.js. (A text check: it cannot see a path built at run time.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const ALLOWED_WRITER = 'src/approve.js';

const WRITE_API = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync|cp|cpSync|rename|renameSync|symlink|symlinkSync|link|linkSync|truncate|truncateSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|open|openSync)\s*\(/;
const MENTIONS_APPROVAL = /approval/i;

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.(c|m)?js$/.test(e.name) ? [p] : [];
  });
}

test('no file in src/ except src/approve.js writes to approvals/', () => {
  const files = sourceFiles(SRC);
  assert.ok(files.length > 0);
  const offenders = files
    .map((f) => ({ rel: relative(ROOT, f).split('\\').join('/'), text: readFileSync(f, 'utf8') }))
    .filter(({ rel, text }) => rel !== ALLOWED_WRITER && WRITE_API.test(text) && MENTIONS_APPROVAL.test(text))
    .map(({ rel }) => rel);
  assert.deepEqual(offenders, [], `only ${ALLOWED_WRITER} may write approval files`);
});

test('src/approve.js really is the writer (so the check above is not vacuous)', () => {
  const text = readFileSync(join(SRC, 'approve.js'), 'utf8');
  assert.match(text, WRITE_API);
  assert.match(text, MENTIONS_APPROVAL);
});
