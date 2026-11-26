// Applier: plain code. Order is fixed and cannot be skipped:
//   phase -> plan shape -> guard (G1-G10, re-run here) -> approval for this phase -> dry run, or apply.
// Two phases, each with its own approval:
//   create: flag (enabled), its keyed variations, the metric, the experiment (status created). Never starts.
//   start:  starts that experiment, once a person has approved START (after deploying the app).
// Before any write it confirms the environment's name through the API and refuses on mismatch.
// It never modifies or deletes anything that exists, and stops at the first error, listing
// what it created.
import { validatePlan, planSha256 } from './plan.js';
import { checkPlan } from './guard.js';
import { verifyApproval } from './approval.js';
import { PHASES, buildDiff, diffSha256, formatDiff } from './diff.js';
import { ROUTES } from './flagsmith-client.js';

const CONTROL_KEY = 'control';
const EXPECTED_DIRECTION = { up: 'increase', down: 'decrease' };
const ROUTES_USED = {
  create: ['getEnvironment', 'listFeatures', 'listExperiments', 'listMetrics', 'createFeature', 'createVariation', 'createMetric', 'createExperiment'],
  start: ['getEnvironment', 'listExperiments', 'startExperiment', 'getExperiment'],
};
const VERIFIED_SOURCES = ['recorded', 'swagger'];

// Request bodies. Metric and experiment follow the recorded requests (calls 19 and 21).
// Feature and variation follow the OpenAPI spec (create_feature, create_feature_multivariate_option):
// the option key is read-only when nested in a feature, so each variation is created on its own.
export function featureBody(plan) {
  const control = plan.flag.variants.find((v) => v.key === CONTROL_KEY);
  return { name: plan.flag.key, type: 'MULTIVARIATE', initial_value: control.value, default_enabled: true };
}

export function variationBody(variant, flagId) {
  return { type: 'unicode', string_value: variant.value, default_percentage_allocation: 0, key: variant.key, feature: flagId };
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
  phase,
  approvalText,
  createApprovalText,
  appSource,
  apply = false,
  client,
  allowProduction = false,
  startedExperimentFlagKeys = [],
  log = () => {},
  routes = ROUTES,
}) {
  const refused = (stage, reasons) => {
    for (const r of reasons) log(`REFUSED (${stage}): ${r}`);
    return { status: 'refused', stage, phase, reasons };
  };

  // 0. Phase.
  if (!PHASES.includes(phase)) return refused('phase', [`phase must be "create" or "start", got ${JSON.stringify(phase)}`]);

  // 1. Shape.
  const shape = validatePlan(plan);
  if (!shape.ok) return refused('plan', shape.errors);

  // 2. Guard, always run here, whatever the caller did before.
  const guard = checkPlan(plan, { appSource, allowProduction, startedExperimentFlagKeys });
  if (!guard.ok) return refused('guard', guard.violations.map((v) => `${v.rule} ${v.reason}`));

  // 3. Approval for this exact plan, phase and diff. START also needs the CREATE approval.
  const approval = verifyApproval(plan, approvalText, phase);
  if (!approval.ok) return refused('approval', [approval.reason]);
  if (phase === 'start') {
    const create = verifyApproval(plan, createApprovalText, 'create');
    if (!create.ok) return refused('approval', [`START needs the create approval too: ${create.reason}`]);
  }

  const diff = buildDiff(plan, phase);
  const hashes = { planSha256: planSha256(plan), diffSha256: diffSha256(diff) };

  // 4a. Dry run unless apply is exactly true.
  if (apply !== true) {
    log(formatDiff(diff, hashes));
    log('');
    log(`DRY RUN: nothing was sent to Flagsmith. Re-run with --apply to make these ${phase.toUpperCase()} changes.`);
    return { status: 'dry_run', phase, diff, ...hashes };
  }

  // 4b. Apply.
  if (!client) return refused('config', ['no Flagsmith client configured']);
  if (!client.isLoopback) {
    const unverified = ROUTES_USED[phase].filter((name) => !VERIFIED_SOURCES.includes(routes[name]?.source));
    if (unverified.length) {
      return refused('unverified', [`these Flagsmith routes are neither recorded nor in the OpenAPI spec: ${unverified.join(', ')}. Nothing was sent.`]);
    }
    if (plan.metric.direction !== 'up') {
      return refused('unverified', [`metric direction ${JSON.stringify(plan.metric.direction)} has not been verified against the real API (only "up" was recorded); nothing was sent.`]);
    }
  }

  const environment = await client.getEnvironment();
  if (environment?.name !== plan.environment) {
    return refused('environment', [`the configured environment is named ${JSON.stringify(environment?.name)}, but the plan says ${JSON.stringify(plan.environment)}; nothing was changed.`]);
  }

  return phase === 'create'
    ? applyCreate({ plan, client, log, refused, hashes })
    : applyStart({ plan, client, log, refused, hashes });
}

async function applyCreate({ plan, client, log, refused, hashes }) {
  const features = await client.listFeatures(plan.flag.key);
  if (features.some((f) => f.name === plan.flag.key)) {
    return refused('exists', [`flag ${JSON.stringify(plan.flag.key)} already exists; ExperimentPilot never modifies an existing flag. Use a new flag key.`]);
  }
  const experiments = await client.listExperiments(plan.id);
  if (experiments.some((e) => e.name === plan.id)) {
    return refused('exists', [`experiment ${JSON.stringify(plan.id)} already exists; ExperimentPilot never modifies an existing experiment.`]);
  }
  const metrics = await client.listMetrics(plan.metric.name);
  if (metrics.some((m) => m.name === plan.metric.name)) {
    return refused('exists', [`metric ${JSON.stringify(plan.metric.name)} already exists in this environment; give the plan's metric a new name (nothing was changed).`]);
  }

  const created = [];
  try {
    log(`CREATE 1/3 flag ${plan.flag.key} (enabled, control ${JSON.stringify(featureBody(plan).initial_value)})`);
    const feature = await client.createFeature(featureBody(plan));
    created.push({ what: 'flag', id: feature.id, name: feature.name });

    const optionIds = {};
    for (const variant of plan.flag.variants.filter((v) => v.key !== CONTROL_KEY)) {
      log(`CREATE 1/3 variation ${variant.key} of ${plan.flag.key}`);
      const option = await client.createVariation(feature.id, variationBody(variant, feature.id));
      created.push({ what: 'variation', id: option.id, name: option.key });
      if (option.key !== variant.key) {
        throw new StopApply(`variation came back with key ${JSON.stringify(option.key)}, expected ${JSON.stringify(variant.key)}; a variation without its key records no exposures`);
      }
      optionIds[variant.key] = option.id;
    }

    log(`CREATE 2/3 metric ${JSON.stringify(plan.metric.name)} (event ${JSON.stringify(plan.metric.event)})`);
    const metric = await client.createMetric(metricBody(plan));
    created.push({ what: 'metric', id: metric.id, name: metric.name });
    if (metric.definition?.event !== plan.metric.event) {
      throw new StopApply(`metric created with event ${JSON.stringify(metric.definition?.event)}, expected ${JSON.stringify(plan.metric.event)}`);
    }

    log(`CREATE 3/3 experiment ${plan.id} (not started)`);
    const experiment = await client.createExperiment(experimentBody(plan, { flagId: feature.id, metricId: metric.id, optionIds }));
    created.push({ what: 'experiment', id: experiment.id, name: experiment.name });
    if (experiment.status !== 'created') {
      throw new StopApply(`experiment ${experiment.id} has status ${JSON.stringify(experiment.status)}, expected "created"`);
    }

    log(`DONE: experiment ${experiment.id} created, not started. START needs its own approval after the app is deployed.`);
    return { status: 'applied', phase: 'create', created, experimentId: experiment.id, experimentStatus: experiment.status, ...hashes };
  } catch (err) {
    return failed(err, created, client, log);
  }
}

async function applyStart({ plan, client, log, refused, hashes }) {
  const matches = (await client.listExperiments(plan.id)).filter((e) => e.name === plan.id);
  if (matches.length === 0) return refused('start', [`no experiment named ${JSON.stringify(plan.id)} in this environment; run the CREATE phase first.`]);
  if (matches.length > 1) return refused('start', [`${matches.length} experiments are named ${JSON.stringify(plan.id)}; refusing to guess which one to start.`]);
  const [experiment] = matches;
  if (experiment.status !== 'created') {
    return refused('start', [`experiment ${experiment.id} has status ${JSON.stringify(experiment.status)}, expected "created"; nothing was changed.`]);
  }
  const flagName = experiment.feature?.name;
  if (flagName !== plan.flag.key) {
    return refused('start', [`experiment ${experiment.id} is on flag ${JSON.stringify(flagName)}, not ${JSON.stringify(plan.flag.key)}; nothing was changed.`]);
  }

  try {
    log(`START experiment ${experiment.id} (${plan.id})`);
    await client.startExperiment(experiment.id);
    const check = await client.getExperiment(experiment.id);
    if (check.status !== 'running') throw new StopApply(`experiment ${experiment.id} has status ${JSON.stringify(check.status)} after start, expected "running"`);
    log(`DONE: experiment ${experiment.id} is running.`);
    return { status: 'applied', phase: 'start', created: [], experimentId: experiment.id, experimentStatus: check.status, ...hashes };
  } catch (err) {
    return failed(err, [], client, log);
  }
}

function failed(err, created, client, log) {
  const reason = client.redact ? client.redact(err.message) : err.message;
  const note = `Stopped. Nothing was rolled back or deleted. Created so far: ${created.length ? created.map((c) => `${c.what} ${c.id} (${c.name})`).join(', ') : 'nothing'}. A person decides what to clean up.`;
  log(`FAILED: ${reason}`);
  log(note);
  return { status: 'failed', stage: 'apply', reasons: [reason], created, note };
}
