// Readout: not_ready (stop rule unmet), no_clear_winner, winner_candidate. Never names a winner
// early. Written before src/readout.js existed. The hand-calculated example uses the real
// results recorded on Nov 25 (scripted traffic): control 15/150, variant_b 22/150.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startFakeFlagsmith } from './helpers/fake-flagsmith.js';
import { createClient } from '../src/flagsmith-client.js';

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const RESULTS = read('fixtures/flagsmith/recorded/results-get.response.json');
const PLAN = read('fixtures/plans/valid-plan.json');
const plan = (over = {}) => ({ ...structuredClone(PLAN), ...over });
const results = () => structuredClone(RESULTS);
const inference = (r) => r.results.payload.metrics[0].inference.variant_b;
const load = () => import('../src/readout.js');

test('hand-calculated example: rates, lift and exposures from the recorded results', async () => {
  const { readout } = await load();
  const r = readout({ plan: plan(), results: results(), metricId: 422 });
  // By hand: control 15/150 = 0.1; variant_b 22/150 = 0.146666...; lift = 0.146666/0.1 - 1 = 7/15.
  assert.deepEqual(r.exposures, { control: 150, variant_b: 150 });
  assert.equal(r.variants.control.rate, 15 / 150);
  assert.equal(r.variants.variant_b.rate, 22 / 150);
  assert.ok(Math.abs(r.variants.variant_b.computedLift - 7 / 15) < 1e-12);
  assert.ok(Math.abs(r.variants.variant_b.lift - 7 / 15) < 1e-12, 'Flagsmith lift equals the hand calculation');
  assert.equal(r.variants.variant_b.chanceToWin, 0.8435014668423455);
  assert.deepEqual(r.variants.variant_b.interval, [-0.43986679278762425, 1.3732001261209574]);
});

test('stop rule met, interval includes zero: no_clear_winner, and it says why', async () => {
  const { readout } = await load();
  const r = readout({ plan: plan(), results: results(), metricId: 422 });
  assert.equal(r.decision, 'no_clear_winner');
  assert.equal(r.winner, undefined);
  assert.ok(r.reasons.some((x) => /interval .*includes zero/.test(x)), JSON.stringify(r.reasons));
  assert.ok(r.reasons.some((x) => /84\.4%.*below 95%/.test(x)), JSON.stringify(r.reasons));
});

test('stop rule unmet: not_ready, never names a winner, even with a decisive-looking result', async () => {
  const { readout } = await load();
  const strong = results();
  Object.assign(inference(strong), { ci_low: 0.2, ci_high: 0.9, chance_to_win: 0.999 });
  const r = readout({ plan: plan({ stopRule: { type: 'minExposuresPerVariant', value: 200 } }), results: strong, metricId: 422 });
  assert.equal(r.decision, 'not_ready');
  assert.equal(r.winner, undefined);
  assert.equal(r.variants, undefined, 'no per-variant numbers to act on before the stop rule');
  assert.match(r.reasons[0], /control 150 of 200.*variant_b 150 of 200/);
});

test('fixed end in the future: not_ready; after it: decided', async () => {
  const { readout } = await load();
  const p = plan({ stopRule: { type: 'fixedEnd', value: '2026-11-29T08:00:00+05:30' } });
  const before = readout({ plan: p, results: results(), metricId: 422, now: new Date('2026-11-28T00:00:00Z') });
  assert.equal(before.decision, 'not_ready');
  assert.match(before.reasons[0], /2026-11-29T08:00:00\+05:30/);
  const after = readout({ plan: p, results: results(), metricId: 422, now: new Date('2026-11-29T03:00:00Z') });
  assert.equal(after.decision, 'no_clear_winner');
});

test('interval above zero and chance to win at the threshold: winner_candidate', async () => {
  const { readout } = await load();
  const r0 = results();
  Object.assign(inference(r0), { ci_low: 0.05, ci_high: 0.9, chance_to_win: 0.95 });
  const r = readout({ plan: plan(), results: r0, metricId: 422 });
  assert.equal(r.decision, 'winner_candidate');
  assert.equal(r.winner, 'variant_b');
});

test('interval excludes zero but chance below threshold: no_clear_winner', async () => {
  const { readout } = await load();
  const r0 = results();
  Object.assign(inference(r0), { ci_low: 0.01, ci_high: 0.9, chance_to_win: 0.9 });
  assert.equal(readout({ plan: plan(), results: r0, metricId: 422 }).decision, 'no_clear_winner');
});

test('a decisive result in the wrong direction is not a winner', async () => {
  const { readout } = await load();
  const r0 = results();
  Object.assign(inference(r0), { lift: -0.3, ci_low: -0.6, ci_high: -0.05, chance_to_win: 0.99 });
  const r = readout({ plan: plan(), results: r0, metricId: 422 });
  assert.equal(r.decision, 'no_clear_winner');
  assert.ok(r.reasons.some((x) => /wrong direction|below zero/.test(x)), JSON.stringify(r.reasons));
});

test('sample ratio mismatch: no winner, and the readout says not to act on the numbers', async () => {
  const { readout } = await load();
  const r0 = results();
  r0.results.payload.srm_p_value = 0.001;
  Object.assign(inference(r0), { ci_low: 0.05, ci_high: 0.9, chance_to_win: 0.99 });
  const r = readout({ plan: plan(), results: r0, metricId: 422 });
  assert.equal(r.decision, 'no_clear_winner');
  assert.ok(r.reasons.some((x) => /sample ratio mismatch/i.test(x)));
});

test('no results yet, or the metric missing: not_ready', async () => {
  const { readout } = await load();
  for (const body of [null, { results: null }, { results: { payload: null } }]) {
    assert.equal(readout({ plan: plan(), results: body, metricId: 422 }).decision, 'not_ready');
  }
  assert.equal(readout({ plan: plan(), results: results(), metricId: 999 }).decision, 'not_ready');
});

test('the readout always labels scripted traffic: Flagsmith results do not separate sim_ from web_', async () => {
  const { readout } = await load();
  const r = readout({ plan: plan(), results: results(), metricId: 422 });
  assert.deepEqual(r.traffic, { real: true, scripted: true });
  assert.match(r.trafficNote, /scripted.*sim_/);
});

test('formatReadout fits one screen and states decision, reasons and the traffic note', async () => {
  const { readout, formatReadout } = await load();
  const text = formatReadout(readout({ plan: plan(), results: results(), metricId: 422 }));
  assert.match(text, /^Decision: no_clear_winner/m);
  assert.match(text, /variant_b .*22\/150/);
  assert.match(text, /scripted/);
  assert.ok(text.split('\n').length <= 20);
});

// --- against the fake Flagsmith -------------------------------------------------------

test('fetchAndRead: finds the experiment by name, reads its metric and results (no refresh)', async () => {
  const { fetchAndRead } = await load();
  const TOKEN = 'test-token-0123456789abcdef';
  const ENV = 'FakeEnvKey000000000001';
  const fake = await startFakeFlagsmith({
    token: TOKEN, environmentKey: ENV, projectId: 55988,
    existingExperiments: [{ id: 457, name: 'pilot_rehearsal_1', status: 'running', feature: { id: 303389, name: 'pilot_rehearsal_1' } }],
  });
  try {
    const client = createClient({ baseUrl: fake.baseUrl, env: { FLAGSMITH_ADMIN_TOKEN: TOKEN }, projectId: 55988, environmentKey: ENV });
    const r = await fetchAndRead({ plan: plan(), client, refresh: false });
    assert.equal(r.experimentId, 457);
    assert.equal(r.readout.decision, 'no_clear_winner');
    assert.deepEqual(fake.requests.map((q) => q.route), ['GET experiments (list)', 'GET experiment', 'GET results']);
  } finally { await fake.close(); }
});

test('recorded Development run after START (calls 41-48, scripted sim_ only): no_clear_winner', async () => {
  // Real Flagsmith results for experiment 579, 2026-11-26 16:14 IST, after 400 sim_ visitors with
  // made-up rates. By hand: control 34/217, variant_b 29/183; stop rule (150 per variant) is met.
  const { readout } = await load();
  const rehearsal = read('plans/pilot_rehearsal_1.json');
  const body = read('fixtures/flagsmith/recorded/2026-11-26-start-results/07-getResults.json').response;
  const r = readout({ plan: rehearsal, results: body, metricId: 577, now: new Date('2026-11-26T10:45:00Z') });
  assert.deepEqual(r.exposures, { control: 217, variant_b: 183 });
  assert.equal(r.variants.control.rate, 34 / 217);
  assert.equal(r.variants.variant_b.rate, 29 / 183);
  assert.equal(r.decision, 'no_clear_winner');
  assert.equal(r.winner, undefined);
  const [low, high] = r.variants.variant_b.interval;
  assert.ok(low < 0 && high > 0, 'the interval includes zero');
  assert.ok(r.variants.variant_b.chanceToWin < 0.95);
  assert.match(r.trafficNote, /sim_/);
});
