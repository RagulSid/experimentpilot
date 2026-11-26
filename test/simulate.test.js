// Scripted (sim_) traffic helpers. Written before src/simulate.js existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = () => import('../src/simulate.js');

test('sim ids: sim_<run tag>_NNNN, unique, never web_', async () => {
  const { simIds } = await load();
  const ids = simIds(3, 'abc');
  assert.deepEqual(ids, ['sim_abc_0001', 'sim_abc_0002', 'sim_abc_0003']);
  assert.equal(new Set(simIds(500, 't')).size, 500);
  assert.ok(simIds(10, 't').every((id) => id.startsWith('sim_') && !id.startsWith('web_')));
  assert.throws(() => simIds(0, 't'), /count/);
  assert.throws(() => simIds(5, 'bad tag'), /tag/);
});

test('target check: only the Development key that flagsmith.json is bound to', async () => {
  const { checkSimTarget } = await load();
  const ok = { FLAGSMITH_ENVIRONMENT_NAME: 'Development', FLAGSMITH_ENVIRONMENT_KEY: 'devkey' };
  assert.doesNotThrow(() => checkSimTarget(ok, 'devkey'));
  assert.throws(() => checkSimTarget({ ...ok, FLAGSMITH_ENVIRONMENT_NAME: 'Production' }, 'devkey'), /Development/);
  assert.throws(() => checkSimTarget(ok, 'otherkey'), /bound/);
  assert.throws(() => checkSimTarget({ FLAGSMITH_ENVIRONMENT_NAME: 'Development' }, undefined), /bound/);
});

test('conversion decision uses the made-up rate for the variant and an injected random number', async () => {
  const { converts, MADE_UP_RATES } = await load();
  assert.deepEqual(MADE_UP_RATES, { control: 0.10, variant_b: 0.14 });
  assert.equal(converts('variant_b', () => 0.139), true);
  assert.equal(converts('variant_b', () => 0.14), false);
  assert.equal(converts('control', () => 0.05), true);
  assert.equal(converts('unknown', () => 0), false);
});

test('the simulator takes the event name and flag key from the page (one constant each)', () => {
  const runner = readFileSync(new URL('../scripts/simulate.mjs', import.meta.url), 'utf8');
  assert.ok(!runner.includes("'cta_clicked'") && !runner.includes('"cta_clicked"'), 'no second copy of the event name');
  assert.match(runner, /CTA_EVENT/);
  assert.match(runner, /FLAG_KEY/);
});
