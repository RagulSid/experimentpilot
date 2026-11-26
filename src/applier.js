// Applier: plain code. Order is fixed and cannot be skipped:
//   plan shape -> guard (G1-G10, re-run here) -> verifyApproval -> dry run, or apply.
// It applies only when called with apply === true (the CLI's --apply flag).
// It never modifies or deletes anything that exists: if the flag or the experiment is
// already there it refuses, and if a call fails midway it stops and lists what it created.
import { validatePlan, planSha256 } from './plan.js';
import { checkPlan } from './guard.js';
import { verifyApproval } from './approval.js';
import { buildDiff, diffSha256, formatDiff } from './diff.js';
import { ROUTES } from './flagsmith-client.js';

const CONTROL_KEY = 'control';
const ROUTES_USED = ['listFeatures', 'listExperiments', 'createFeature', 'createMetric', 'createExperiment', 'startExperiment', 'getExperiment'];
const EXPECTED_DIRECTION = { up: 'increase', down: 'decrease' };

// Request bodies. Metric and experiment follow the recorded requests (calls 19 and 21).
// The feature body is GUESSED: field names are taken from the recorded feature object (call 23),
// and default_enabled mirrors the CLI's --enabled used in the rehearsal (call 15).
export function featureBody(plan) {
  const control = plan.flag.variants.find((v) => v.key === CONTROL_KEY);
  return {
    name: plan.flag.key,
    type: 'MULTIVARIATE',
    initial_value: control.value,
    default_enabled: true,
    multivariate_options: plan.flag.variants
      .filter((v) => v.key !== CONTROL_KEY)
      .map((v) => ({ type: 'unicode', string_value: v.value, default_percentage_allocation: 0, key: v.key })),
  };
}

export function metricBody(plan) {
  return { name: plan.metric.name, aggregation: 'occurrence', direction: plan.metric.direction, definition: { version: 1, event: plan.metric.event } };
}

export function experimentBody(plan, { flagId, metricId, optionIds }) {
  const control = plan.flag.variants.find((v) => v.key === CONTROL_KEY);
  return {
    feature: flagId,
    name: plan.id,
    hypothesis: plan.hypothesis,
    metrics: [{ metric: metricId, expected_direction: EXPECTED_DIRECTION[plan.metric.direction] }],
    experiment_rollout: {
      enabled: true,
      rollout_percentage: 100,
      feature_state_value: { type: 'string', value: control.value },
      multivariate_feature_state_values: plan.flag.variants
        .filter((v) => v.key !== CONTROL_KEY)
        .map((v) => ({ multivariate_feature_option: optionIds[v.key], percentage_allocation: plan.split[v.key] })),
    },
  };
}

class StopApply extends Error {}

export async function applyPlan({
  plan,
  approvalText,
  appSource,
  apply = false,
  client,
  allowProduction = false,
  startedExperimentFlagKeys = [],
  log = () => {},
}) {
  const refused = (stage, reasons) => {
    for (const r of reasons) log(`REFUSED (${stage}): ${r}`);
    return { status: 'refused', stage, reasons };
  };

  // 1. Shape.
  const shape = validatePlan(plan);
  if (!shape.ok) return refused('plan', shape.errors);

  // 2. Guard, always run here, whatever the caller did before.
  const guard = checkPlan(plan, { appSource, allowProduction, startedExperimentFlagKeys });
  if (!guard.ok) return refused('guard', guard.violations.map((v) => `${v.rule} ${v.reason}`));

  // 3. Approval for this exact plan and diff.
  const approval = verifyApproval(plan, approvalText);
  if (!approval.ok) return refused('approval', [approval.reason]);

  const diff = buildDiff(plan);
  const hashes = { planSha256: planSha256(plan), diffSha256: diffSha256(diff) };

  // 4a. Dry run unless apply is exactly true.
  if (apply !== true) {
    log(formatDiff(diff, hashes));
    log('');
    log('DRY RUN: nothing was sent to Flagsmith. Re-run with --apply to make these changes.');
    return { status: 'dry_run', diff, ...hashes };
  }

  // 4b. Apply.
  if (!client) return refused('config', ['no Flagsmith client configured']);
  if (!client.isLoopback) {
    const unverified = ROUTES_USED.filter((name) => ROUTES[name].source !== 'recorded');
    if (unverified.length) {
      return refused('unverified', [`these Flagsmith routes have not been verified against the real API yet: ${unverified.join(', ')}. Record them first (notes/flagsmith-calls.md); nothing was sent.`]);
    }
    if (plan.metric.direction !== 'up') {
      return refused('unverified', [`metric direction ${JSON.stringify(plan.metric.direction)} has not been verified against the real API (only "up" was recorded); nothing was sent.`]);
    }
  }

  const features = await client.listFeatures(plan.flag.key);
  if (features.some((f) => f.name === plan.flag.key)) {
    return refused('exists', [`flag ${JSON.stringify(plan.flag.key)} already exists; ExperimentPilot never modifies an existing flag. Use a new flag key.`]);
  }
  const experiments = await client.listExperiments();
  if (experiments.some((e) => e.name === plan.id)) {
    return refused('exists', [`experiment ${JSON.stringify(plan.id)} already exists; ExperimentPilot never modifies an existing experiment.`]);
  }

  const created = [];
  try {
    log(`APPLY 1/4 create flag ${plan.flag.key}`);
    const feature = await client.createFeature(featureBody(plan));
    created.push({ what: 'flag', id: feature.id, name: feature.name });
    const optionIds = Object.fromEntries((feature.multivariate_options ?? []).filter((o) => o.key).map((o) => [o.key, o.id]));
    const missing = plan.flag.variants.filter((v) => v.key !== CONTROL_KEY && !(v.key in optionIds)).map((v) => v.key);
    if (missing.length) throw new StopApply(`flag created, but variation(s) ${missing.join(', ')} came back without their key; they would record no exposures`);

    log(`APPLY 2/4 create metric ${JSON.stringify(plan.metric.name)} (event ${JSON.stringify(plan.metric.event)})`);
    const metric = await client.createMetric(metricBody(plan));
    created.push({ what: 'metric', id: metric.id, name: metric.name });
    if (metric.definition?.event !== plan.metric.event) {
      throw new StopApply(`metric created with event ${JSON.stringify(metric.definition?.event)}, expected ${JSON.stringify(plan.metric.event)}`);
    }

    log(`APPLY 3/4 create experiment ${plan.id}`);
    const experiment = await client.createExperiment(experimentBody(plan, { flagId: feature.id, metricId: metric.id, optionIds }));
    created.push({ what: 'experiment', id: experiment.id, name: experiment.name });
    if (experiment.status !== 'created') throw new StopApply(`experiment ${experiment.id} has status ${JSON.stringify(experiment.status)}, expected "created"`);

    log(`APPLY 4/4 start experiment ${experiment.id}`);
    await client.startExperiment(experiment.id);
    const check = await client.getExperiment(experiment.id);
    if (check.status !== 'running') throw new StopApply(`experiment ${experiment.id} has status ${JSON.stringify(check.status)} after start, expected "running"`);

    log(`DONE: experiment ${experiment.id} is running.`);
    return { status: 'applied', created, experimentId: experiment.id, experimentStatus: check.status, ...hashes };
  } catch (err) {
    const reason = client.redact ? client.redact(err.message) : err.message;
    const note = `Stopped. Nothing was rolled back or deleted. Created so far: ${created.length ? created.map((c) => `${c.what} ${c.id} (${c.name})`).join(', ') : 'nothing'}. A person decides what to clean up.`;
    log(`FAILED: ${reason}`);
    log(note);
    return { status: 'failed', stage: 'apply', reasons: [reason], created, note };
  }
}
