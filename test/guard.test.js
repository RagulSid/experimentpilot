// Guard rules G1 to G10 (docs/experimentpilot-build-prompt.md). One test per rule,
// written before src/guard.js existed. Each test imports the guard itself, so with no
// guard every test fails on its own instead of the whole file failing once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const VALID_PLAN = JSON.parse(readFileSync(new URL('../fixtures/plans/valid-plan.json', import.meta.url), 'utf8'));
const APP_SOURCE = readFileSync(new URL('../fixtures/app/experiment.mjs', import.meta.url), 'utf8');

const loadGuard = async () => (await import('../src/guard.js')).checkPlan;

// A fresh valid plan and context; each test changes one thing.
const plan = () => structuredClone(VALID_PLAN);
const ctx = (over = {}) => ({ appSource: APP_SOURCE, allowProduction: false, startedExperimentFlagKeys: [], ...over });

const rulesOf = (result) => [...new Set(result.violations.map((v) => v.rule))].sort();

// The plan breaks exactly this rule and nothing else.
function assertOnly(result, rule) {
  assert.equal(result.ok, false, `expected ${rule} to fail`);
  assert.deepEqual(rulesOf(result), [rule]);
  for (const v of result.violations) assert.ok(v.reason && v.reason.length > 10, `${rule} needs a readable reason`);
}

// The plan breaks this rule (other rules may also fail as a consequence).
function assertIncludes(result, rule) {
  assert.equal(result.ok, false, `expected ${rule} to fail`);
  assert.ok(rulesOf(result).includes(rule), `expected ${rule} in ${JSON.stringify(rulesOf(result))}`);
}

test('valid plan passes with no violations', async () => {
  const checkPlan = await loadGuard();
  const result = checkPlan(plan(), ctx());
  assert.deepEqual(result, { ok: true, violations: [] });
});

test('G1 the flag is multivariate', async () => {
  const checkPlan = await loadGuard();
  const p = plan();
  p.flag.type = 'standard';
  assertOnly(checkPlan(p, ctx()), 'G1');

  const missing = plan();
  delete missing.flag.type;
  assertOnly(checkPlan(missing, ctx()), 'G1');
});

test('G2 at least 2 variations, unique non-empty keys, exactly one control, "control" not reused', async () => {
  const checkPlan = await loadGuard();

  const onlyControl = plan();
  onlyControl.flag.variants = [{ key: 'control', value: 'control' }];
  onlyControl.split = { control: 100 };
  assertOnly(checkPlan(onlyControl, ctx()), 'G2');

  const emptyKey = plan();
  emptyKey.flag.variants[1].key = '  ';
  assertIncludes(checkPlan(emptyKey, ctx()), 'G2');

  const missingKey = plan();
  delete missingKey.flag.variants[1].key;
  assertIncludes(checkPlan(missingKey, ctx()), 'G2');

  const duplicate = plan();
  duplicate.flag.variants.push({ key: 'variant_b', value: 'variant_c' });
  assertIncludes(checkPlan(duplicate, ctx()), 'G2');

  const controlReused = plan();
  controlReused.flag.variants[1].key = 'control';
  assertIncludes(checkPlan(controlReused, ctx()), 'G2');

  const noControl = plan();
  noControl.flag.variants[0].key = 'variant_a';
  noControl.split = { variant_a: 50, variant_b: 50 };
  assertIncludes(checkPlan(noControl, ctx()), 'G2');
});

test('G3 split sums to 100 and every share is above 0', async () => {
  const checkPlan = await loadGuard();

  const over = plan();
  over.split = { control: 60, variant_b: 50 };
  assertOnly(checkPlan(over, ctx()), 'G3');

  const zero = plan();
  zero.split = { control: 100, variant_b: 0 };
  assertOnly(checkPlan(zero, ctx()), 'G3');

  const missingShare = plan();
  missingShare.split = { control: 100 };
  assertOnly(checkPlan(missingShare, ctx()), 'G3');

  const unknownKey = plan();
  unknownKey.split = { control: 50, variant_b: 25, variant_x: 25 };
  assertOnly(checkPlan(unknownKey, ctx()), 'G3');

  const notNumber = plan();
  notNumber.split = { control: '50', variant_b: 50 };
  assertOnly(checkPlan(notNumber, ctx()), 'G3');
});

test('G4 exactly one primary metric, fully defined, no metrics added later', async () => {
  const checkPlan = await loadGuard();

  const noDirection = plan();
  delete noDirection.metric.direction;
  assertOnly(checkPlan(noDirection, ctx()), 'G4');

  const badDirection = plan();
  badDirection.metric.direction = 'sideways';
  assertOnly(checkPlan(badDirection, ctx()), 'G4');

  const noName = plan();
  noName.metric.name = '';
  assertIncludes(checkPlan(noName, ctx()), 'G4');

  const primaryMismatch = plan();
  primaryMismatch.decisionRule.primaryMetric = 'Signups';
  assertOnly(checkPlan(primaryMismatch, ctx()), 'G4');

  const extraMetrics = plan();
  extraMetrics.metrics = [{ name: 'Scroll depth', event: 'scrolled', direction: 'up' }];
  assertOnly(checkPlan(extraMetrics, ctx()), 'G4');

  const addLater = plan();
  addLater.metric.addMetricsAfterStart = true;
  assertOnly(checkPlan(addLater, ctx()), 'G4');
});

test('G5 one stable identifier for flag and events; web_ real, sim_ scripted', async () => {
  const checkPlan = await loadGuard();

  const flagOnly = plan();
  flagOnly.identity.usedFor = ['flag'];
  assertOnly(checkPlan(flagOnly, ctx()), 'G5');

  const noSource = plan();
  noSource.identity.source = '';
  assertOnly(checkPlan(noSource, ctx()), 'G5');

  const wrongReal = plan();
  wrongReal.identity.prefixReal = 'user_';
  assertOnly(checkPlan(wrongReal, ctx()), 'G5');

  const wrongScripted = plan();
  wrongScripted.identity.prefixScripted = 'test_';
  assertOnly(checkPlan(wrongScripted, ctx()), 'G5');

  const samePrefix = plan();
  samePrefix.identity.prefixScripted = 'web_';
  assertOnly(checkPlan(samePrefix, ctx()), 'G5');

  const noTraffic = plan();
  delete noTraffic.traffic;
  assertOnly(checkPlan(noTraffic, ctx()), 'G5');
});

test('G6 a stop rule exists and is not "stop when significant"', async () => {
  const checkPlan = await loadGuard();

  const none = plan();
  delete none.stopRule;
  assertOnly(checkPlan(none, ctx()), 'G6');

  const significance = plan();
  significance.stopRule = { type: 'significance', value: 0.05 };
  assertOnly(checkPlan(significance, ctx()), 'G6');

  const zeroExposures = plan();
  zeroExposures.stopRule = { type: 'minExposuresPerVariant', value: 0 };
  assertOnly(checkPlan(zeroExposures, ctx()), 'G6');

  const badDate = plan();
  badDate.stopRule = { type: 'fixedEnd', value: 'next friday-ish' };
  assertOnly(checkPlan(badDate, ctx()), 'G6');

  const goodDate = plan();
  goodDate.stopRule = { type: 'fixedEnd', value: '2026-11-29T08:00:00+05:30' };
  assert.deepEqual(checkPlan(goodDate, ctx()), { ok: true, violations: [] });
});

test('G7 no "decide early" or peeking language anywhere in the plan', async () => {
  const checkPlan = await loadGuard();
  const phrases = [
    'We will peek at the results every morning.',
    'Stop early if variant_b is clearly ahead.',
    'Decide early once we have enough clicks.',
    'Ship the winner as soon as it is significant.',
    'End the test when significant.',
  ];
  for (const phrase of phrases) {
    const p = plan();
    p.hypothesis = `${p.hypothesis} ${phrase}`;
    const result = checkPlan(p, ctx());
    assertOnly(result, 'G7');
    assert.ok(result.violations[0].reason.includes('hypothesis'), 'reason names the field');
  }

  const nested = plan();
  nested.decisionRule.note = 'peeking allowed';
  assertOnly(checkPlan(nested, ctx()), 'G7');
});

test('G8 the metric event equals the app event constant exactly (case-sensitive)', async () => {
  const checkPlan = await loadGuard();

  const caseDiffers = plan();
  caseDiffers.metric.event = 'CTA_Clicked';
  const r1 = checkPlan(caseDiffers, ctx());
  assertOnly(r1, 'G8');
  assert.match(r1.violations[0].reason, /case/i);

  const notInApp = plan();
  notInApp.metric.event = 'signup_completed';
  assertOnly(checkPlan(notInApp, ctx()), 'G8');

  const twoConstants = ctx({ appSource: `${APP_SOURCE}\nexport const CLICK_EVENT = 'cta_clicked';\n` });
  assertOnly(checkPlan(plan(), twoConstants), 'G8');

  const noApp = ctx({ appSource: undefined });
  assertIncludes(checkPlan(plan(), noApp), 'G8');
});

test('G9 environment allowed and flag key not used by a started experiment', async () => {
  const checkPlan = await loadGuard();

  const production = plan();
  production.environment = 'Production';
  assertOnly(checkPlan(production, ctx()), 'G9');
  assert.deepEqual(checkPlan(production, ctx({ allowProduction: true })), { ok: true, violations: [] });

  const staging = plan();
  staging.environment = 'Staging';
  assertOnly(checkPlan(staging, ctx()), 'G9');

  const reused = plan();
  reused.flag.key = 'rehearsal_headline';
  assertOnly(checkPlan(reused, ctx({ startedExperimentFlagKeys: ['rehearsal_headline'] })), 'G9');
});

test('G10 the app code has a fallback default equal to the control value', async () => {
  const checkPlan = await loadGuard();

  const noFallback = ctx({ appSource: APP_SOURCE.replace(/export const FALLBACK_VALUE.*\n/, '') });
  assertOnly(checkPlan(plan(), noFallback), 'G10');

  const wrongFallback = ctx({ appSource: APP_SOURCE.replace("FALLBACK_VALUE = 'control'", "FALLBACK_VALUE = 'variant_b'") });
  assertOnly(checkPlan(plan(), wrongFallback), 'G10');

  const noApp = ctx({ appSource: undefined });
  assertIncludes(checkPlan(plan(), noApp), 'G10');
});

test('every violated rule is returned, not just the first', async () => {
  const checkPlan = await loadGuard();
  const p = plan();
  p.flag.type = 'standard';
  p.split = { control: 70, variant_b: 70 };
  p.hypothesis += ' We will peek daily.';
  p.environment = 'Production';
  assert.deepEqual(rulesOf(checkPlan(p, ctx())), ['G1', 'G3', 'G7', 'G9']);
});

test('malformed input returns violations instead of throwing', async () => {
  const checkPlan = await loadGuard();
  for (const bad of [null, undefined, 42, 'plan', [], {}]) {
    const result = checkPlan(bad, ctx());
    assert.equal(result.ok, false);
    assert.ok(result.violations.length > 0);
  }
});
