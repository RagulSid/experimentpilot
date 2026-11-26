// Approval gate, two phases: CREATE and START, each with its own diff and its own file
// approvals/<planId>.<phase>.json. verifyApproval refusals and the human `approve` command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

const PLAN_PATH = fileURLToPath(new URL('../fixtures/plans/valid-plan.json', import.meta.url));
const APP_PATH = fileURLToPath(new URL('../fixtures/app/experiment.mjs', import.meta.url));
const VALID_PLAN = JSON.parse(readFileSync(PLAN_PATH, 'utf8'));
const plan = () => structuredClone(VALID_PLAN);
const loadApproval = () => import('../src/approval.js');
const loadApprove = () => import('../src/approve.js');
const NOW = new Date('2026-11-26T08:00:00.000Z');

async function goodApprovalText(p = plan(), phase = 'create') {
  const { createApprovalRecord } = await loadApproval();
  return JSON.stringify(createApprovalRecord({ plan: p, phase, approver: 'Ragul', now: NOW }));
}

test('createApprovalRecord has exactly planId, phase, approver, approvedAt, planSha256, diffSha256', async () => {
  const { createApprovalRecord } = await loadApproval();
  const { planSha256 } = await import('../src/plan.js');
  const { buildDiff, diffSha256 } = await import('../src/diff.js');
  for (const phase of ['create', 'start']) {
    const record = createApprovalRecord({ plan: plan(), phase, approver: '  Ragul ', now: NOW });
    assert.deepEqual(record, {
      planId: 'pilot_rehearsal_1',
      phase,
      approver: 'Ragul',
      approvedAt: '2026-11-26T08:00:00.000Z',
      planSha256: planSha256(plan()),
      diffSha256: diffSha256(buildDiff(plan(), phase)),
    });
  }
});

test('approvalPath is approvals/<planId>.<phase>.json and rejects unsafe ids and unknown phases', async () => {
  const { approvalPath } = await loadApproval();
  assert.equal(approvalPath('pilot_rehearsal_1', 'create', 'approvals').split('\\').join('/'), 'approvals/pilot_rehearsal_1.create.json');
  assert.equal(approvalPath('pilot_rehearsal_1', 'start', 'approvals').split('\\').join('/'), 'approvals/pilot_rehearsal_1.start.json');
  assert.throws(() => approvalPath('../escape', 'create'), /plan id/i);
  assert.throws(() => approvalPath('pilot_rehearsal_1', 'apply'), /phase/i);
});

test('verifyApproval accepts a matching approval for the same phase', async () => {
  const { verifyApproval } = await loadApproval();
  assert.deepEqual(verifyApproval(plan(), await goodApprovalText(plan(), 'create'), 'create'), { ok: true });
  assert.deepEqual(verifyApproval(plan(), await goodApprovalText(plan(), 'start'), 'start'), { ok: true });
});

test('verifyApproval refuses: missing approval file', async () => {
  const { verifyApproval } = await loadApproval();
  const r = verifyApproval(plan(), null, 'create');
  assert.equal(r.ok, false);
  assert.match(r.reason, /no create approval/i);
});

test('verifyApproval refuses: malformed JSON', async () => {
  const { verifyApproval } = await loadApproval();
  for (const text of ['{not json', '', '[]', '"yes"', 'null']) {
    const r = verifyApproval(plan(), text, 'create');
    assert.equal(r.ok, false, `should refuse ${JSON.stringify(text)}`);
    assert.match(r.reason, /malformed|not valid/i);
  }
});

test('verifyApproval refuses: empty approver', async () => {
  const { verifyApproval } = await loadApproval();
  for (const approver of ['', '   ', undefined, 7]) {
    const record = JSON.parse(await goodApprovalText());
    record.approver = approver;
    const r = verifyApproval(plan(), JSON.stringify(record), 'create');
    assert.equal(r.ok, false);
    assert.match(r.reason, /approver/i);
  }
});

test('verifyApproval refuses: planSha256 mismatch (plan edited after approval)', async () => {
  const { verifyApproval } = await loadApproval();
  const text = await goodApprovalText();
  const edited = plan();
  edited.hypothesis += ' (edited after approval)';
  const r = verifyApproval(edited, text, 'create');
  assert.equal(r.ok, false);
  assert.match(r.reason, /plan changed after approval/i);
});

test('verifyApproval refuses: diffSha256 mismatch', async () => {
  const { verifyApproval } = await loadApproval();
  const record = JSON.parse(await goodApprovalText());
  record.diffSha256 = '0'.repeat(64);
  const r = verifyApproval(plan(), JSON.stringify(record), 'create');
  assert.equal(r.ok, false);
  assert.match(r.reason, /diff/i);
});

test('verifyApproval refuses: approval for a different planId', async () => {
  const { verifyApproval } = await loadApproval();
  const other = plan();
  other.id = 'pilot_rehearsal_2';
  const r = verifyApproval(plan(), await goodApprovalText(other), 'create');
  assert.equal(r.ok, false);
  assert.match(r.reason, /pilot_rehearsal_2/);
});

test('verifyApproval refuses: a CREATE approval used for START (and the reverse)', async () => {
  const { verifyApproval } = await loadApproval();
  const asStart = verifyApproval(plan(), await goodApprovalText(plan(), 'create'), 'start');
  assert.equal(asStart.ok, false);
  assert.match(asStart.reason, /phase/i);
  const asCreate = verifyApproval(plan(), await goodApprovalText(plan(), 'start'), 'create');
  assert.equal(asCreate.ok, false);
});

test('verifyApproval refuses an approvedAt that is not a date', async () => {
  const { verifyApproval } = await loadApproval();
  const record = JSON.parse(await goodApprovalText());
  record.approvedAt = 'yesterday';
  assert.equal(verifyApproval(plan(), JSON.stringify(record), 'create').ok, false);
});

test('readApprovalText returns null for a missing file and the text for a present one', async () => {
  const { readApprovalText } = await loadApproval();
  const dir = mkdtempSync(join(tmpdir(), 'ep-approvals-'));
  assert.equal(readApprovalText('pilot_rehearsal_1', 'create', dir), null);
  writeFileSync(join(dir, 'pilot_rehearsal_1.create.json'), '{"x":1}');
  assert.equal(readApprovalText('pilot_rehearsal_1', 'create', dir), '{"x":1}');
  assert.equal(readApprovalText('pilot_rehearsal_1', 'start', dir), null);
});

// --- the human command -------------------------------------------------------

function session(lines, { tty = true } = {}) {
  const input = new PassThrough();
  if (tty) input.isTTY = true;
  const output = new PassThrough();
  let out = '';
  output.on('data', (d) => { out += d; });
  input.end(lines.map((l) => `${l}\n`).join(''));
  return { input, output, text: () => out };
}

const run = async (s, over = {}) => {
  const { runApprove } = await loadApprove();
  return runApprove({ planPath: PLAN_PATH, appPath: APP_PATH, phase: 'create', input: s.input, output: s.output, errorOutput: s.output, now: () => NOW, ...over });
};

test('approve CREATE writes approvals/<planId>.create.json after a name and a typed "yes"', async () => {
  const { verifyApproval } = await loadApproval();
  const dir = mkdtempSync(join(tmpdir(), 'ep-approve-'));
  const s = session(['Ragul', 'yes']);
  assert.equal(await run(s, { approvalsDir: dir }), 0, s.text());
  const written = readFileSync(join(dir, 'pilot_rehearsal_1.create.json'), 'utf8');
  assert.deepEqual(verifyApproval(plan(), written, 'create'), { ok: true });
  assert.ok(s.text().includes('Phase CREATE'), 'the CREATE diff was printed before asking');
  assert.ok(!s.text().includes('START experiment'));
});

test('approve START needs a valid CREATE approval first, then writes <planId>.start.json', async () => {
  const { verifyApproval } = await loadApproval();
  const dir = mkdtempSync(join(tmpdir(), 'ep-approve-'));
  const early = session(['Ragul', 'yes']);
  assert.equal(await run(early, { approvalsDir: dir, phase: 'start' }), 1);
  assert.match(early.text(), /create approval/i);
  assert.deepEqual(readdirSync(dir), []);

  assert.equal(await run(session(['Ragul', 'yes']), { approvalsDir: dir }), 0);
  const s = session(['Ragul', 'yes']);
  assert.equal(await run(s, { approvalsDir: dir, phase: 'start' }), 0, s.text());
  assert.match(s.text(), /deployed/i);
  const written = readFileSync(join(dir, 'pilot_rehearsal_1.start.json'), 'utf8');
  assert.deepEqual(verifyApproval(plan(), written, 'start'), { ok: true });
});

test('approve refuses a plan that fails the guard (it reads --app)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ep-approve-'));
  const badApp = join(dir, 'app.mjs');
  writeFileSync(badApp, "export const CTA_EVENT = 'CTA_Clicked';\nexport const FALLBACK_VALUE = 'control';\n");
  const s = session(['Ragul', 'yes']);
  assert.equal(await run(s, { approvalsDir: dir, appPath: badApp }), 1);
  assert.match(s.text(), /G8/);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.json')), []);
});

test('approve refuses without --app or with an unknown phase', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ep-approve-'));
  assert.equal(await run(session(['Ragul', 'yes']), { approvalsDir: dir, appPath: undefined }), 1);
  assert.equal(await run(session(['Ragul', 'yes']), { approvalsDir: dir, phase: 'apply' }), 1);
  assert.deepEqual(readdirSync(dir), []);
});

test('approve refuses anything but an exact "yes" and writes nothing', async () => {
  for (const answer of ['y', 'YES', 'no', '', 'yes please']) {
    const dir = mkdtempSync(join(tmpdir(), 'ep-approve-'));
    assert.equal(await run(session(['Ragul', answer]), { approvalsDir: dir }), 1, `answer ${JSON.stringify(answer)} must not approve`);
    assert.deepEqual(readdirSync(dir), []);
  }
});

test('approve refuses an empty name and writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ep-approve-'));
  assert.equal(await run(session(['   ', 'yes']), { approvalsDir: dir }), 1);
  assert.deepEqual(readdirSync(dir), []);
});

test('approve refuses input that is not an interactive terminal (a person must type it)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ep-approve-'));
  const s = session(['Ragul', 'yes'], { tty: false });
  assert.equal(await run(s, { approvalsDir: dir }), 1);
  assert.match(s.text(), /terminal/i);
  assert.deepEqual(readdirSync(dir), []);
});

test('approve refuses a missing or invalid plan file and writes nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ep-approve-'));
  const bad = join(dir, 'bad-plan.json');
  writeFileSync(bad, JSON.stringify({ id: 'x' }));
  for (const planPath of [join(dir, 'missing.json'), bad]) {
    assert.equal(await run(session(['Ragul', 'yes']), { approvalsDir: dir, planPath }), 1);
    assert.equal(existsSync(join(dir, 'x.create.json')), false);
  }
});
