// Approval gate: verifyApproval refusals and the human `approve` command.
// Written before src/approval.js and src/approve.js existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

const PLAN_PATH = fileURLToPath(new URL('../fixtures/plans/valid-plan.json', import.meta.url));
const VALID_PLAN = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
const plan = () => structuredClone(VALID_PLAN);
const loadApproval = () => import('../src/approval.js');
const loadApprove = () => import('../src/approve.js');
const NOW = new Date('2026-11-26T08:00:00.000Z');

async function goodApprovalText(p = plan()) {
  const { createApprovalRecord } = await loadApproval();
  return JSON.stringify(createApprovalRecord({ plan: p, approver: 'Ragul', now: NOW }));
}

test('createApprovalRecord has exactly planId, approver, approvedAt, planSha256, diffSha256', async () => {
  const { createApprovalRecord } = await loadApproval();
  const { planSha256 } = await import('../src/plan.js');
  const { buildDiff, diffSha256 } = await import('../src/diff.js');
  const record = createApprovalRecord({ plan: plan(), approver: '  Ragul ', now: NOW });
  assert.deepEqual(record, {
    planId: 'pilot_rehearsal_1',
    approver: 'Ragul',
    approvedAt: '2026-11-26T08:00:00.000Z',
    planSha256: planSha256(plan()),
    diffSha256: diffSha256(buildDiff(plan())),
  });
});

test('verifyApproval accepts a matching approval', async () => {
  const { verifyApproval } = await loadApproval();
  assert.deepEqual(verifyApproval(plan(), await goodApprovalText()), { ok: true });
});

test('verifyApproval refuses: missing approval file', async () => {
  const { verifyApproval } = await loadApproval();
  const r = verifyApproval(plan(), null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no approval/i);
});

test('verifyApproval refuses: malformed JSON', async () => {
  const { verifyApproval } = await loadApproval();
  for (const text of ['{not json', '', '[]', '"yes"', 'null']) {
    const r = verifyApproval(plan(), text);
    assert.equal(r.ok, false, `should refuse ${JSON.stringify(text)}`);
    assert.match(r.reason, /malformed|not valid/i);
  }
});

test('verifyApproval refuses: empty approver', async () => {
  const { verifyApproval } = await loadApproval();
  for (const approver of ['', '   ', undefined, 7]) {
    const record = JSON.parse(await goodApprovalText());
    record.approver = approver;
    const r = verifyApproval(plan(), JSON.stringify(record));
    assert.equal(r.ok, false);
    assert.match(r.reason, /approver/i);
  }
});

test('verifyApproval refuses: planSha256 mismatch (plan edited after approval)', async () => {
  const { verifyApproval } = await loadApproval();
  const text = await goodApprovalText();
  const edited = plan();
  edited.hypothesis += ' (edited after approval)';
  const r = verifyApproval(edited, text);
  assert.equal(r.ok, false);
  assert.match(r.reason, /plan.*changed|planSha256/i);
});

test('verifyApproval refuses: diffSha256 mismatch', async () => {
  const { verifyApproval } = await loadApproval();
  const record = JSON.parse(await goodApprovalText());
  record.diffSha256 = '0'.repeat(64);
  const r = verifyApproval(plan(), JSON.stringify(record));
  assert.equal(r.ok, false);
  assert.match(r.reason, /diff/i);
});

test('verifyApproval refuses: approval for a different planId', async () => {
  const { verifyApproval } = await loadApproval();
  const other = plan();
  other.id = 'pilot_rehearsal_2';
  const r = verifyApproval(plan(), await goodApprovalText(other));
  assert.equal(r.ok, false);
  assert.match(r.reason, /pilot_rehearsal_2/);
});

test('verifyApproval refuses an approvedAt that is not a date', async () => {
  const { verifyApproval } = await loadApproval();
  const record = JSON.parse(await goodApprovalText());
  record.approvedAt = 'yesterday';
  assert.equal(verifyApproval(plan(), JSON.stringify(record)).ok, false);
});

test('readApprovalText returns null for a missing file and the text for a present one', async () => {
  const { readApprovalText } = await loadApproval();
  const dir = mkdtempSync(join(tmpdir(), 'ep-approvals-'));
  assert.equal(readApprovalText('pilot_rehearsal_1', dir), null);
  writeFileSync(join(dir, 'pilot_rehearsal_1.json'), '{"x":1}');
  assert.equal(readApprovalText('pilot_rehearsal_1', dir), '{"x":1}');
  assert.throws(() => readApprovalText('../escape', dir), /plan id/i);
});

// --- the human command -------------------------------------------------------

function session(lines, { tty = false } = {}) {
  const input = new PassThrough();
  if (tty) input.isTTY = true;
  const output = new PassThrough();
  let out = '';
  output.on('data', (d) => { out += d; });
  input.end(lines.map((l) => `${l}\n`).join(''));
  return { input, output, text: () => out };
}

test('approve writes approvals/<planId>.json after a name and a typed "yes"', async () => {
  const { runApprove } = await loadApprove();
  const { verifyApproval } = await loadApproval();
  const dir = mkdtempSync(join(tmpdir(), 'ep-approve-'));
  const s = session(['Ragul', 'yes'], { tty: true });
  const code = await runApprove({ planPath: PLAN_PATH, approvalsDir: dir, input: s.input, output: s.output, errorOutput: s.output, now: () => NOW });
  assert.equal(code, 0, s.text());
  const written = readFileSync(join(dir, 'pilot_rehearsal_1.json'), 'utf8');
  assert.deepEqual(verifyApproval(plan(), written), { ok: true });
  assert.equal(JSON.parse(written).approver, 'Ragul');
  assert.ok(s.text().includes('CREATE flag pilot_rehearsal_1'), 'the diff was printed before asking');
});

test('approve refuses anything but an exact "yes" and writes nothing', async () => {
  const { runApprove } = await loadApprove();
  for (const answer of ['y', 'YES', 'no', '', 'yes please']) {
    const dir = mkdtempSync(join(tmpdir(), 'ep-approve-'));
    const s = session(['Ragul', answer], { tty: true });
    const code = await runApprove({ planPath: PLAN_PATH, approvalsDir: dir, input: s.input, output: s.output, errorOutput: s.output, now: () => NOW });
    assert.equal(code, 1, `answer ${JSON.stringify(answer)} must not approve`);
    assert.deepEqual(readdirSync(dir), []);
  }
});

test('approve refuses an empty name and writes nothing', async () => {
  const { runApprove } = await loadApprove();
  const dir = mkdtempSync(join(tmpdir(), 'ep-approve-'));
  const s = session(['   ', 'yes'], { tty: true });
  assert.equal(await runApprove({ planPath: PLAN_PATH, approvalsDir: dir, input: s.input, output: s.output, errorOutput: s.output, now: () => NOW }), 1);
  assert.deepEqual(readdirSync(dir), []);
});

test('approve refuses input that is not an interactive terminal (a person must type it)', async () => {
  const { runApprove } = await loadApprove();
  const dir = mkdtempSync(join(tmpdir(), 'ep-approve-'));
  const s = session(['Ragul', 'yes'], { tty: false });
  const code = await runApprove({ planPath: PLAN_PATH, approvalsDir: dir, input: s.input, output: s.output, errorOutput: s.output, now: () => NOW });
  assert.equal(code, 1);
  assert.match(s.text(), /terminal/i);
  assert.deepEqual(readdirSync(dir), []);
});

test('approve refuses a missing or invalid plan file and writes nothing', async () => {
  const { runApprove } = await loadApprove();
  const dir = mkdtempSync(join(tmpdir(), 'ep-approve-'));
  const bad = join(dir, 'bad-plan.json');
  writeFileSync(bad, JSON.stringify({ id: 'x' }));
  for (const planPath of [join(dir, 'missing.json'), bad]) {
    const s = session(['Ragul', 'yes'], { tty: true });
    assert.equal(await runApprove({ planPath, approvalsDir: dir, input: s.input, output: s.output, errorOutput: s.output, now: () => NOW }), 1);
    assert.equal(existsSync(join(dir, 'x.json')), false);
  }
});
