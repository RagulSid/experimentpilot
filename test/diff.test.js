// buildDiff / diffSha256 / formatDiff, per phase (create, start).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const VALID_PLAN = JSON.parse(readFileSync(new URL('../fixtures/plans/valid-plan.json', import.meta.url), 'utf8'));
const plan = () => structuredClone(VALID_PLAN);
const load = () => import('../src/diff.js');

const EXPECTED_CREATE = [
  {
    phase: 'create',
    step: 1,
    action: 'create_flag',
    scope: 'project: the flag appears in every environment, Production included, enabled with the control value',
    flag: {
      key: 'pilot_rehearsal_1',
      type: 'multivariate',
      enabledByDefault: true,
      control: { key: 'control', value: 'control' },
      variations: [{ key: 'variant_b', value: 'variant_b' }],
    },
  },
  {
    phase: 'create',
    step: 2,
    action: 'create_metric',
    scope: 'environment Development',
    metric: { name: 'Get started clicks', event: 'cta_clicked', aggregation: 'occurrence', direction: 'up' },
  },
  {
    phase: 'create',
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
];

const EXPECTED_START = [
  {
    phase: 'start',
    step: 1,
    action: 'start_experiment',
    scope: 'environment Development',
    experiment: 'pilot_rehearsal_1',
    flag: 'pilot_rehearsal_1',
    requires: 'the experiment exists with status created, and the app using this flag and event is deployed',
    effect: 'locks the flag and turns on the rollout',
  },
];

test('CREATE diff: flag, metric, experiment, in that order, and no start', async () => {
  const { buildDiff } = await load();
  assert.deepEqual(buildDiff(plan(), 'create'), EXPECTED_CREATE);
});

test('START diff: only the start of the named experiment', async () => {
  const { buildDiff } = await load();
  assert.deepEqual(buildDiff(plan(), 'start'), EXPECTED_START);
});

test('buildDiff requires a known phase', async () => {
  const { buildDiff } = await load();
  for (const phase of [undefined, '', 'CREATE', 'all', 'apply']) assert.throws(() => buildDiff(plan(), phase), /phase/);
});

test('the two phases have different diff hashes', async () => {
  const { buildDiff, diffSha256 } = await load();
  assert.notEqual(diffSha256(buildDiff(plan(), 'create')), diffSha256(buildDiff(plan(), 'start')));
});

test('buildDiff is deterministic: key order of the plan does not matter', async () => {
  const { buildDiff, diffSha256 } = await load();
  const reverseKeys = (v) => {
    if (Array.isArray(v)) return v.map(reverseKeys);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys(v[k])]));
    return v;
  };
  for (const phase of ['create', 'start']) {
    assert.deepEqual(buildDiff(reverseKeys(plan()), phase), buildDiff(plan(), phase));
    assert.equal(diffSha256(buildDiff(reverseKeys(plan()), phase)), diffSha256(buildDiff(plan(), phase)));
  }
});

test('diffSha256 is sha256 of the canonical JSON of the diff', async () => {
  const { buildDiff, diffSha256 } = await load();
  const { canonicalJson, sha256Hex } = await import('../src/plan.js');
  const diff = buildDiff(plan(), 'create');
  assert.equal(diffSha256(diff), sha256Hex(canonicalJson(diff)));
  assert.match(diffSha256(diff), /^[0-9a-f]{64}$/);
});

test('diffSha256 changes when what Flagsmith would receive changes', async () => {
  const { buildDiff, diffSha256 } = await load();
  const base = diffSha256(buildDiff(plan(), 'create'));
  const p = plan();
  p.split = { control: 40, variant_b: 60 };
  assert.notEqual(diffSha256(buildDiff(p, 'create')), base);
  const q = plan();
  q.metric.event = 'cta_clicked_v2';
  assert.notEqual(diffSha256(buildDiff(q, 'create')), base);
});

test('buildDiff maps metric direction down to expected direction decrease', async () => {
  const { buildDiff } = await load();
  const p = plan();
  p.metric.direction = 'down';
  const diff = buildDiff(p, 'create');
  assert.equal(diff[1].metric.direction, 'down');
  assert.equal(diff[2].experiment.expectedDirection, 'decrease');
});

test('buildDiff refuses a plan with the wrong shape', async () => {
  const { buildDiff } = await load();
  const p = plan();
  delete p.flag;
  assert.throws(() => buildDiff(p, 'create'), /plan/i);
});

test('formatDiff (create) shows each step, Production warning, no START, and both hashes', async () => {
  const { buildDiff, formatDiff } = await load();
  const text = formatDiff(buildDiff(plan(), 'create'), { planSha256: 'a'.repeat(64), diffSha256: 'b'.repeat(64) });
  for (const needle of [
    'Phase CREATE', 'CREATE flag pilot_rehearsal_1 (multivariate), enabled',
    'Production included', 'variant_b',
    'CREATE metric "Get started clicks"', 'cta_clicked',
    'CREATE experiment pilot_rehearsal_1', 'control 50% / variant_b 50%', 'status created',
    'not started', `plan sha256: ${'a'.repeat(64)}`, `diff sha256: ${'b'.repeat(64)}`,
  ]) assert.ok(text.includes(needle), `create text includes ${JSON.stringify(needle)}\n${text}`);
  assert.ok(!text.includes('START experiment'), 'the CREATE diff never starts anything');
});

test('formatDiff (start) shows the start and what it requires', async () => {
  const { buildDiff, formatDiff } = await load();
  const text = formatDiff(buildDiff(plan(), 'start'), { planSha256: 'a'.repeat(64), diffSha256: 'c'.repeat(64) });
  for (const needle of ['Phase START', 'START experiment pilot_rehearsal_1', 'deployed', 'locks the flag']) {
    assert.ok(text.includes(needle), `start text includes ${JSON.stringify(needle)}\n${text}`);
  }
});
