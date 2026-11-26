// Approval records, one per phase: build, read, verify. This module never writes files;
// only the human command in src/approve.js does (checked by test/approvals-writer.test.js).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLAN_ID_PATTERN, validatePlan, planSha256 } from './plan.js';
import { assertPhase, buildDiff, diffSha256 } from './diff.js';

export const APPROVALS_DIR = 'approvals';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function approvalPath(planId, phase, dir = APPROVALS_DIR) {
  if (typeof planId !== 'string' || !PLAN_ID_PATTERN.test(planId)) {
    throw new Error(`invalid plan id ${JSON.stringify(planId)}`);
  }
  assertPhase(phase);
  return join(dir, `${planId}.${phase}.json`);
}

// The approval file's text, or null when there is none.
export function readApprovalText(planId, phase, dir = APPROVALS_DIR) {
  try {
    return readFileSync(approvalPath(planId, phase, dir), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function createApprovalRecord({ plan, phase, approver, now, rollout }) {
  assertPhase(phase);
  if (!isText(approver)) throw new Error('an approval needs the approver\'s name');
  return {
    planId: plan.id,
    phase,
    approver: approver.trim(),
    approvedAt: now.toISOString(),
    planSha256: planSha256(plan),
    diffSha256: diffSha256(buildDiff(plan, phase, { rollout })),
  };
}

// { ok: true } only if the approval is for this phase, this exact plan and this exact diff.
export function verifyApproval(plan, approvalText, phase, { rollout } = {}) {
  const refuse = (reason) => ({ ok: false, reason });
  try {
    assertPhase(phase);
  } catch (err) {
    return refuse(err.message);
  }
  const planId = isObject(plan) ? plan.id : undefined;

  if (approvalText === null || approvalText === undefined) {
    return refuse(`no ${phase} approval file for plan ${JSON.stringify(planId)}; a person must run: npm run approve -- <planfile> --app <app file> --phase ${phase}`);
  }
  let record;
  try {
    record = JSON.parse(approvalText);
  } catch {
    return refuse('approval file is malformed: not valid JSON');
  }
  if (!isObject(record)) return refuse('approval file is malformed: not a JSON object');

  if (record.planId !== planId) {
    return refuse(`approval is for plan ${JSON.stringify(record.planId)}, not ${JSON.stringify(planId)}`);
  }
  if (record.phase !== phase) {
    return refuse(`approval is for phase ${JSON.stringify(record.phase)}, not ${JSON.stringify(phase)}`);
  }
  if (!isText(record.approver)) return refuse('approval has no approver name');
  if (typeof record.approvedAt !== 'string' || !ISO_DATE_TIME.test(record.approvedAt) || Number.isNaN(Date.parse(record.approvedAt))) {
    return refuse(`approval has an invalid approvedAt ${JSON.stringify(record.approvedAt)}`);
  }

  const shape = validatePlan(plan);
  if (!shape.ok) return refuse(`plan is invalid: ${shape.errors.join('; ')}`);

  const currentPlan = planSha256(plan);
  if (record.planSha256 !== currentPlan) {
    return refuse(`plan changed after approval: planSha256 is ${currentPlan}, approval says ${JSON.stringify(record.planSha256)}`);
  }
  let currentDiff;
  try {
    currentDiff = diffSha256(buildDiff(plan, phase, { rollout }));
  } catch (err) {
    return refuse(err.message);
  }
  if (record.diffSha256 !== currentDiff) {
    return refuse(`diff changed since approval: diffSha256 is ${currentDiff}, approval says ${JSON.stringify(record.diffSha256)}`);
  }
  return { ok: true };
}
