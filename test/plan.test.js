// Plan shape, canonical JSON and planSha256. Written before src/plan.js existed.
// Expected hashes were computed independently with Python's json + hashlib (sorted keys,
// separators (",", ":"), ensure_ascii=False, UTF-8), not with this code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const VALID_PLAN = JSON.parse(readFileSync(new URL('../fixtures/plans/valid-plan.json', import.meta.url), 'utf8'));
const plan = () => structuredClone(VALID_PLAN);
const load = () => import('../src/plan.js');

const VALID_PLAN_SHA256 = 'e5878e79202b61fe2405c50289e1b21394233bd7dfb5f880bb8d06bf6c171e4b';
const SMALL = { b: 1, a: { d: [3, { f: 1, e: 2 }], c: 'é' } };
const SMALL_CANONICAL = '{"a":{"c":"é","d":[3,{"e":2,"f":1}]},"b":1}';
const SMALL_SHA256 = 'd86a8d31e4d24ad48ed3f95194415526b7289c2c9486979fc6f861a9ed536707';

test('validatePlan accepts the valid fixture', async () => {
  const { validatePlan } = await load();
  assert.deepEqual(validatePlan(plan()), { ok: true, errors: [] });
});

test('validatePlan requires the added fields flag.type, metric.direction, identity.usedFor', async () => {
  const { validatePlan } = await load();
  for (const [path, drop] of [
    ['flag.type', (p) => delete p.flag.type],
    ['metric.direction', (p) => delete p.metric.direction],
    ['identity.usedFor', (p) => delete p.identity.usedFor],
  ]) {
    const p = plan();
    drop(p);
    const result = validatePlan(p);
    assert.equal(result.ok, false, `${path} missing should fail`);
    assert.ok(result.errors.some((e) => e.includes(path)), `an error names ${path}: ${JSON.stringify(result.errors)}`);
  }
});

test('validatePlan requires every top-level field of the schema', async () => {
  const { validatePlan } = await load();
  for (const field of ['id', 'sentence', 'hypothesis', 'environment', 'flag', 'metric', 'split', 'identity', 'stopRule', 'decisionRule', 'traffic']) {
    const p = plan();
    delete p[field];
    const result = validatePlan(p);
    assert.equal(result.ok, false, `${field} missing should fail`);
    assert.ok(result.errors.some((e) => e.includes(field)), `an error names ${field}`);
  }
});

test('validatePlan rejects an id that is unsafe as a file name', async () => {
  const { validatePlan } = await load();
  for (const id of ['../escape', 'Has Space', 'UPPER', '', 'a/b', 'a\\b', '.hidden', 'x'.repeat(65)]) {
    const p = plan();
    p.id = id;
    assert.equal(validatePlan(p).ok, false, `id ${JSON.stringify(id)} should fail`);
  }
});

test('validatePlan rejects unknown top-level fields and wrong types', async () => {
  const { validatePlan } = await load();
  const extra = plan();
  extra.notes = 'anything';
  assert.equal(validatePlan(extra).ok, false);

  const numberValue = plan();
  numberValue.flag.variants[1].value = 2;
  assert.equal(validatePlan(numberValue).ok, false, 'variation values are strings');

  const badProbability = plan();
  badProbability.decisionRule.winProbabilityAtLeast = 1.5;
  assert.equal(validatePlan(badProbability).ok, false);

  const intervalOff = plan();
  intervalOff.decisionRule.intervalExcludesZero = false;
  assert.equal(validatePlan(intervalOff).ok, false, 'intervalExcludesZero must be true');

  for (const bad of [null, [], 'plan', 7]) assert.equal(validatePlan(bad).ok, false);
});

test('canonicalJson sorts keys recursively, keeps array order, no whitespace', async () => {
  const { canonicalJson } = await load();
  assert.equal(canonicalJson(SMALL), SMALL_CANONICAL);
  assert.equal(canonicalJson([{ b: 2, a: 1 }, 'x']), '[{"a":1,"b":2},"x"]');
});

test('canonicalJson ignores input key order and formatting', async () => {
  const { canonicalJson } = await load();
  const reverseKeys = (v) => {
    if (Array.isArray(v)) return v.map(reverseKeys);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys(v[k])]));
    return v;
  };
  const reordered = reverseKeys(plan());
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(plan()), 'the test really reorders keys');
  assert.equal(canonicalJson(reordered), canonicalJson(plan()));
  const reformatted = JSON.parse(`  ${JSON.stringify(plan(), null, 7)}\n`);
  assert.equal(canonicalJson(reformatted), canonicalJson(plan()));
});

test('canonicalJson refuses values JSON cannot represent exactly', async () => {
  const { canonicalJson } = await load();
  for (const bad of [{ a: NaN }, { a: Infinity }, { a: undefined }, { a: () => 1 }, { a: 1n }, undefined]) {
    assert.throws(() => canonicalJson(bad), TypeError);
  }
});

test('sha256Hex matches an independent Python computation (UTF-8)', async () => {
  const { sha256Hex, canonicalJson } = await load();
  assert.equal(sha256Hex(canonicalJson(SMALL)), SMALL_SHA256);
});

test('planSha256 of the valid fixture matches the Python value', async () => {
  const { planSha256 } = await load();
  assert.equal(planSha256(plan()), VALID_PLAN_SHA256);
});

test('planSha256 changes when any value changes', async () => {
  const { planSha256 } = await load();
  const base = planSha256(plan());
  const edits = [
    (p) => { p.split.control = 51; p.split.variant_b = 49; },
    (p) => { p.metric.event = 'cta_clicked2'; },
    (p) => { p.hypothesis += ' '; },
    (p) => { p.flag.variants.reverse(); },
  ];
  for (const edit of edits) {
    const p = plan();
    edit(p);
    assert.notEqual(planSha256(p), base);
  }
});
