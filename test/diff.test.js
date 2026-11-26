// buildDiff / diffSha256 / formatDiff. Written before src/diff.js existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const VALID_PLAN = JSON.parse(readFileSync(new URL('../fixtures/plans/valid-plan.json', import.meta.url), 'utf8'));
const plan = () => structuredClone(VALID_PLAN);
const load = () => import('../src/diff.js');

const EXPECTED_DIFF = [
  {
    step: 1,
    action: 'create_flag',
    scope: 'project (the flag appears in every environment)',
    flag: {
      key: 'pilot_rehearsal_1',
      type: 'multivariate',
      control: { key: 'control', value: 'control' },
      variations: [{ key: 'variant_b', value: 'variant_b' }],
    },
  },
  {
    step: 2,
    action: 'create_metric',
    scope: 'environment Development',
    metric: { name: 'Get started clicks', event: 'cta_clicked', aggregation: 'occurrence', direction: 'up' },
  },
  {
    step: 3,
    action: 'create_experiment',
    scope: 'environment Development',
    experiment: {
      name: 'pilot_rehearsal_1',
      hypothesis: VALID_PLAN.hypothesis,
      flag: 'pilot_rehearsal_1',
      primaryMetric: 'Get started clicks',
      expectedDirection: 'increase',
      rolloutPercentage: 100,
      split: [{ key: 'control', percentage: 50 }, { key: 'variant_b', percentage: 50 }],
      statusAfter: 'created',
    },
  },
  {
    step: 4,
    action: 'start_experiment',
    scope: 'environment Development',
    experiment: 'pilot_rehearsal_1',
    effect: 'locks the flag and turns on the rollout',
  },
];

test('buildDiff returns the four changes in order: flag, metric, experiment, start', async () => {
  const { buildDiff } = await load();
  assert.deepEqual(buildDiff(plan()), EXPECTED_DIFF);
});

test('buildDiff is deterministic: key order of the plan does not matter', async () => {
  const { buildDiff, diffSha256 } = await load();
  const reverseKeys = (v) => {
    if (Array.isArray(v)) return v.map(reverseKeys);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys(v[k])]));
    return v;
  };
  assert.deepEqual(buildDiff(reverseKeys(plan())), buildDiff(plan()));
  assert.equal(diffSha256(buildDiff(reverseKeys(plan()))), diffSha256(buildDiff(plan())));
});

test('diffSha256 is sha256 of the canonical JSON of the diff', async () => {
  const { buildDiff, diffSha256 } = await load();
  const { canonicalJson, sha256Hex } = await import('../src/plan.js');
  const diff = buildDiff(plan());
  assert.equal(diffSha256(diff), sha256Hex(canonicalJson(diff)));
  assert.match(diffSha256(diff), /^[0-9a-f]{64}$/);
});

test('diffSha256 changes when what Flagsmith would receive changes', async () => {
  const { buildDiff, diffSha256 } = await load();
  const base = diffSha256(buildDiff(plan()));
  const p = plan();
  p.split = { control: 40, variant_b: 60 };
  assert.notEqual(diffSha256(buildDiff(p)), base);
  const q = plan();
  q.metric.event = 'cta_clicked_v2';
  assert.notEqual(diffSha256(buildDiff(q)), base);
});

test('buildDiff maps metric direction down to expected direction decrease', async () => {
  const { buildDiff } = await load();
  const p = plan();
  p.metric.direction = 'down';
  const diff = buildDiff(p);
  assert.equal(diff[1].metric.direction, 'down');
  assert.equal(diff[2].experiment.expectedDirection, 'decrease');
});

test('buildDiff refuses a plan with the wrong shape', async () => {
  const { buildDiff } = await load();
  const p = plan();
  delete p.flag;
  assert.throws(() => buildDiff(p), /plan/i);
});

test('formatDiff shows every step, the project-wide warning and both hashes', async () => {
  const { buildDiff, formatDiff } = await load();
  const diff = buildDiff(plan());
  const text = formatDiff(diff, { planSha256: 'a'.repeat(64), diffSha256: 'b'.repeat(64) });
  for (const needle of [
    'CREATE flag pilot_rehearsal_1 (multivariate)',
    'every environment',
    'control', 'variant_b',
    'CREATE metric "Get started clicks"', 'cta_clicked',
    'CREATE experiment pilot_rehearsal_1', 'control 50% / variant_b 50%',
    'START experiment pilot_rehearsal_1', 'locks the flag',
    `plan sha256: ${'a'.repeat(64)}`, `diff sha256: ${'b'.repeat(64)}`,
  ]) assert.ok(text.includes(needle), `diff text includes ${JSON.stringify(needle)}\n${text}`);
});
